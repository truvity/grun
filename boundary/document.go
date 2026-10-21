package boundary

import (
	"fmt"

	"github.com/truvity/aws-structure/policy"
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
	allow = policy.Allow
	deny  = policy.Deny
)

// checkSize returns an error if the minified document is over [MaxComponentSize].
func checkSize(name string, d policy.Document) error {
	n, err := d.Size()
	if err != nil {
		return fmt.Errorf("boundary: the %s document: %w", name, err)
	}

	if n > MaxComponentSize {
		return fmt.Errorf("boundary: the %s document is %d characters minified, over the %d that leave room for the caller's guards under IAM's limit of %d",
			name, n, MaxComponentSize, MaxSize)
	}

	return nil
}

// star is the one-element list "*".
func star() []string { return []string{"*"} }

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
