// Command ci-measure measures GitHub Actions runner behaviour (start latency,
// duration, minutes, step breakdown, cost) from the GitHub REST API.
//
// It is read-only on GitHub and caches every response on disk, so re-runs do
// not spend API quota.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sort"
	"strings"
	"time"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "ci-measure:", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		org          = flag.String("org", "truvity", "GitHub organisation")
		repos        = flag.String("repos", "", `comma-separated repo names, or "all" (every non-archived repo of -visibility)`)
		visibility   = flag.String("visibility", "private", `with -repos all: private, public or all`)
		days         = flag.Int("days", 28, "window length in UTC days ending today (inclusive)")
		fromS        = flag.String("from", "", "window start date YYYY-MM-DD (overrides -days)")
		toS          = flag.String("to", "", "window end date YYYY-MM-DD, inclusive (default today)")
		out          = flag.String("out", "", "output destination: directory, file:// path (s3:// reserved)")
		cacheDir     = flag.String("cache", ".cache/gh", "on-disk cache for raw API responses")
		minRem       = flag.Int("min-remaining", 1000, "stop when X-RateLimit-Remaining drops below this")
		top          = flag.Int("top", 0, "with several repos: keep only the N repos with the most runs (0 = all)")
		detail       = flag.Int("detail", 5, "per-repo detail sections in report.md (by minutes)")
		costsPath    = flag.String("costs", "", "JSON file overriding the label cost table (see cost.go)")
		workers      = flag.Int("workers", 6, "parallel job fetches")
		exclude      = flag.String("exclude", "", "comma-separated repos to drop from the selection")
		note         = flag.String("note", "", "free-text line added to the report header")
		dryRun       = flag.Bool("dry-run", false, "list repos, probe run counts, print the estimated API calls, then exit")
		maxEstimated = flag.Int("max-calls", 0, "abort before fetching if the estimate exceeds this many calls (0 = use remaining quota minus the floor)")
	)
	flag.Parse()
	if *repos == "" {
		return fmt.Errorf("-repos is required (names or \"all\")")
	}
	if *out == "" && !*dryRun {
		return fmt.Errorf("-out is required")
	}

	today := time.Now().UTC().Truncate(24 * time.Hour)
	to := today.Add(24 * time.Hour)
	if *toS != "" {
		t, err := time.Parse("2006-01-02", *toS)
		if err != nil {
			return err
		}
		to = t.Add(24 * time.Hour)
	}
	from := to.Add(-time.Duration(*days) * 24 * time.Hour)
	if *fromS != "" {
		t, err := time.Parse("2006-01-02", *fromS)
		if err != nil {
			return err
		}
		from = t
	}
	if !from.Before(to) {
		return fmt.Errorf("empty window %s .. %s", from, to)
	}

	costs, err := loadCosts(*costsPath)
	if err != nil {
		return err
	}
	var w Writer
	if !*dryRun {
		if w, err = newWriter(*out); err != nil {
			return err
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	c, err := newClient(*cacheDir, *minRem)
	if err != nil {
		return err
	}
	if err := c.Init(ctx); err != nil {
		return err
	}
	_, _, rem, _ := c.Stats()
	fmt.Printf("window %s .. %s UTC; rate limit remaining %d (floor %d)\n", from.Format("2006-01-02"), to.Add(-time.Second).Format("2006-01-02"), rem, *minRem)
	co := &Collector{c: c, org: *org}

	// Resolve repos.
	var names []string
	selNote := ""
	if *repos == "all" {
		names, err = co.listRepos(ctx, *visibility)
		if err != nil {
			return err
		}
		fmt.Printf("%d %s non-archived repos in %s\n", len(names), *visibility, *org)
		selNote = fmt.Sprintf("all %d non-archived %s repos of %s", len(names), *visibility, *org)
	} else {
		for _, n := range strings.Split(*repos, ",") {
			if n = strings.TrimSpace(n); n != "" {
				names = append(names, n)
			}
		}
	}

	if *exclude != "" {
		drop := map[string]bool{}
		for _, n := range strings.Split(*exclude, ",") {
			drop[strings.TrimSpace(n)] = true
		}
		kept := names[:0]
		for _, n := range names {
			if !drop[n] {
				kept = append(kept, n)
			}
		}
		names = kept
		selNote = ""
	}

	// Probe run counts when there are several repos, to skip empty ones and
	// to estimate the cost of the whole fetch before spending it.
	if len(names) > 1 {
		type rc struct {
			repo string
			n    int
		}
		var counts []rc
		for _, n := range names {
			k, err := co.probeRuns(ctx, n, from, to)
			if err != nil {
				return fmt.Errorf("probing %s: %w", n, err)
			}
			if k > 0 {
				counts = append(counts, rc{n, k})
			}
		}
		sort.Slice(counts, func(i, j int) bool { return counts[i].n > counts[j].n })
		totalRuns, totalCalls := 0, 0
		for _, x := range counts {
			totalRuns += x.n
			totalCalls += x.n + (x.n+99)/100
		}
		fmt.Printf("repos with runs: %d of %d; total completed runs %d; estimated calls to fetch all: ~%d (minus cache hits)\n", len(counts), len(names), totalRuns, totalCalls)
		for i, x := range counts {
			if i < 15 {
				fmt.Printf("  %-40s %d runs\n", x.repo, x.n)
			}
		}
		if *top > 0 && len(counts) > *top {
			counts = counts[:*top]
			sel := make([]string, len(counts))
			totalCalls = 0
			for i, x := range counts {
				sel[i] = x.repo
				totalCalls += x.n + (x.n+99)/100
			}
			selNote = fmt.Sprintf("top %d repos by run count (%s)", *top, strings.Join(sel, ", "))
			fmt.Printf("keeping top %d repos; estimate now ~%d calls\n", *top, totalCalls)
		}
		names = names[:0]
		for _, x := range counts {
			names = append(names, x.repo)
		}
		if selNote == "" || *repos == "all" && *top == 0 {
			selNote = strings.Join(names, ", ")
			if *repos == "all" {
				selNote = fmt.Sprintf("%d private repos with runs in the window (of the non-archived ones): %s", len(names), selNote)
			}
		}
		limit := *maxEstimated
		if limit == 0 {
			limit = c.Remaining() - *minRem
		}
		if totalCalls > limit && !*dryRun {
			return fmt.Errorf("estimated ~%d API calls exceeds the allowance of %d; use -top N or -days, or raise -max-calls", totalCalls, limit)
		}
		if *dryRun {
			calls, hits, rem, start := c.Stats()
			fmt.Printf("dry run: %d API calls used, %d cache hits, remaining %d (start %d)\n", calls, hits, rem, start)
			return nil
		}
	}
	if *dryRun {
		return fmt.Errorf("-dry-run needs several repos")
	}
	sort.Strings(names)

	fmt.Printf("collecting %d repo(s): %s\n", len(names), strings.Join(names, ", "))
	col, err := co.Collect(ctx, names, from, to, *workers, costs)
	if err != nil {
		return err
	}

	calls, hits, remNow, start := c.Stats()
	m := &Meta{
		Org: *org, Repos: names, From: from, To: to, Generated: time.Now(),
		APICalls: calls, CacheHits: hits, StartRem: start, EndRem: remNow, MinRemaining: *minRem,
		Detail: *detail, Costs: costs, RunsListed: col.RunsListed, RunsSkipped: col.RunsSkipped,
		RunsFetched: col.RunsFetched, RunsMissing: col.RunsMissing, Partial: col.Partial, PartialWhy: col.PartialReason,
		RepoSelNote: selNote, Note: *note,
	}
	if m.RepoSelNote == "" {
		m.RepoSelNote = strings.Join(names, ", ")
	}
	report := renderReport(m, col.Jobs)
	jc, err := jobsCSV(col.Jobs)
	if err != nil {
		return err
	}
	sc, err := stepsCSV(col.Jobs)
	if err != nil {
		return err
	}
	for name, data := range map[string][]byte{"report.md": []byte(report), "jobs.csv": jc, "steps.csv": sc} {
		if err := w.Put(name, data); err != nil {
			return err
		}
	}
	fmt.Printf("wrote report.md, jobs.csv (%d jobs), steps.csv to %s\n", len(col.Jobs), w.Location())
	fmt.Printf("API calls used: %d live (%d cache hits); X-RateLimit-Remaining %d -> %d\n", calls, hits, start, remNow)
	if col.Partial {
		fmt.Printf("PARTIAL: %s\n", col.PartialReason)
		os.Exit(3)
	}
	return nil
}
