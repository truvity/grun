package boundary

import (
	"slices"
	"testing"

	"github.com/truvity/aws-structure/policy"
)

// TestLimitedTypesAreNotStale holds limitedTypes in step with the document:
// every namespace the document allows narrowly has an entry, and no entry
// outlives the allowance it describes.
func TestLimitedTypesAreNotStale(t *testing.T) {
	c, err := DeployCoverage(Params{RolePrefix: "grun-", RuntimeBoundaryName: "x", Qualifier: "q"})
	if err != nil {
		t.Fatal(err)
	}

	for ns := range c.Limited {
		if _, ok := limitedTypes[ns]; !ok {
			t.Errorf("%s is allowed narrowly but has no entry in limitedTypes", ns)
		}
	}

	for ns := range limitedTypes {
		if _, ok := c.Limited[ns]; !ok {
			t.Errorf("limitedTypes has %s, which the document does not allow narrowly", ns)
		}
	}
}

func TestCheckSize(t *testing.T) {
	big := policy.Document{Statement: []policy.Statement{{Sid: "X", Effect: allow, Action: []string{"*"}, Resource: make([]string, 4000)}}}
	if err := checkSize("Big", big); err == nil {
		t.Error("a document over the limit was accepted")
	}

	small := policy.Document{Statement: []policy.Statement{{Sid: "X", Effect: allow, Action: []string{"*"}, Resource: []string{"*"}}}}
	if err := checkSize("Small", small); err != nil {
		t.Error(err)
	}
}

// TestServiceLinkedRolesAreExactlyTheNeededOnes holds the allowed
// service-linked roles in step with the resource types that create them: none
// is allowed that no type needs, and the coverage reports what the document
// allows.
func TestServiceLinkedRolesAreExactlyTheNeededOnes(t *testing.T) {
	if !slices.IsSorted(deployServiceLinkedRoles) {
		t.Errorf("deployServiceLinkedRoles is not sorted: %v", deployServiceLinkedRoles)
	}

	needed := map[string]bool{}

	for _, services := range slrCreatingTypes {
		for _, s := range services {
			needed[s] = true
		}
	}

	for _, s := range deployServiceLinkedRoles {
		if !needed[s] {
			t.Errorf("%s is allowed but no resource type in slrCreatingTypes needs it", s)
		}
	}

	c, err := DeployCoverage(Params{RolePrefix: "grun-", RuntimeBoundaryName: "x", Qualifier: "q"})
	if err != nil {
		t.Fatal(err)
	}

	if !slices.Equal(c.ServiceLinkedRoles, deployServiceLinkedRoles) {
		t.Errorf("coverage lists %v, the document allows %v", c.ServiceLinkedRoles, deployServiceLinkedRoles)
	}
}
