package main

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Meta describes one measurement run for the report header.
type Meta struct {
	Org          string
	Repos        []string
	From, To     time.Time // [From, To) in UTC
	Generated    time.Time
	APICalls     int
	CacheHits    int
	StartRem     int
	EndRem       int
	MinRemaining int
	Detail       int
	Costs        *CostTable
	RunsListed   map[string]int
	RunsSkipped  int
	RunsFetched  int
	RunsMissing  int
	Partial      bool
	PartialWhy   string
	RepoSelNote  string
	Note         string
}

func mdTable(header []string, rows [][]string) string {
	var b strings.Builder
	b.WriteString("| " + strings.Join(header, " | ") + " |\n")
	b.WriteString("|" + strings.Repeat(" --- |", len(header)) + "\n")
	for _, r := range rows {
		b.WriteString("| " + strings.Join(r, " | ") + " |\n")
	}
	return b.String()
}

func esc(s string) string {
	s = strings.ReplaceAll(s, "|", "\\|")
	return strings.ReplaceAll(s, "\n", " ")
}

func aggRow(name string, a *Agg) []string {
	return []string{
		esc(name), strconv.Itoa(a.Ran), fmt.Sprintf("%.0f", a.Minutes),
		fmtS(a.Q(50)), fmtS(a.Q(90)), fmtS(a.Q(95)), fmtS(a.QMax()),
		fmt.Sprintf("%.0f%%", a.OverPct(60)),
		fmtS(a.D(50)), fmtS(a.D(90)),
		a.costStr(),
	}
}

var aggHeader = []string{"", "jobs", "min", "start p50", "p90", "p95", "max", ">60s", "dur p50", "dur p90", "cost"}

func renderReport(m *Meta, jobs []*JobRec) string {
	var b strings.Builder
	w := func(f string, a ...any) { fmt.Fprintf(&b, f, a...) }

	title := m.Org + "/" + strings.Join(m.Repos, ", ")
	if len(m.Repos) > 6 {
		title = fmt.Sprintf("%s (%d repos)", m.Org, len(m.Repos))
	}
	w("# CI baseline: %s\n\n", title)
	w("- Window: %s to %s (UTC, created_at of the workflow run; %d days)\n",
		m.From.Format("2006-01-02"), m.To.Add(-time.Second).Format("2006-01-02"), int(m.To.Sub(m.From).Hours()/24))
	w("- Generated: %s by `ci-measure` (grun)\n", m.Generated.UTC().Format("2006-01-02 15:04 MST"))
	if m.RepoSelNote != "" {
		w("- Repos: %s\n", m.RepoSelNote)
	}
	if m.Note != "" {
		w("- Note: %s\n", m.Note)
	}
	w("- GitHub API: %d live calls, %d served from the disk cache; X-RateLimit-Remaining %d -> %d (floor %d)\n",
		m.APICalls, m.CacheHits, m.StartRem, m.EndRem, m.MinRemaining)
	tot := 0
	for _, n := range m.RunsListed {
		tot += n
	}
	w("- Completed runs in window: %d (%d skipped runs not fetched; jobs fetched for %d runs)\n", tot, m.RunsSkipped, m.RunsFetched)
	if m.Partial {
		missing := strconv.Itoa(m.RunsMissing)
		if m.RunsMissing < 0 {
			missing = "an unknown number of"
		}
		w("\n> **PARTIAL RESULT.** %s\n> Jobs were fetched for %d runs; %s runs are missing. All numbers below undercount.\n",
			m.PartialWhy, m.RunsFetched, missing)
	}
	w("\nConventions: **start** = job `started_at` - `created_at` (queue plus runner provisioning); **dur** = `completed_at` - `started_at`; " +
		"**min** = runner-minutes (sum of dur); percentiles are nearest-rank; only jobs that got a runner are counted (never-started and skipped jobs are listed separately). " +
		"A job with several attempts counts once per attempt.\n\n")

	// Overview.
	all := newAgg()
	for _, j := range jobs {
		all.add(j)
	}
	all.finish()
	w("## Overview\n\n")
	w("%s\n", mdTable(
		[]string{"job attempts", "ran", "never started / skipped", "failed", "cancelled", "runner-min", "minutes in failed+cancelled", "cost"},
		[][]string{{strconv.Itoa(all.Total), strconv.Itoa(all.Ran), strconv.Itoa(all.NotRun), strconv.Itoa(all.Failed), strconv.Itoa(all.Cancelled),
			fmt.Sprintf("%.0f", all.Minutes), fmt.Sprintf("%.0f", all.WastedMin), all.costStr()}}))
	if all.HostedMin > 0 {
		w("GitHub-hosted: %d jobs, %.0f minutes (not costed; hosted minutes are excluded from the cost column).\n\n", all.Hosted, all.HostedMin)
	}

	// By class (ARC vs hosted vs ...).
	byClass, ckeys0 := groupJobs(jobs, func(j *JobRec) string {
		if !j.Ran {
			return "-"
		}
		return j.Cost.Class
	})
	w("## By runner class (all repos)\n\n")
	var crows [][]string
	for _, k := range ckeys0 {
		crows = append(crows, aggRow(k, byClass[k]))
	}
	w("%s\n", mdTable(append([]string{"class"}, aggHeader[1:]...), crows))

	// By label (all repos).
	byLabel, lkeys := groupJobs(jobs, func(j *JobRec) string { return j.LabelKey })
	w("## By runner label (all repos)\n\n")
	w("%s\n", labelTable(byLabel, lkeys, m.Costs))

	// By repo.
	byRepo, rkeys := groupJobs(jobs, func(j *JobRec) string { return j.Repo })
	if len(rkeys) > 1 {
		w("## By repo\n\n")
		var rows [][]string
		for _, k := range rkeys {
			rows = append(rows, aggRow(k, byRepo[k]))
		}
		w("%s\n", mdTable(append([]string{"repo"}, aggHeader[1:]...), rows))
	}

	// Detail sections.
	n := m.Detail
	if n <= 0 || n > len(rkeys) {
		n = len(rkeys)
	}
	for _, repo := range rkeys[:n] {
		var rj []*JobRec
		for _, j := range jobs {
			if j.Repo == repo {
				rj = append(rj, j)
			}
		}
		renderRepo(&b, m, repo, rj)
	}

	// Caveats.
	w("## Caveats\n\n")
	w("%s", caveats)
	return b.String()
}

func labelTable(by map[string]*Agg, keys []string, costs *CostTable) string {
	var rows [][]string
	for _, k := range keys {
		a := by[k]
		row := aggRow(k, a)
		row = append(row, classNote(a))
		rows = append(rows, row)
	}
	return mdTable(append([]string{"label"}, append(aggHeader[1:], "class")...), rows)
}

func classNote(a *Agg) string {
	var parts []string
	for _, c := range []string{ClassARC, ClassFargate, ClassHosted, ClassUnpriced} {
		if n := a.classCount[c]; n > 0 {
			parts = append(parts, c)
		}
	}
	return strings.Join(parts, "+")
}

func renderRepo(b *strings.Builder, m *Meta, repo string, jobs []*JobRec) {
	w := func(f string, a ...any) { fmt.Fprintf(b, f, a...) }
	all := newAgg()
	for _, j := range jobs {
		all.add(j)
	}
	all.finish()
	w("## %s/%s\n\n", m.Org, repo)
	w("%s\n", mdTable(append([]string{"repo"}, aggHeader[1:]...), [][]string{aggRow(repo, all)}))
	w("%d job attempts, %d ran, %d never started or skipped, %d failed, %d cancelled; %.0f of %.0f runner-minutes were in failed or cancelled jobs.\n\n",
		all.Total, all.Ran, all.NotRun, all.Failed, all.Cancelled, all.WastedMin, all.Minutes)

	byLabel, lkeys := groupJobs(jobs, func(j *JobRec) string { return j.LabelKey })
	w("### %s: by label\n\n%s\n", repo, labelTable(byLabel, lkeys, m.Costs))

	// By workflow / job.
	byJob, jkeys := groupJobs(jobs, func(j *JobRec) string { return j.Workflow + " / " + j.Name + " [" + j.LabelKey + "]" })
	w("### %s: by workflow job (top 20 by minutes)\n\n", repo)
	var rows [][]string
	for i, k := range jkeys {
		if i >= 20 {
			break
		}
		rows = append(rows, aggRow(k, byJob[k]))
	}
	w("%s\n", mdTable(append([]string{"workflow / job [label]"}, aggHeader[1:]...), rows))

	// Longest start latencies: usually incidents, not steady state.
	var ran []*JobRec
	for _, j := range jobs {
		if j.Ran && !isHosted(j) {
			ran = append(ran, j)
		}
	}
	sort.Slice(ran, func(i, k int) bool { return ran[i].QueueS > ran[k].QueueS })
	w("### %s: longest start latencies on self-hosted labels\n\n", repo)
	rows = nil
	for i, j := range ran {
		if i >= 8 {
			break
		}
		rows = append(rows, []string{fmtS(j.QueueS), j.Created.UTC().Format("2006-01-02 15:04"), esc(j.LabelKey), esc(j.Workflow + " / " + j.Name), esc(j.Runner)})
	}
	w("%s\n", mdTable([]string{"start", "job created (UTC)", "label", "job", "runner"}, rows))

	// Step categories, per job.
	cats, ckeys := stepsByCategory(jobs)
	w("### %s: step breakdown by category (time per job, jobs that have the category)\n\n", repo)
	rows = nil
	for _, k := range ckeys {
		a := cats[k]
		share := 0.0
		if all.Minutes > 0 {
			share = 100 * a.Minutes / all.Minutes
		}
		rows = append(rows, []string{esc(k), strconv.Itoa(a.N), fmtS(a.P(50)), fmtS(a.P(90)), fmt.Sprintf("%.0f", a.Minutes), fmt.Sprintf("%.0f%%", share)})
	}
	w("%s\n", mdTable([]string{"category", "jobs", "p50", "p90", "total min", "% of runner-min"}, rows))
	w("Categories: `job-setup` is GitHub's \"Set up job\" step (runner and pod preparation), `checkout`, `setup-devbox`, `cache` (restore, save and post steps), `recipe:<name>` (the ci-actions recipe step; name from the job), `remote-builders`, `aws-login`, `other`.\n\n")

	// Steps by name.
	names, nkeys := stepsByName(jobs)
	w("### %s: slowest steps by total time (pins stripped)\n\n", repo)
	rows = nil
	for i, k := range nkeys {
		if i >= 15 {
			break
		}
		a := names[k]
		rows = append(rows, []string{esc(k), strconv.Itoa(a.N), fmtS(a.P(50)), fmtS(a.P(90)), fmtS(a.Durs[len(a.Durs)-1]), fmt.Sprintf("%.0f", a.Minutes)})
	}
	w("%s\n", mdTable([]string{"step", "n", "p50", "p90", "max", "total min"}, rows))

	byP50 := make([]string, 0, len(nkeys))
	for _, k := range nkeys {
		if names[k].N >= 10 {
			byP50 = append(byP50, k)
		}
	}
	sort.Slice(byP50, func(i, j int) bool { return names[byP50[i]].P(50) > names[byP50[j]].P(50) })
	w("### %s: slowest steps by p50 (n >= 10)\n\n", repo)
	rows = nil
	for i, k := range byP50 {
		if i >= 10 {
			break
		}
		a := names[k]
		rows = append(rows, []string{esc(k), strconv.Itoa(a.N), fmtS(a.P(50)), fmtS(a.P(90)), fmtS(a.Durs[len(a.Durs)-1]), fmt.Sprintf("%.0f", a.Minutes)})
	}
	w("%s\n", mdTable([]string{"step", "n", "p50", "p90", "max", "total min"}, rows))
}

const caveats = `- **Start latency is queueing plus provisioning, and the two cannot be told apart from the REST API.** ` +
	"`started_at` - `created_at` includes the wait for a free runner or concurrency slot, the ARC listener/scale-set reaction, Karpenter node boot and image pull, runner registration, and GitHub's own dispatch delay. " +
	"On GitHub-hosted runners it includes hosted-pool contention. The per-job ARC listener metrics (`gha_*` in VictoriaMetrics) are needed to split these.\n" +
	"- A job's `created_at` is when GitHub created the job record. For jobs behind `needs:` it is not the run creation time, so this is a per-job queue, not the end-to-end wait of a PR check.\n" +
	"- Step timestamps have one-second resolution; short steps (checkout, cache restore) are rounded. Steps inside composite actions are not visible as separate steps.\n" +
	"- Step names are opaque for ci-actions (\"Run truvity/ci-actions/recipe\"); the recipe name is taken from the job name (\"recipes / test\" -> recipe `test`). Integration jobs run their work in named steps (`Build (app)`, `Suite (app)`), which fall in `other` and appear in the step tables by name.\n" +
	"- **Cost** is an estimate: self-hosted (arc) runner-minutes x an assumed effective per-minute cost range (spot to on-demand) that folds in idle nodes and cluster overhead, so a per-repo figure is an allocation, not a measurement. The label table and rates are examples; override them with `-costs`. " +
	"GitHub-hosted jobs are marked hosted and not costed. Fargate prices (for fg-* labels) are per-second with a 60 s minimum; no job in this window ran on Fargate unless the label table says so.\n" +
	"- Runner-minutes are exact seconds / 60, not GitHub's per-job rounded-up billing minutes.\n" +
	"- Re-run attempts are included (filter=all). Runs still in progress when the data was fetched are not (status=completed). The window selects runs by creation time, so a run created just before the window end may be missing its late jobs only if it was incomplete at fetch time.\n" +
	"- Jobs cancelled before getting a runner have no runner name and are reported as \"never started\"; their wait is not in the latency statistics, which biases start latency downward when the queue is long.\n"

// ---- CSV ----

func jobsCSV(jobs []*JobRec) ([]byte, error) {
	var buf bytes.Buffer
	cw := csv.NewWriter(&buf)
	_ = cw.Write([]string{"repo", "run_id", "run_attempt", "workflow", "event", "branch", "job_id", "job_name", "labels", "runner_name", "runner_group",
		"conclusion", "created_at", "started_at", "completed_at", "ran", "start_latency_s", "duration_s", "cost_class", "cost_min_usd", "cost_max_usd"})
	for _, j := range jobs {
		_ = cw.Write([]string{
			j.Repo, i64(j.RunID), strconv.Itoa(j.Attempt), j.Workflow, j.Event, j.Branch, i64(j.JobID), j.Name, j.LabelKey, j.Runner, j.Group,
			j.Conclusion, ts(j.Created), ts(j.Started), ts(j.Completed), strconv.FormatBool(j.Ran), f1(j.QueueS, j.Ran), f1(j.DurS, j.Ran),
			j.Cost.Class, f6(j.Cost.Min, j.Ran), f6(j.Cost.Max, j.Ran),
		})
	}
	cw.Flush()
	return buf.Bytes(), cw.Error()
}

func stepsCSV(jobs []*JobRec) ([]byte, error) {
	var buf bytes.Buffer
	cw := csv.NewWriter(&buf)
	_ = cw.Write([]string{"repo", "run_id", "run_attempt", "job_id", "workflow", "job_name", "labels", "step_number", "step_name", "step_norm", "category",
		"conclusion", "started_at", "completed_at", "duration_s"})
	for _, j := range jobs {
		for _, s := range j.Steps {
			_ = cw.Write([]string{
				j.Repo, i64(j.RunID), strconv.Itoa(j.Attempt), i64(j.JobID), j.Workflow, j.Name, j.LabelKey, strconv.Itoa(s.Number), s.Name, s.Norm, s.Category,
				s.Conclusion, ts(s.Started), ts(s.Completed), f1(s.DurS, s.Timed),
			})
		}
	}
	cw.Flush()
	return buf.Bytes(), cw.Error()
}

func i64(n int64) string { return strconv.FormatInt(n, 10) }
func ts(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
func f1(v float64, ok bool) string {
	if !ok {
		return ""
	}
	return strconv.FormatFloat(v, 'f', 1, 64)
}
func f6(v float64, ok bool) string {
	if !ok {
		return ""
	}
	return strconv.FormatFloat(v, 'f', 6, 64)
}

func isHosted(j *JobRec) bool { return j.Cost.Class == ClassHosted }
