// Package config publishes the schema of grun's environment configuration
// (schema.json, the input of the CDK app) as a Go validator, so a repository
// that keeps those files can check them against the schema the app itself
// uses, without mirroring it.
package config

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"go.yaml.in/yaml/v3"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

//go:embed schema.json
var schemaJSON []byte

// Schema returns the embedded JSON Schema (draft 7), a copy.
func Schema() []byte { return bytes.Clone(schemaJSON) }

var (
	compileOnce sync.Once
	compiled    *jsonschema.Schema
	compileErr  error
)

func compile() (*jsonschema.Schema, error) {
	compileOnce.Do(func() {
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(schemaJSON))
		if err != nil {
			compileErr = fmt.Errorf("grun config schema: %w", err)
			return
		}
		c := jsonschema.NewCompiler()
		c.DefaultDraft(jsonschema.Draft7)
		if err := c.AddResource("schema.json", doc); err != nil {
			compileErr = fmt.Errorf("grun config schema: %w", err)
			return
		}
		compiled, compileErr = c.Compile("schema.json")
		if compileErr != nil {
			compileErr = fmt.Errorf("grun config schema: %w", compileErr)
		}
	})
	return compiled, compileErr
}

// Validate checks doc, a YAML or JSON document, against the schema: shape,
// types, enums, required keys, and unknown keys (refused). The error lists
// every violation, one per line, each led by the JSON pointer of the failing
// value (for example "/runner/idleTimeoutMinutes: ..."); an unknown key is
// reported at its parent, naming the key. It does not apply the
// rules the CDK app checks beyond the schema (cross-field rules).
func Validate(doc []byte) error {
	sch, err := compile()
	if err != nil {
		return err
	}
	var v any
	if err := yaml.Unmarshal(doc, &v); err != nil {
		return fmt.Errorf("grun config: not YAML or JSON: %w", err)
	}
	// Normalise through JSON so numbers and nested maps have the types the
	// validator expects.
	raw, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("grun config: %w", err)
	}
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("grun config: %w", err)
	}
	verr := sch.Validate(inst)
	if verr == nil {
		return nil
	}
	var ve *jsonschema.ValidationError
	if !errors.As(verr, &ve) {
		return fmt.Errorf("grun config: %w", verr)
	}
	var lines []string
	collect(ve, &lines)
	sort.Strings(lines)
	return fmt.Errorf("invalid grun config:\n  %s", strings.Join(lines, "\n  "))
}

// collect gathers the leaf violations of e as "<pointer>: <message>".
func collect(e *jsonschema.ValidationError, out *[]string) {
	if len(e.Causes) == 0 {
		ptr := "/" + strings.Join(e.InstanceLocation, "/")
		*out = append(*out, fmt.Sprintf("%s: %s", ptr, e.ErrorKind.LocalizedString(messagePrinter)))
		return
	}
	for _, c := range e.Causes {
		collect(c, out)
	}
}

var messagePrinter = message.NewPrinter(language.English)
