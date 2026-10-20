package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ErrBudget is returned when the shared GitHub API budget falls below the
// configured floor (or a rate limit response is received). Callers stop and
// report what they have.
var ErrBudget = errors.New("GitHub API budget reached")

const apiBase = "https://api.github.com"

// Client is a read-only GitHub REST client with an on-disk response cache and
// rate-limit accounting. Only GET is implemented.
type Client struct {
	token        string
	http         *http.Client
	cacheDir     string
	minRemaining int

	mu        sync.Mutex
	calls     int // live HTTP requests that count against the quota
	cacheHits int
	remaining int // last seen X-RateLimit-Remaining, -1 if unknown
	limit     int
	resetAt   time.Time
	startRem  int // remaining when we started, -1 if unknown
}

func newClient(cacheDir string, minRemaining int) (*Client, error) {
	tok := strings.TrimSpace(os.Getenv("GITHUB_TOKEN"))
	if tok == "" {
		out, err := exec.Command("gh", "auth", "token").Output()
		if err != nil {
			return nil, fmt.Errorf("no GITHUB_TOKEN and `gh auth token` failed: %w", err)
		}
		tok = strings.TrimSpace(string(out))
	}
	if tok == "" {
		return nil, errors.New("empty GitHub token")
	}
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return nil, err
	}
	return &Client{
		token:        tok,
		http:         &http.Client{Timeout: 60 * time.Second},
		cacheDir:     cacheDir,
		minRemaining: minRemaining,
		remaining:    -1,
		startRem:     -1,
	}, nil
}

// Init reads /rate_limit (which does not count against the quota) so the budget
// is known before the first real call.
func (c *Client) Init(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, apiBase+"/rate_limit", nil)
	c.sign(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("rate_limit: HTTP %d", resp.StatusCode)
	}
	c.observe(resp.Header)
	c.mu.Lock()
	c.startRem = c.remaining
	c.mu.Unlock()
	return nil
}

func (c *Client) sign(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "grun-ci-measure")
}

func (c *Client) observe(h http.Header) {
	rem, err := strconv.Atoi(h.Get("X-RateLimit-Remaining"))
	if err != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.remaining < 0 || rem < c.remaining {
		c.remaining = rem
	}
	if l, err := strconv.Atoi(h.Get("X-RateLimit-Limit")); err == nil {
		c.limit = l
	}
	if r, err := strconv.ParseInt(h.Get("X-RateLimit-Reset"), 10, 64); err == nil {
		c.resetAt = time.Unix(r, 0)
	}
}

// Stats returns (live calls, cache hits, remaining, remaining at start).
func (c *Client) Stats() (calls, hits, remaining, start int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls, c.cacheHits, c.remaining, c.startRem
}

func (c *Client) Remaining() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.remaining
}

func (c *Client) cachePath(key string) string {
	sum := sha256.Sum256([]byte(key))
	h := hex.EncodeToString(sum[:])
	return filepath.Join(c.cacheDir, h[:2], h+".json")
}

// Get fetches path (with query) and returns the body. A cached body younger
// than ttl is returned without an API call; ttl <= 0 means the cache never
// expires.
func (c *Client) Get(ctx context.Context, path string, q url.Values, ttl time.Duration) ([]byte, error) {
	full := apiBase + path
	if len(q) > 0 {
		full += "?" + q.Encode() // Encode sorts keys, so the cache key is stable
	}
	cp := c.cachePath(full)
	if st, err := os.Stat(cp); err == nil && (ttl <= 0 || time.Since(st.ModTime()) < ttl) {
		if b, err := os.ReadFile(cp); err == nil {
			c.mu.Lock()
			c.cacheHits++
			c.mu.Unlock()
			return b, nil
		}
	}

	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if rem := c.Remaining(); rem >= 0 && rem < c.minRemaining {
			return nil, fmt.Errorf("%w: X-RateLimit-Remaining=%d is below the floor of %d", ErrBudget, rem, c.minRemaining)
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, full, nil)
		c.sign(req)
		c.mu.Lock()
		c.calls++
		c.mu.Unlock()
		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = err
			time.Sleep(time.Duration(attempt+1) * 2 * time.Second)
			continue
		}
		body, rerr := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		c.observe(resp.Header)
		switch {
		case resp.StatusCode == 200 && rerr == nil:
			if err := writeAtomic(cp, body); err != nil {
				return nil, err
			}
			return body, nil
		case resp.StatusCode == 403 || resp.StatusCode == 429:
			return nil, fmt.Errorf("%w: HTTP %d on %s: %s", ErrBudget, resp.StatusCode, path, truncate(string(body), 200))
		case resp.StatusCode >= 500:
			lastErr = fmt.Errorf("HTTP %d on %s", resp.StatusCode, path)
			time.Sleep(time.Duration(attempt+1) * 2 * time.Second)
		default:
			return nil, fmt.Errorf("HTTP %d on %s: %s", resp.StatusCode, path, truncate(string(body), 200))
		}
	}
	return nil, lastErr
}

func writeAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}
