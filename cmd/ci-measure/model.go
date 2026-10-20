package main

import (
	"regexp"
	"sort"
	"strings"
	"time"
)

// StepRec is one step of a job.
type StepRec struct {
	Number     int
	Name       string // as reported by GitHub
	Norm       string // name with action pins (@sha / @vN) removed
	Category   string
	Conclusion string
	Started    time.Time
	Completed  time.Time
	DurS       float64
	Timed      bool // both timestamps present and ordered
}

// JobRec is one job attempt with derived timing and cost.
type JobRec struct {
	Repo       string
	RunID      int64
	Attempt    int
	Workflow   string
	Event      string
	Branch     string
	JobID      int64
	Name       string
	Labels     []string
	LabelKey   string // labels joined with ","; "(none)" if empty
	Runner     string
	Group      string
	Conclusion string
	Created    time.Time
	Started    time.Time
	Completed  time.Time

	Ran    bool // got a runner and executed
	QueueS float64
	DurS   float64
	Cost   Cost
	Steps  []StepRec
}

func newJobRec(r Run, j *apiJob, costs *CostTable) *JobRec {
	labels := append([]string(nil), j.Labels...)
	sort.Strings(labels)
	key := strings.Join(labels, ",")
	if key == "" {
		key = "(none)"
	}
	jr := &JobRec{
		Repo: r.Repo, RunID: j.RunID, Attempt: j.RunAttempt, Workflow: j.WorkflowName,
		Event: r.Event, Branch: j.HeadBranch, JobID: j.ID, Name: j.Name,
		Labels: labels, LabelKey: key, Runner: j.RunnerName, Group: j.RunnerGroupName,
		Conclusion: j.Conclusion, Created: j.CreatedAt, Started: j.StartedAt, Completed: j.CompletedAt,
	}
	if jr.Workflow == "" {
		jr.Workflow = r.Name
	}
	jr.Ran = j.RunnerName != "" && !j.StartedAt.IsZero() && !j.CompletedAt.IsZero() &&
		!j.CompletedAt.Before(j.StartedAt) && j.Conclusion != "skipped"
	if jr.Ran {
		jr.DurS = j.CompletedAt.Sub(j.StartedAt).Seconds()
		if !j.CreatedAt.IsZero() {
			jr.QueueS = j.StartedAt.Sub(j.CreatedAt).Seconds()
			if jr.QueueS < 0 {
				jr.QueueS = 0
			}
		}
		jr.Cost = costs.Price(labels, j.RunnerGroupName, jr.DurS)
	}
	for _, s := range j.Steps {
		sr := StepRec{
			Number: s.Number, Name: s.Name, Norm: normStep(s.Name), Conclusion: s.Conclusion,
			Started: s.StartedAt, Completed: s.CompletedAt,
		}
		if s.Conclusion != "skipped" && !s.StartedAt.IsZero() && !s.CompletedAt.IsZero() && !s.CompletedAt.Before(s.StartedAt) {
			sr.DurS = s.CompletedAt.Sub(s.StartedAt).Seconds()
			sr.Timed = true
		}
		sr.Category = stepCategory(sr.Norm, j.Name)
		jr.Steps = append(jr.Steps, sr)
	}
	return jr
}

var phaseRe = regexp.MustCompile(`^(Build|Install|Migrate|Suite|Uninstall) \(`)

var pinRe = regexp.MustCompile(`@[0-9A-Za-z._\-/]+`)

// normStep strips action pins so the same step groups across SHA bumps.
func normStep(n string) string {
	return strings.TrimSpace(pinRe.ReplaceAllString(n, ""))
}

// recipeSuffix extracts the recipe from a reusable-workflow job name such as
// "recipes / test-sdk-java".
func recipeSuffix(jobName string) string {
	if i := strings.LastIndex(jobName, " / "); i >= 0 {
		return strings.TrimSpace(jobName[i+3:])
	}
	return jobName
}

// stepCategory buckets a normalised step name. Step names in the truvity
// workflows are opaque ("Run truvity/ci-actions/recipe@<sha>"), so the recipe
// name is taken from the job name.
func stepCategory(norm, jobName string) string {
	l := strings.ToLower(norm)
	switch {
	case l == "set up job":
		return "job-setup"
	case l == "complete job":
		return "job-complete"
	case strings.Contains(l, "checkout"):
		return "checkout"
	case strings.Contains(l, "setup-devbox") || strings.Contains(l, "devbox"):
		return "setup-devbox"
	case strings.Contains(l, "cache"):
		return "cache"
	case strings.Contains(l, "actions/recipe"):
		return "recipe:" + recipeSuffix(jobName)
	case strings.Contains(l, "setup-remote-builders"):
		return "remote-builders"
	case phaseRe.MatchString(norm):
		return "integration:" + strings.ToLower(phaseRe.FindStringSubmatch(norm)[1])
	case strings.Contains(l, "ecr-login") || strings.Contains(l, "configure-aws-credentials"):
		return "aws-login"
	}
	return "other"
}
