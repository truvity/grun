package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// Cost classes.
const (
	ClassARC      = "arc"
	ClassFargate  = "fargate"
	ClassHosted   = "hosted"
	ClassUnpriced = "unpriced"
)

// LabelCost is the cost rule for one runner label.
type LabelCost struct {
	Kind string `json:"kind"` // arc | fargate | hosted

	// arc: effective USD per runner-minute, as a range (spot .. on-demand).
	MinPerMin float64 `json:"min_per_min,omitempty"`
	MaxPerMin float64 `json:"max_per_min,omitempty"`

	// fargate: task shape.
	VCPU float64 `json:"vcpu,omitempty"`
	GB   float64 `json:"gb,omitempty"`
}

// CostTable maps runner labels to cost rules.
type CostTable struct {
	Labels          map[string]LabelCost `json:"labels"`
	FargateVCPUHour float64              `json:"fargate_vcpu_hour"`
	FargateGBHour   float64              `json:"fargate_gb_hour"`
	FargateMinSec   float64              `json:"fargate_min_seconds"`
	// HostedGroups: runner_group_name values that mean GitHub-hosted.
	HostedGroups []string `json:"hosted_groups"`
}

// defaultCosts returns EXAMPLE prices and runner labels. Override both with
// -costs for a real estate: the labels below are placeholders, and the
// self-hosted (arc) rate is an assumed all-in range per runner-minute, spot
// to on-demand, that already folds in idle nodes and cluster overhead. The
// Fargate rates are list prices for an ARM task and vary by region.
func defaultCosts() *CostTable {
	arc := LabelCost{Kind: "arc", MinPerMin: 0.0054, MaxPerMin: 0.0121}
	hosted := LabelCost{Kind: "hosted"}
	return &CostTable{
		Labels: map[string]LabelCost{
			"arc-large":        arc,
			"arc-medium":       arc,
			"arc-small":        arc,
			"fg-large":         {Kind: "fargate", VCPU: 4, GB: 24},
			"fg-medium":        {Kind: "fargate", VCPU: 2, GB: 14},
			"fg-small":         {Kind: "fargate", VCPU: 1, GB: 6},
			"ubuntu-latest":    hosted,
			"ubuntu-24.04":     hosted,
			"ubuntu-22.04":     hosted,
			"ubuntu-24.04-arm": hosted,
			"ubuntu-22.04-arm": hosted,
			"macos-latest":     hosted,
			"windows-latest":   hosted,
		},
		FargateVCPUHour: 0.03725,
		FargateGBHour:   0.00409,
		FargateMinSec:   60,
		HostedGroups:    []string{"GitHub Actions"},
	}
}

func loadCosts(path string) (*CostTable, error) {
	t := defaultCosts()
	if path == "" {
		return t, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var over CostTable
	if err := json.Unmarshal(b, &over); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	for k, v := range over.Labels {
		t.Labels[k] = v
	}
	if over.FargateVCPUHour > 0 {
		t.FargateVCPUHour = over.FargateVCPUHour
	}
	if over.FargateGBHour > 0 {
		t.FargateGBHour = over.FargateGBHour
	}
	if over.FargateMinSec > 0 {
		t.FargateMinSec = over.FargateMinSec
	}
	if len(over.HostedGroups) > 0 {
		t.HostedGroups = over.HostedGroups
	}
	return t, nil
}

// Cost is the USD range for one job (Min == Max for exact rules).
type Cost struct {
	Class string
	Min   float64
	Max   float64
}

// Price returns the cost of a job that ran for durS seconds on a runner with
// the given labels and runner group.
func (t *CostTable) Price(labels []string, group string, durS float64) Cost {
	for _, l := range labels {
		lc, ok := t.Labels[strings.ToLower(l)]
		if !ok {
			continue
		}
		switch lc.Kind {
		case "arc":
			return Cost{ClassARC, durS / 60 * lc.MinPerMin, durS / 60 * lc.MaxPerMin}
		case "fargate":
			billed := durS
			if billed < t.FargateMinSec {
				billed = t.FargateMinSec
			}
			perHour := lc.VCPU*t.FargateVCPUHour + lc.GB*t.FargateGBHour
			c := billed / 3600 * perHour
			return Cost{ClassFargate, c, c}
		case "hosted":
			return Cost{Class: ClassHosted}
		}
	}
	for _, g := range t.HostedGroups {
		if group == g {
			return Cost{Class: ClassHosted}
		}
	}
	return Cost{Class: ClassUnpriced}
}
