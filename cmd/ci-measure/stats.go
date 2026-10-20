package main

import (
	"fmt"
	"math"
	"sort"
)

// pct returns the p-th percentile (0..100) of a sorted slice by the
// nearest-rank method. It returns 0 for an empty slice.
func pct(sorted []float64, p float64) float64 {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	rank := int(math.Ceil(p / 100 * float64(n)))
	if rank < 1 {
		rank = 1
	}
	if rank > n {
		rank = n
	}
	return sorted[rank-1]
}

func sorted(xs []float64) []float64 {
	out := append([]float64(nil), xs...)
	sort.Float64s(out)
	return out
}

func sum(xs []float64) float64 {
	var s float64
	for _, x := range xs {
		s += x
	}
	return s
}

// Agg aggregates the jobs of one group (repo, repo+label, job name, ...).
type Agg struct {
	Total      int // all job attempts, including skipped and never-started
	Ran        int
	NotRun     int
	Failed     int // ran, conclusion failure/timed_out
	Cancelled  int // ran, conclusion cancelled
	Queue      []float64
	Dur        []float64
	Minutes    float64
	WastedMin  float64 // minutes of failed + cancelled jobs
	CostMin    float64
	CostMax    float64
	Unpriced   int
	Hosted     int
	HostedMin  float64
	QueueOver  map[int]int // threshold seconds -> count of jobs above it
	classCount map[string]int
}

var queueThresholds = []int{10, 30, 60, 120}

func newAgg() *Agg { return &Agg{QueueOver: map[int]int{}, classCount: map[string]int{}} }

func (a *Agg) add(j *JobRec) {
	a.Total++
	if !j.Ran {
		a.NotRun++
		return
	}
	a.Ran++
	a.Queue = append(a.Queue, j.QueueS)
	a.Dur = append(a.Dur, j.DurS)
	a.Minutes += j.DurS / 60
	switch j.Conclusion {
	case "failure", "timed_out":
		a.Failed++
		a.WastedMin += j.DurS / 60
	case "cancelled":
		a.Cancelled++
		a.WastedMin += j.DurS / 60
	}
	for _, t := range queueThresholds {
		if j.QueueS > float64(t) {
			a.QueueOver[t]++
		}
	}
	a.classCount[j.Cost.Class]++
	switch j.Cost.Class {
	case ClassHosted:
		a.Hosted++
		a.HostedMin += j.DurS / 60
	case ClassUnpriced:
		a.Unpriced++
	default:
		a.CostMin += j.Cost.Min
		a.CostMax += j.Cost.Max
	}
}

func (a *Agg) finish() {
	a.Queue = sorted(a.Queue)
	a.Dur = sorted(a.Dur)
}

// Q and D return queue-latency and duration percentiles.
func (a *Agg) Q(p float64) float64 { return pct(a.Queue, p) }
func (a *Agg) D(p float64) float64 { return pct(a.Dur, p) }
func (a *Agg) QMax() float64 {
	if len(a.Queue) == 0 {
		return 0
	}
	return a.Queue[len(a.Queue)-1]
}
func (a *Agg) OverPct(t int) float64 {
	if a.Ran == 0 {
		return 0
	}
	return 100 * float64(a.QueueOver[t]) / float64(a.Ran)
}

// costStr renders the cost range of priced jobs, noting hosted/unpriced jobs.
func (a *Agg) costStr() string {
	var s string
	switch {
	case a.CostMax == 0 && a.Hosted == a.Ran && a.Ran > 0:
		s = "hosted"
	case a.CostMax == 0 && a.Unpriced == a.Ran && a.Ran > 0:
		s = "unpriced"
	case a.CostMin == a.CostMax:
		s = fmt.Sprintf("$%.2f", a.CostMin)
	default:
		s = fmt.Sprintf("$%.2f - $%.2f", a.CostMin, a.CostMax)
	}
	if a.Unpriced > 0 && a.Unpriced != a.Ran {
		s += fmt.Sprintf(" (+%d unpriced)", a.Unpriced)
	}
	return s
}

func groupJobs(jobs []*JobRec, key func(*JobRec) string) (map[string]*Agg, []string) {
	m := map[string]*Agg{}
	for _, j := range jobs {
		k := key(j)
		a := m[k]
		if a == nil {
			a = newAgg()
			m[k] = a
		}
		a.add(j)
	}
	keys := make([]string, 0, len(m))
	for k, a := range m {
		a.finish()
		keys = append(keys, k)
	}
	kept := keys[:0]
	for _, k := range keys {
		if m[k].Ran > 0 {
			kept = append(kept, k)
		}
	}
	keys = kept
	sort.Slice(keys, func(i, j int) bool {
		if m[keys[i]].Minutes != m[keys[j]].Minutes {
			return m[keys[i]].Minutes > m[keys[j]].Minutes
		}
		return keys[i] < keys[j]
	})
	return m, keys
}

// StepAgg aggregates a step name (or category) across jobs.
type StepAgg struct {
	N       int
	Durs    []float64
	Minutes float64
}

func (s *StepAgg) P(p float64) float64 { return pct(s.Durs, p) }

// stepsByName aggregates timed step instances by normalised name.
func stepsByName(jobs []*JobRec) (map[string]*StepAgg, []string) {
	m := map[string]*StepAgg{}
	for _, j := range jobs {
		if !j.Ran {
			continue
		}
		for _, s := range j.Steps {
			if !s.Timed {
				continue
			}
			a := m[s.Norm]
			if a == nil {
				a = &StepAgg{}
				m[s.Norm] = a
			}
			a.N++
			a.Durs = append(a.Durs, s.DurS)
			a.Minutes += s.DurS / 60
		}
	}
	keys := make([]string, 0, len(m))
	for k, a := range m {
		a.Durs = sorted(a.Durs)
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return m[keys[i]].Minutes > m[keys[j]].Minutes })
	return m, keys
}

// stepsByCategory aggregates per-JOB category time: the sum of all steps of a
// category within one job, over jobs that have that category. This answers
// "how long does checkout take per job" even when a category spans several
// steps (cache restore, save and post steps).
func stepsByCategory(jobs []*JobRec) (map[string]*StepAgg, []string) {
	m := map[string]*StepAgg{}
	for _, j := range jobs {
		if !j.Ran {
			continue
		}
		per := map[string]float64{}
		seen := map[string]bool{}
		for _, s := range j.Steps {
			if !s.Timed {
				continue
			}
			per[s.Category] += s.DurS
			seen[s.Category] = true
		}
		for c := range seen {
			a := m[c]
			if a == nil {
				a = &StepAgg{}
				m[c] = a
			}
			a.N++
			a.Durs = append(a.Durs, per[c])
			a.Minutes += per[c] / 60
		}
	}
	keys := make([]string, 0, len(m))
	for k, a := range m {
		a.Durs = sorted(a.Durs)
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return m[keys[i]].Minutes > m[keys[j]].Minutes })
	return m, keys
}

// fmtS renders seconds compactly: 6.5s, 1m37s, 1h02m.
func fmtS(s float64) string {
	switch {
	case s < 60:
		return fmt.Sprintf("%.1fs", s)
	case s < 3600:
		return fmt.Sprintf("%dm%02ds", int(s)/60, int(s)%60)
	default:
		return fmt.Sprintf("%dh%02dm", int(s)/3600, (int(s)%3600)/60)
	}
}
