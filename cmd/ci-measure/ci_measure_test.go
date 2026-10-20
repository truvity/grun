package main

import (
	"math"
	"testing"
)

func TestPct(t *testing.T) {
	xs := []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
	for p, want := range map[float64]float64{50: 5, 90: 9, 95: 10, 100: 10, 1: 1} {
		if got := pct(xs, p); got != want {
			t.Errorf("pct(%v)=%v want %v", p, got, want)
		}
	}
	if pct(nil, 50) != 0 {
		t.Error("empty")
	}
}

func TestFargateCost(t *testing.T) {
	c := defaultCosts()
	// fg-large, 30 s -> billed 60 s: (4*0.03725 + 24*0.00409)/60 per minute.
	got := c.Price([]string{"fg-large"}, "", 30)
	want := (4*0.03725 + 24*0.00409) / 60
	if got.Class != ClassFargate || math.Abs(got.Min-want) > 1e-9 {
		t.Errorf("got %+v want %v", got, want)
	}
	arc := c.Price([]string{"arc-large"}, "default", 120)
	if math.Abs(arc.Min-0.0108) > 1e-9 || math.Abs(arc.Max-0.0242) > 1e-9 {
		t.Errorf("arc %+v", arc)
	}
	if c.Price([]string{"self-hosted"}, "GitHub Actions", 10).Class != ClassHosted {
		t.Error("hosted group")
	}
}

func TestStepCategory(t *testing.T) {
	for in, want := range map[string]string{
		normStep("Run truvity/ci-actions/recipe@f9130c63"): "recipe:test",
		"Run actions/checkout":                             "checkout",
		"Post Run truvity/ci-actions/setup-devbox":         "setup-devbox",
		"Post Cache the yarn fetch cache":                  "cache",
		"Build (app)":                                      "integration:build",
		"Set up job":                                       "job-setup",
	} {
		if got := stepCategory(in, "recipes / test"); got != want {
			t.Errorf("%q -> %q want %q", in, got, want)
		}
	}
}
