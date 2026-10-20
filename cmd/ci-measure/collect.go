package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"sync"
	"time"
)

const timeFmt = "2006-01-02T15:04:05Z"

// recentTTL is how long a cached response is trusted when it covers the last
// two days (runs may still complete, be re-run, or gain attempts). Anything
// older is cached forever.
const recentTTL = time.Hour

func ttlFor(t time.Time) time.Duration {
	if time.Since(t) < 48*time.Hour {
		return recentTTL
	}
	return 0
}

type apiRun struct {
	ID         int64     `json:"id"`
	Name       string    `json:"name"`
	Event      string    `json:"event"`
	HeadBranch string    `json:"head_branch"`
	Conclusion string    `json:"conclusion"`
	RunAttempt int       `json:"run_attempt"`
	CreatedAt  time.Time `json:"created_at"`
}

type apiStep struct {
	Name        string    `json:"name"`
	Number      int       `json:"number"`
	Conclusion  string    `json:"conclusion"`
	StartedAt   time.Time `json:"started_at"`
	CompletedAt time.Time `json:"completed_at"`
}

type apiJob struct {
	ID              int64     `json:"id"`
	RunID           int64     `json:"run_id"`
	RunAttempt      int       `json:"run_attempt"`
	WorkflowName    string    `json:"workflow_name"`
	HeadBranch      string    `json:"head_branch"`
	Name            string    `json:"name"`
	Status          string    `json:"status"`
	Conclusion      string    `json:"conclusion"`
	CreatedAt       time.Time `json:"created_at"`
	StartedAt       time.Time `json:"started_at"`
	CompletedAt     time.Time `json:"completed_at"`
	Labels          []string  `json:"labels"`
	RunnerName      string    `json:"runner_name"`
	RunnerGroupName string    `json:"runner_group_name"`
	Steps           []apiStep `json:"steps"`
}

// Run is a workflow run plus the repo it belongs to.
type Run struct {
	Repo string
	apiRun
}

// Collector turns (org, repo, window) into JobRecs.
type Collector struct {
	c   *Client
	org string
}

// listRepos returns the non-archived repos of the org with the given type
// (private, public, all).
func (co *Collector) listRepos(ctx context.Context, visibility string) ([]string, error) {
	var names []string
	for page := 1; ; page++ {
		q := url.Values{"type": {visibility}, "per_page": {"100"}, "page": {strconv.Itoa(page)}}
		b, err := co.c.Get(ctx, "/orgs/"+co.org+"/repos", q, recentTTL)
		if err != nil {
			return nil, err
		}
		var rs []struct {
			Name     string `json:"name"`
			Archived bool   `json:"archived"`
		}
		if err := json.Unmarshal(b, &rs); err != nil {
			return nil, err
		}
		for _, r := range rs {
			if !r.Archived {
				names = append(names, r.Name)
			}
		}
		if len(rs) < 100 {
			break
		}
	}
	sort.Strings(names)
	return names, nil
}

func createdRange(from, to time.Time) string {
	// [from, to) expressed as an inclusive range.
	return from.UTC().Format(timeFmt) + ".." + to.Add(-time.Second).UTC().Format(timeFmt)
}

// probeRuns returns the number of completed runs in [from, to) with one call.
func (co *Collector) probeRuns(ctx context.Context, repo string, from, to time.Time) (int, error) {
	q := url.Values{"created": {createdRange(from, to)}, "status": {"completed"}, "per_page": {"1"}}
	b, err := co.c.Get(ctx, "/repos/"+co.org+"/"+repo+"/actions/runs", q, ttlFor(to))
	if err != nil {
		return 0, err
	}
	var r struct {
		TotalCount int `json:"total_count"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return 0, err
	}
	return r.TotalCount, nil
}

// listRuns returns all completed runs created in [from, to). The API caps a
// filtered listing at 1000 results, so a window that reports more is bisected.
func (co *Collector) listRuns(ctx context.Context, repo string, from, to time.Time) ([]apiRun, error) {
	ttl := ttlFor(to)
	var all []apiRun
	total := -1
	for page := 1; ; page++ {
		q := url.Values{
			"created": {createdRange(from, to)}, "status": {"completed"},
			"per_page": {"100"}, "page": {strconv.Itoa(page)},
		}
		b, err := co.c.Get(ctx, "/repos/"+co.org+"/"+repo+"/actions/runs", q, ttl)
		if err != nil {
			return all, err
		}
		var r struct {
			TotalCount int      `json:"total_count"`
			Runs       []apiRun `json:"workflow_runs"`
		}
		if err := json.Unmarshal(b, &r); err != nil {
			return all, err
		}
		if page == 1 {
			total = r.TotalCount
			if total > 1000 && to.Sub(from) > 2*time.Hour {
				mid := from.Add(to.Sub(from) / 2).Truncate(time.Hour)
				a, err := co.listRuns(ctx, repo, from, mid)
				if err != nil {
					return a, err
				}
				b2, err := co.listRuns(ctx, repo, mid, to)
				return append(a, b2...), err
			}
		}
		all = append(all, r.Runs...)
		if len(r.Runs) < 100 || len(all) >= total {
			break
		}
	}
	if total > 1000 {
		fmt.Printf("warning: %s has %d runs in a window that cannot be split further; only the first 1000 are available\n", repo, total)
	}
	return all, nil
}

// jobsForRun returns all jobs of all attempts of a run.
func (co *Collector) jobsForRun(ctx context.Context, repo string, run apiRun) ([]apiJob, error) {
	ttl := ttlFor(run.CreatedAt)
	var all []apiJob
	for page := 1; ; page++ {
		q := url.Values{"filter": {"all"}, "per_page": {"100"}, "page": {strconv.Itoa(page)}}
		b, err := co.c.Get(ctx, "/repos/"+co.org+"/"+repo+"/actions/runs/"+strconv.FormatInt(run.ID, 10)+"/jobs", q, ttl)
		if err != nil {
			return all, err
		}
		var r struct {
			TotalCount int      `json:"total_count"`
			Jobs       []apiJob `json:"jobs"`
		}
		if err := json.Unmarshal(b, &r); err != nil {
			return all, err
		}
		all = append(all, r.Jobs...)
		if len(r.Jobs) < 100 || len(all) >= r.TotalCount {
			break
		}
	}
	return all, nil
}

// Collection is everything gathered for one measurement.
type Collection struct {
	Jobs          []*JobRec
	RunsListed    map[string]int // repo -> completed runs in window
	RunsSkipped   int            // runs not fetched because they were skipped
	RunsFetched   int            // runs whose jobs were fetched
	RunsMissing   int            // runs whose jobs were not fetched (budget stop)
	Partial       bool
	PartialReason string
}

// Collect lists runs for the repos and fetches the jobs of each non-skipped
// run with a small worker pool. On ErrBudget it stops and returns what it has.
func (co *Collector) Collect(ctx context.Context, repos []string, from, to time.Time, workers int, costs *CostTable) (*Collection, error) {
	col := &Collection{RunsListed: map[string]int{}}
	var runs []Run
	for _, repo := range repos {
		rs, err := co.listRuns(ctx, repo, from, to)
		seen := map[int64]bool{}
		for _, r := range rs {
			if seen[r.ID] {
				continue
			}
			seen[r.ID] = true
			col.RunsListed[repo]++
			runs = append(runs, Run{Repo: repo, apiRun: r})
		}
		if err != nil {
			if isBudget(err) {
				col.Partial, col.PartialReason = true, "stopped while listing runs for "+repo+": "+err.Error()
				col.RunsMissing = -1 // unknown: listing incomplete
				return col, nil
			}
			return col, err
		}
		fmt.Printf("  %s: %d completed runs listed (%d API calls so far)\n", repo, col.RunsListed[repo], liveCalls(co.c))
	}

	var todo []Run
	for _, r := range runs {
		if r.Conclusion == "skipped" {
			col.RunsSkipped++
			continue
		}
		todo = append(todo, r)
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	ch := make(chan Run)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	done := 0
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for r := range ch {
				jobs, err := co.jobsForRun(ctx, r.Repo, r.apiRun)
				mu.Lock()
				if err != nil {
					if isBudget(err) {
						if !col.Partial {
							col.Partial, col.PartialReason = true, err.Error()
						}
					} else if firstErr == nil && ctx.Err() == nil {
						firstErr = err
					}
					cancel()
					mu.Unlock()
					continue
				}
				done++
				for i := range jobs {
					col.Jobs = append(col.Jobs, newJobRec(r, &jobs[i], costs))
				}
				if done%200 == 0 {
					fmt.Printf("  jobs fetched for %d/%d runs (%d API calls, remaining %d)\n", done, len(todo), liveCalls(co.c), co.c.Remaining())
				}
				mu.Unlock()
			}
		}()
	}
feed:
	for _, r := range todo {
		select {
		case ch <- r:
		case <-ctx.Done():
			break feed
		}
	}
	close(ch)
	wg.Wait()
	col.RunsFetched = done
	col.RunsMissing = len(todo) - done
	if firstErr != nil {
		return col, firstErr
	}
	sort.Slice(col.Jobs, func(i, j int) bool {
		a, b := col.Jobs[i], col.Jobs[j]
		if a.Repo != b.Repo {
			return a.Repo < b.Repo
		}
		if !a.Created.Equal(b.Created) {
			return a.Created.Before(b.Created)
		}
		return a.JobID < b.JobID
	})
	return col, nil
}

func isBudget(err error) bool { return errors.Is(err, ErrBudget) }

func liveCalls(c *Client) int { n, _, _, _ := c.Stats(); return n }
