// Package boundary declares the shape of the IAM permissions boundaries that
// the grun stack (cdk-github-runners on ECS Fargate) needs, as policy
// documents generated from parameters.
//
// Two boundaries exist, one per kind of principal:
//
//   - Runtime ([Runtime]) bounds the stack's own roles: the roles whose names
//     start with Params.RolePrefix, which the Step Functions state machines,
//     Lambda functions and ECS tasks of the stack run as. It allows everything
//     except IAM writes, with two carve-outs.
//   - Deploy ([Deploy]) bounds the CDK bootstrap roles (the roles named
//     "cdk-<qualifier>-*": CloudFormation execution, deploy, file and image
//     publishing, lookup). It is an allow list: what it takes to create the
//     stack's resources and the roles bounded by the Runtime boundary, and
//     nothing more in IAM.
//
// The package has no dependency on the AWS SDK or on an infrastructure tool: it
// returns [Document] values that marshal to minified JSON, ready to be created
// as customer managed policies by whatever manages the account. Every name,
// prefix and path is a parameter; the package knows no account, organisation
// or environment.
//
// The documents are the component's part only. The estate's own guards (no
// edit of a boundary policy, no removal of a boundary from a role or user) are
// appended by whatever creates the boundaries, so each document is held to
// [MaxComponentSize] characters minified, which leaves [GuardReserve] of IAM's
// 6,144 ([MaxSize]); both constructors return an error rather than a document
// that would not fit.
package boundary
