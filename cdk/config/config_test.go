package config_test

import (
	"os"
	"strings"
	"testing"

	"github.com/truvity/grun/cdk/config"
)

func TestValidate(t *testing.T) {
	example, err := os.ReadFile("example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	with := func(old, repl string) []byte {
		s := string(example)
		if !strings.Contains(s, old) {
			t.Fatalf("fixture lacks %q", old)
		}
		return []byte(strings.Replace(s, old, repl, 1))
	}
	tests := []struct {
		name string
		doc  []byte
		want string // substring of the error, "" for valid
	}{
		{"the example config", example, ""},
		{"JSON", []byte(`{"env":"x"}`), "/: "},
		{"unknown top-level key", append(append([]byte{}, example...), "\nnoSuchKey: 1\n"...), "/: additional properties 'noSuchKey'"},
		{"unknown nested key", with("  vpcId: vpc-0example0000000000", "  noSuchKey: 1\n  vpcId: vpc-0example0000000000"), "/network: additional properties 'noSuchKey'"},
		{"wrong type", with("region: eu-central-1", "region: 12"), "/region"},
		{"pattern", with("env: example ", "env: Not_Valid "), "/env"},
		{"missing required key", with("region: eu-central-1\n", ""), "/: "},
		{"not a document", []byte("a: [1\n"), "not YAML or JSON"},
		{"not an object", []byte("- 1\n"), "/: "},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := config.Validate(tc.doc)
			switch {
			case tc.want == "" && err != nil:
				t.Fatalf("want valid, got: %v", err)
			case tc.want != "" && err == nil:
				t.Fatalf("want an error containing %q, got none", tc.want)
			case tc.want != "" && !strings.Contains(err.Error(), tc.want):
				t.Fatalf("want an error containing %q, got: %v", tc.want, err)
			}
		})
	}
}

func TestMissingRequiredNamesTheKey(t *testing.T) {
	err := config.Validate([]byte("env: example\n"))
	if err == nil || !strings.Contains(err.Error(), "region") {
		t.Fatalf("want the missing key named, got: %v", err)
	}
}

func TestSchemaIsEmbedded(t *testing.T) {
	if s := config.Schema(); !strings.Contains(string(s), `"$id": "grun-config"`) {
		t.Fatal("schema.json is not embedded")
	}
}
