package boundary_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/truvity/grun/boundary"
)

func asList(v any) []string {
	switch x := v.(type) {
	case string:
		return []string{x}
	case []string:
		return x
	}

	return nil
}

func deploy(t *testing.T) boundary.Document {
	t.Helper()

	d, err := boundary.Deploy(params())
	if err != nil {
		t.Fatal(err)
	}

	return d
}

func TestDeployIsAnAllowList(t *testing.T) {
	for _, s := range deploy(t).Statement {
		if s.Effect == "Allow" && slices.Contains(asList(s.Action), "*") {
			t.Errorf("statement %s allows every action", s.Sid)
		}

		if s.NotAction != nil {
			t.Errorf("statement %s uses NotAction", s.Sid)
		}
	}
}

// TestDeployIAMWritesAreScoped holds the property the boundary exists for: the
// only IAM writes are on the stack's roles, and roles are created only with
// the runtime boundary.
func TestDeployIAMWritesAreScoped(t *testing.T) {
	readOnly := func(a string) bool {
		return strings.HasPrefix(a, "iam:Get") || strings.HasPrefix(a, "iam:List")
	}

	for _, s := range deploy(t).Statement {
		if s.Effect != "Allow" {
			continue
		}

		for _, a := range asList(s.Action) {
			if !strings.HasPrefix(a, "iam:") || readOnly(a) {
				continue
			}

			res := asList(s.Resource)
			scoped := len(res) > 0
			for _, r := range res {
				if !strings.Contains(r, ":role/") {
					scoped = false
				}
			}

			switch {
			case a == "iam:CreateServiceLinkedRole":
				if s.Condition == nil {
					t.Errorf("%s: iam:CreateServiceLinkedRole without a service condition", s.Sid)
				}
			case !scoped:
				t.Errorf("%s: %s is not scoped to roles: %v", s.Sid, a, s.Resource)
			}

			if (a == "iam:CreateRole" || a == "iam:PutRolePermissionsBoundary") && s.Condition["ArnLike"] == nil {
				t.Errorf("%s: %s without the permissions boundary condition", s.Sid, a)
			}
		}
	}
}

func TestDeployDelegatesExactlyTheRuntimeBoundary(t *testing.T) {
	var found bool

	for _, s := range deploy(t).Statement {
		if !slices.Contains(asList(s.Action), "iam:CreateRole") {
			continue
		}

		found = true
		got := s.Condition["ArnLike"].(map[string]any)["iam:PermissionsBoundary"]

		if got != "arn:part:iam::*:policy/bound@tech-grun" {
			t.Errorf("iam:CreateRole is conditioned on %v, want exactly the runtime boundary", got)
		}

		if !slices.Equal(asList(s.Action), []string{"iam:CreateRole", "iam:PutRolePermissionsBoundary"}) {
			t.Errorf("the delegating statement has actions %v", s.Action)
		}
	}

	if !found {
		t.Error("no statement allows iam:CreateRole")
	}
}

func TestDeployDeniesWhatItShould(t *testing.T) {
	denied := map[string]bool{}

	for _, s := range deploy(t).Statement {
		if s.Effect == "Deny" {
			for _, a := range asList(s.Action) {
				denied[a] = true
			}
		}
	}

	for _, a := range []string{
		"secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue", "organizations:*", "account:*", "billing:*",
	} {
		if !denied[a] {
			t.Errorf("%s is not denied", a)
		}
	}
}

func TestDeployOptionalInputs(t *testing.T) {
	p := params()
	p.ReadBuckets, p.ReadParameterPaths = nil, nil

	d, err := boundary.Deploy(p)
	if err != nil {
		t.Fatal(err)
	}

	for _, s := range d.Statement {
		if s.Sid == "AllowReadBuckets" {
			t.Error("AllowReadBuckets present with no ReadBuckets")
		}

		if s.Sid == "AllowSSMRead" && len(asList(s.Resource)) != 1 {
			t.Errorf("AllowSSMRead has %v, want only the bootstrap version parameter", s.Resource)
		}
	}
}

func TestCoverage(t *testing.T) {
	c, err := boundary.DeployCoverage(params())
	if err != nil {
		t.Fatal(err)
	}

	// Allowed is exactly Full plus Limited.
	want := slices.Clone(c.Full)
	for ns := range c.Limited {
		want = append(want, ns)
	}

	slices.Sort(want)

	if !slices.Equal(want, c.Allowed) {
		t.Errorf("Allowed = %v, Full plus Limited = %v", c.Allowed, want)
	}

	for _, ns := range []string{"lambda", "states", "cloudformation", "dynamodb"} {
		if !slices.Contains(c.Full, ns) {
			t.Errorf("%s is not fully allowed: %v", ns, c.Full)
		}
	}

	for _, ns := range []string{"iam", "s3", "ec2", "ecr", "kms", "ssm"} {
		if _, ok := c.Limited[ns]; !ok {
			t.Errorf("%s is not limited", ns)
		}
	}

	if slices.Contains(c.Allowed, "organizations") {
		t.Error("organizations is allowed")
	}
}
