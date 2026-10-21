package boundary_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/truvity/aws-structure/policy"
	"github.com/truvity/grun/boundary"
)

var update = flag.Bool("update", false, "rewrite the golden files")

// params are synthetic: nothing here names a real organisation or account.
func params() boundary.Params {
	return boundary.Params{
		RolePrefix:          "grun-",
		RuntimeBoundaryName: "bound@tech-grun",
		Qualifier:           "hnb659fds",
		ReadParameterPaths:  []string{"example/runners/*"},
		ReadBuckets:         []string{"example-truststore"},
		Partition:           "part",
	}
}

func minified(t *testing.T, d policy.Document) []byte {
	t.Helper()

	b, err := d.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}

	return b
}

// golden compares the document with testdata/<name>, an indented copy that is
// easy to review; -update rewrites it.
func golden(t *testing.T, name string, d policy.Document) {
	t.Helper()

	got, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		t.Fatal(err)
	}

	got = append(got, '\n')
	path := filepath.Join("testdata", name)

	if *update {
		if err := os.WriteFile(path, got, 0o644); err != nil { //nolint:gosec // test data
			t.Fatal(err)
		}
	}

	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	if !bytes.Equal(got, want) {
		t.Errorf("%s differs from the document (run: go test ./... -update, and review the diff)\n got: %s", name, got)
	}
}

func TestRuntimeGolden(t *testing.T) {
	d, err := boundary.Runtime(params())
	if err != nil {
		t.Fatal(err)
	}

	golden(t, "runtime.json", d)
}

func TestDeployGolden(t *testing.T) {
	d, err := boundary.Deploy(params())
	if err != nil {
		t.Fatal(err)
	}

	golden(t, "deploy.json", d)
}

// TestRuntimeIsTheEarlierDocument proves the Runtime document is the one
// an earlier tool rendered for this boundary (with the same inputs,
// testdata/earlier-runtime.json, copied unchanged). That
// document is this package's statements followed by two estate guards, the
// last two statements; the test shows that the remainder is identical byte for
// byte and that the whole is equal once the guards are put back.
func TestRuntimeIsTheEarlierDocument(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "earlier-runtime.json"))
	if err != nil {
		t.Fatal(err)
	}

	var old policy.Document
	if err := json.Unmarshal(raw, &old); err != nil {
		t.Fatal(err)
	}

	guards := old.Statement[len(old.Statement)-2:]
	if guards[0].Sid != "DenyBoundaryPolicyEdit" || guards[1].Sid != "NoBoundaryDelete" {
		t.Fatalf("the last two statements of the old document are %s and %s, not the estate guards", guards[0].Sid, guards[1].Sid)
	}

	// The old document's boundary name is "bound@tech-grun", its prefix "bound@".
	p := params()

	d, err := boundary.Runtime(p)
	if err != nil {
		t.Fatal(err)
	}

	rest := policy.Document{Version: old.Version, Statement: old.Statement[:len(old.Statement)-2]}
	if !bytes.Equal(minified(t, d), minified(t, rest)) {
		t.Errorf("Runtime differs from the old document without its guards:\n got: %s\nwant: %s", minified(t, d), minified(t, rest))
	}

	whole := policy.Document{Version: d.Version, Statement: append(slices.Clone(d.Statement), guards...)}

	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		t.Fatal(err)
	}

	if !bytes.Equal(minified(t, whole), compact.Bytes()) {
		t.Errorf("Runtime plus the guards differs from the old document:\n got: %s\nwant: %s", minified(t, whole), compact.Bytes())
	}
}

func TestNoEstateGuardsInDocuments(t *testing.T) {
	for name, build := range map[string]func(boundary.Params) (policy.Document, error){
		"Runtime": boundary.Runtime, "Deploy": boundary.Deploy,
	} {
		d, err := build(params())
		if err != nil {
			t.Fatal(err)
		}

		for _, s := range d.Statement {
			switch s.Sid {
			case "DenyBoundaryPolicyEdit", "NoBoundaryDelete":
				t.Errorf("%s carries the estate guard %s; the caller appends it", name, s.Sid)
			}

			if strings.Contains(string(minified(t, policy.Document{Statement: []policy.Statement{s}})), "DeleteRolePermissionsBoundary") {
				t.Errorf("%s statement %s denies removing a boundary; that is the caller's guard", name, s.Sid)
			}
		}
	}
}

// Both documents are valid policy documents: unique Sids, one of Action and
// NotAction, no empty entry.
func TestDocumentsAreValid(t *testing.T) {
	for name, build := range map[string]func(boundary.Params) (policy.Document, error){
		"Runtime": boundary.Runtime, "Deploy": boundary.Deploy,
	} {
		d, err := build(params())
		if err != nil {
			t.Fatal(err)
		}

		if err := d.Validate(); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestSizes(t *testing.T) {
	r, err := boundary.Runtime(params())
	if err != nil {
		t.Fatal(err)
	}

	d, err := boundary.Deploy(params())
	if err != nil {
		t.Fatal(err)
	}

	for name, doc := range map[string]policy.Document{"Runtime": r, "Deploy": d} {
		n, err := doc.Size()
		if err != nil {
			t.Fatal(err)
		}

		t.Logf("%s: %d characters minified (component limit %d, IAM limit %d)", name, n, boundary.MaxComponentSize, boundary.MaxSize)

		if n > boundary.MaxComponentSize {
			t.Errorf("%s is %d characters, over %d", name, n, boundary.MaxComponentSize)
		}
	}

	// Room for the guards: the largest realistic Deploy document plus 1,144
	// characters stays under IAM's limit. Deploy with many configured paths
	// and buckets, up to its own limit, never exceeds it either.
	n, _ := d.Size()
	if n+boundary.GuardReserve > boundary.MaxSize {
		t.Errorf("Deploy %d plus the guard reserve %d is over IAM's %d", n, boundary.GuardReserve, boundary.MaxSize)
	}
}

func TestDeployRefusesAnOversizeDocument(t *testing.T) {
	p := params()
	for i := range 60 {
		p.ReadParameterPaths = append(p.ReadParameterPaths, strings.Repeat("a", 20)+"/"+strings.Repeat("b", 10)+string(rune('a'+i%26))+"/*")
	}

	_, err := boundary.Deploy(p)
	if err == nil || !strings.Contains(err.Error(), "over the") {
		t.Fatalf("Deploy with 60 long paths: err = %v, want a size error", err)
	}
}

func TestValidation(t *testing.T) {
	for name, tc := range map[string]struct {
		mutate     func(*boundary.Params)
		want       string
		onlyDeploy bool
	}{
		"no role prefix":          {func(p *boundary.Params) { p.RolePrefix = "" }, "RolePrefix is empty", false},
		"wildcard role prefix":    {func(p *boundary.Params) { p.RolePrefix = "grun-*" }, "RolePrefix", false},
		"long role prefix":        {func(p *boundary.Params) { p.RolePrefix = strings.Repeat("a", 64) }, "RolePrefix", false},
		"bad partition":           {func(p *boundary.Params) { p.Partition = "AWS" }, "artition", false},
		"no runtime name":         {func(p *boundary.Params) { p.RuntimeBoundaryName = "" }, "RuntimeBoundaryName is empty", true},
		"runtime name with slash": {func(p *boundary.Params) { p.RuntimeBoundaryName = "a/b" }, "RuntimeBoundaryName", true},
		"no qualifier":            {func(p *boundary.Params) { p.Qualifier = "" }, "ualifier", true},
		"qualifier wildcard":      {func(p *boundary.Params) { p.Qualifier = "*" }, "ualifier", true},
		"leading slash path":      {func(p *boundary.Params) { p.ReadParameterPaths = []string{"/a/*"} }, "must not start", true},
		"all-wildcard path":       {func(p *boundary.Params) { p.ReadParameterPaths = []string{"*"} }, "only wildcards", true},
		"empty path":              {func(p *boundary.Params) { p.ReadParameterPaths = []string{""} }, "empty entry", true},
		"all-wildcard bucket":     {func(p *boundary.Params) { p.ReadBuckets = []string{"*"} }, "only wildcards", true},
		"bucket with slash":       {func(p *boundary.Params) { p.ReadBuckets = []string{"a/b"} }, "ReadBuckets", true},
	} {
		t.Run(name, func(t *testing.T) {
			p := params()
			tc.mutate(&p)

			_, err := boundary.Deploy(p)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("Deploy: err = %v, want it to contain %q", err, tc.want)
			}

			_, err = boundary.Runtime(p)
			if tc.onlyDeploy && err != nil {
				t.Errorf("Runtime refused a Deploy-only parameter: %v", err)
			}

			if !tc.onlyDeploy && (err == nil || !strings.Contains(err.Error(), tc.want)) {
				t.Errorf("Runtime: err = %v, want it to contain %q", err, tc.want)
			}
		})
	}

	t.Run("every problem is reported", func(t *testing.T) {
		_, err := boundary.Deploy(boundary.Params{})
		if err == nil {
			t.Fatal("want an error")
		}

		var joined interface{ Unwrap() []error }
		if !errors.As(err, &joined) || len(joined.Unwrap()) < 4 {
			t.Errorf("err = %v, want the joined problems", err)
		}
	})

	t.Run("an empty partition is aws", func(t *testing.T) {
		p := params()
		p.Partition = ""

		d, err := boundary.Runtime(p)
		if err != nil || !strings.Contains(string(minified(t, d)), "arn:"+"aws"+":iam::") {
			t.Errorf("Runtime with no partition: %v", err)
		}
	})
}
