package boundary

import (
	"errors"
	"slices"

	"github.com/truvity/aws-structure/policy"
)

// The Runtime boundary's two exceptions to its IAM deny are fixed by what the
// stack does: a state machine starts an ECS task, which needs iam:PassRole to
// ecs-tasks, and the cluster needs the ECS service-linked role.
const (
	runtimePassedToService   = "ecs-tasks.amazonaws.com"
	runtimeServiceLinkedRole = "ecs.amazonaws.com"
)

// iamWriteDenied is every IAM action that changes IAM or hands a role on.
var iamWriteDenied = []string{
	"iam:Create*", "iam:Delete*", "iam:Put*", "iam:Update*", "iam:Attach*", "iam:Detach*", "iam:Add*",
	"iam:Remove*", "iam:Set*", "iam:Tag*", "iam:Untag*", "iam:Upload*", "iam:Enable*", "iam:Disable*",
	"iam:Resync*", "iam:Pass*", "iam:Deactivate*", "iam:Generate*",
}

// Runtime returns the document of the boundary on the stack's own roles: the
// roles named Params.RolePrefix* that the state machines, Lambda functions and
// ECS tasks of cdk-github-runners run as. It uses Params.RolePrefix and
// Params.Partition.
//
// It allows everything and denies IAM writes, with two exceptions. A role may
// pass the stack's own roles (RolePrefix*) to ecs-tasks.amazonaws.com, which is
// how a state machine starts an ECS task, and may create the ECS
// service-linked role. It cannot create a role or a user, so it delegates
// nothing.
//
// The document is the component's part only. The caller's estate guards (no
// edit of any boundary policy, no removal of a boundary from a role or user)
// are not in it: the system that creates the boundaries appends them, and
// refuses a document that already carries them.
//
// Each exception is carved out of the deny by the key that scopes it, not
// listed beside it: an explicit Deny always wins over an Allow, and the absent
// key of a negated condition operator matches, so an action that does not
// carry the key (every other "iam:Create*") stays denied.
//
// The statements are the ones an earlier tool rendered for this boundary,
// moved here unchanged; a golden test holds them byte for byte.
func Runtime(p Params) (policy.Document, error) {
	if errs := p.validate(); len(errs) > 0 {
		return policy.Document{}, errors.Join(append([]error{errors.New("boundary: invalid Runtime parameters")}, errs...)...)
	}

	// iamWriteDenied without the two actions that are denied below under a condition.
	writes := slices.DeleteFunc(slices.Clone(iamWriteDenied), func(a string) bool {
		return a == "iam:Pass*" || a == "iam:Create*"
	})

	d := policy.Document{Version: policy.Version, Statement: []policy.Statement{
		{Sid: "AllowAll", Effect: allow, Action: []string{"*"}, Resource: []string{"*"}},
		{Sid: "DenyIAMWriteExceptGrun", Effect: deny, Action: writes, Resource: []string{"*"}},
		// iam:Create* except iam:CreateServiceLinkedRole for ECS.
		{
			Sid: "DenyCreateExceptServiceLinkedRole", Effect: deny, Action: []string{"iam:Create*"}, Resource: []string{"*"},
			Condition: []policy.Condition{{Operator: "StringNotEquals", Key: "iam:AWSServiceName", Values: []string{runtimeServiceLinkedRole}}},
		},
		{
			Sid: "DenyPassRoleOutsideGrunRoles", Effect: deny, Action: []string{"iam:PassRole"},
			NotResource: []string{p.roleARN(p.RolePrefix + "*")},
		},
		{
			Sid: "DenyPassRoleToOtherServices", Effect: deny, Action: []string{"iam:PassRole"}, Resource: []string{"*"},
			Condition: []policy.Condition{{Operator: "StringNotEquals", Key: "iam:PassedToService", Values: []string{runtimePassedToService}}},
		},
	}}

	if err := checkSize("Runtime", d); err != nil {
		return policy.Document{}, err
	}

	return d, nil
}
