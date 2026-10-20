package boundary

import (
	"encoding/json"
	"fmt"
)

const (
	// MaxSize is IAM's limit on a managed policy document, in characters. IAM
	// does not count whitespace, so a minified document is measured against it.
	MaxSize = 6144

	// GuardReserve is the room left for the statements the caller appends to
	// every boundary it creates (the estate guards: no edit of a boundary
	// policy, no removal of a boundary from a role or user, and the like).
	GuardReserve = 1144

	// MaxComponentSize is the most a document of this package may measure
	// minified, so that it still fits [MaxSize] once the caller's guards are
	// appended.
	MaxComponentSize = MaxSize - GuardReserve
)

const (
	policyVersion = "2012-10-17"
	allow         = "Allow"
	deny          = "Deny"
)

// Document is an IAM policy document. It marshals to minified JSON
// (json.Marshal), the form [Runtime] and [Deploy] measure against [MaxSize].
type Document struct {
	Version   string      `json:"Version"`
	Statement []Statement `json:"Statement"`
}

// Statement is one statement of a [Document]. Action and Resource are a string
// when they hold one value and a []string otherwise.
type Statement struct {
	Sid         string         `json:"Sid"`
	Effect      string         `json:"Effect"`
	Action      any            `json:"Action,omitempty"`
	NotAction   any            `json:"NotAction,omitempty"`
	Resource    any            `json:"Resource,omitempty"`
	NotResource any            `json:"NotResource,omitempty"`
	Condition   map[string]any `json:"Condition,omitempty"`
}

// JSON returns the document as minified JSON.
func (d Document) JSON() ([]byte, error) {
	b, err := json.Marshal(d)
	if err != nil {
		return nil, fmt.Errorf("marshal policy document: %w", err)
	}

	return b, nil
}

// checkSize returns an error if the minified document is over [MaxComponentSize].
func checkSize(name string, d Document) error {
	b, err := d.JSON()
	if err != nil {
		return err
	}

	if len(b) > MaxComponentSize {
		return fmt.Errorf("boundary: the %s document is %d characters minified, over the %d that leave room for the caller's guards under IAM's limit of %d",
			name, len(b), MaxComponentSize, MaxSize)
	}

	return nil
}

// Size returns the length of the minified document in characters, the number
// IAM's limit applies to.
func (d Document) Size() (int, error) {
	b, err := d.JSON()
	if err != nil {
		return 0, err
	}

	return len(b), nil
}

func (p Params) roleARN(name string) string {
	return fmt.Sprintf("arn:%s:iam::*:role/%s", p.partition(), name)
}

func (p Params) policyARN(name string) string {
	return fmt.Sprintf("arn:%s:iam::*:policy/%s", p.partition(), name)
}

// withObjects lists each bucket ARN and its objects.
func withObjects(arns ...string) []string {
	out := make([]string, 0, 2*len(arns))
	for _, a := range arns {
		out = append(out, a, a+"/*")
	}

	return out
}
