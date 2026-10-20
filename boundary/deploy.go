package boundary

import (
	"errors"
	"fmt"
)

// The services the Deploy boundary lets a role be passed to, and the
// service-linked roles it lets be created. They are fixed by what the stack
// does: each passed-to service is one the stack's roles are attached to
// (a task definition, a function, a state machine, an image build project, an
// API's logging, a rule target, a schedule) or CloudFormation itself, which is
// handed the execution role.
var (
	deployPassedToServices = []string{
		"apigateway.amazonaws.com", "cloudformation.amazonaws.com", "codebuild.amazonaws.com",
		"ecs-tasks.amazonaws.com", "events.amazonaws.com", "lambda.amazonaws.com",
		"scheduler.amazonaws.com", "states.amazonaws.com",
	}
	deployServiceLinkedRoles = []string{"codestar-notifications.amazonaws.com", "ecs.amazonaws.com"}

	// fullServices are the IAM namespaces allowed with every action on every
	// resource: the services whose resources the stack creates, updates and
	// deletes through CloudFormation. Their physical names are mostly generated
	// by CloudFormation or by the stack's constructs, so no name can scope them;
	// what a role the stack creates may do with them is bounded by the Runtime
	// boundary, not here.
	fullServices = []string{
		"apigateway", "cloudformation", "cloudwatch", "codebuild", "codestar-notifications",
		"dynamodb", "ecs", "events", "lambda", "logs", "scheduler", "secretsmanager",
		"sns", "sqs", "states",
	}
)

// Deploy returns the document of the boundary on the CDK bootstrap roles
// (cfn-exec, deploy, file publishing, image publishing, lookup) that deploy the
// stack. It uses every field of Params; RuntimeBoundaryName is the one boundary it delegates.
//
// It is an allow list; there is no AllowAll. The execution role's identity
// policy is whatever the bootstrap gives it (the CDK default is
// AdministratorAccess), so this document is what limits it. It allows:
//
//   - IAM read; and IAM writes only on the stack's roles (role/RolePrefix*):
//     iam:CreateRole and iam:PutRolePermissionsBoundary only with the Runtime
//     boundary (iam:PermissionsBoundary = RuntimeBoundaryName), so a role of the
//     stack never exists without it; managing those roles (policies, tags,
//     trust, description, deletion). iam:PassRole only on the stack's roles and
//     the bootstrap roles (role/cdk-Qualifier-*) and only to the services in
//     [Deploy]'s fixed list. iam:CreateServiceLinkedRole for ECS and CodeStar
//     Notifications only. There is no other IAM write: no user, no policy, no
//     boundary change, no role outside the stack.
//   - sts:AssumeRole on the bootstrap roles, which is how the deploy role
//     reaches the publishing and lookup roles.
//   - every action of the services the stack's resources live in (the
//     namespaces listed by [DeployCoverage]), on every resource, except that
//     secretsmanager:GetSecretValue and BatchGetSecretValue are denied.
//   - EC2 Describe, security-group writes, and tags only on security groups;
//     Elastic Load Balancing, Route 53 and ACM reads, for lookups.
//   - KMS use, and grants only for AWS resources (kms:GrantIsForAWSResource).
//   - ECR on repositories named RolePrefix* and on the bootstrap's container
//     repository; S3 on the bootstrap's assets bucket and on buckets named
//     RolePrefix*, and read-only on ReadBuckets; SSM read on the bootstrap's
//     version parameter and on ReadParameterPaths; Budgets on budgets named
//     RolePrefix*.
//
// Denies cover what an allow above could reach if it were widened by mistake:
// reading secret values, Organizations, accounts and billing. The caller's
// estate guards (no edit of a boundary policy, no removal of a boundary from a
// role or user) are not in the document: the system that creates the
// boundaries appends them.
//
// The document stays under [MaxSize]; Deploy returns an error if it ever does
// not.
func Deploy(p Params) (Document, error) {
	if errs := append(p.validate(), p.validateDeploy()...); len(errs) > 0 {
		return Document{}, errors.Join(append([]error{errors.New("boundary: invalid Deploy parameters")}, errs...)...)
	}

	part := p.partition()
	stackRoles := p.roleARN(p.RolePrefix + "*")
	bootstrapRoles := p.roleARN("cdk-" + p.Qualifier + "-*")
	assets := fmt.Sprintf("arn:%s:s3:::cdk-%s-assets-*", part, p.Qualifier)
	stackBuckets := fmt.Sprintf("arn:%s:s3:::%s*", part, p.RolePrefix)

	stackServices := make([]string, 0, len(fullServices))
	for _, s := range fullServices {
		stackServices = append(stackServices, s+":*")
	}

	stmts := []Statement{
		{Sid: "AllowIAMRead", Effect: allow, Action: []string{"iam:Get*", "iam:List*"}, Resource: "*"},
		{
			// The only way a role of the stack comes to be: with the Runtime boundary.
			Sid: "AllowCreateStackRoles", Effect: allow, Action: []string{"iam:CreateRole", "iam:PutRolePermissionsBoundary"},
			Resource:  stackRoles,
			Condition: map[string]any{"ArnLike": map[string]any{"iam:PermissionsBoundary": p.policyARN(p.RuntimeBoundaryName)}},
		},
		{
			Sid: "AllowManageStackRoles", Effect: allow,
			Action: []string{
				"iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:DeleteRolePolicy", "iam:DetachRolePolicy",
				"iam:DeleteRole", "iam:TagRole", "iam:UntagRole", "iam:UpdateRole", "iam:UpdateRoleDescription",
				"iam:UpdateAssumeRolePolicy",
			},
			Resource: stackRoles,
		},
		{
			Sid: "AllowPassStackAndBootstrapRoles", Effect: allow, Action: "iam:PassRole",
			Resource:  []string{stackRoles, bootstrapRoles},
			Condition: map[string]any{"StringEquals": map[string]any{"iam:PassedToService": deployPassedToServices}},
		},
		{
			Sid: "AllowServiceLinkedRoles", Effect: allow, Action: "iam:CreateServiceLinkedRole", Resource: "*",
			Condition: map[string]any{"StringEquals": map[string]any{"iam:AWSServiceName": deployServiceLinkedRoles}},
		},
		// The deploy role reaches the publishing and lookup roles; the CLI reaches
		// them through the deploy role.
		{Sid: "AllowAssumeBootstrapRoles", Effect: allow, Action: "sts:AssumeRole", Resource: bootstrapRoles},
		{Sid: "AllowStackServices", Effect: allow, Action: stackServices, Resource: "*"},
		{
			Sid: "AllowEC2SecurityGroupsAndLookups", Effect: allow,
			Action: []string{
				"ec2:Describe*", "ec2:CreateSecurityGroup", "ec2:DeleteSecurityGroup",
				"ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress",
				"ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:ModifySecurityGroupRules",
				"ec2:UpdateSecurityGroupRuleDescriptionsIngress", "ec2:UpdateSecurityGroupRuleDescriptionsEgress",
				"elasticloadbalancing:Describe*", "route53:Get*", "route53:List*",
				"acm:DescribeCertificate", "acm:GetCertificate", "acm:ListCertificates", "acm:ListTagsForCertificate",
			},
			Resource: "*",
		},
		{
			Sid: "AllowEC2SecurityGroupTags", Effect: allow, Action: []string{"ec2:CreateTags", "ec2:DeleteTags"},
			Resource: fmt.Sprintf("arn:%s:ec2:*:*:security-group/*", part),
		},
		{
			Sid: "AllowKMSUse", Effect: allow,
			Action: []string{
				"kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey",
				"kms:Sign", "kms:Verify", "kms:GetPublicKey",
			},
			Resource: "*",
		},
		{
			Sid: "AllowKMSGrantsForAWSResources", Effect: allow,
			Action: []string{"kms:CreateGrant", "kms:ListGrants", "kms:RetireGrant"}, Resource: "*",
			Condition: map[string]any{"Bool": map[string]any{"kms:GrantIsForAWSResource": "true"}},
		},
		{
			Sid: "AllowECRRepositories", Effect: allow, Action: "ecr:*",
			Resource: []string{
				fmt.Sprintf("arn:%s:ecr:*:*:repository/%s*", part, p.RolePrefix),
				fmt.Sprintf("arn:%s:ecr:*:*:repository/cdk-%s-container-assets-*", part, p.Qualifier),
			},
		},
		{Sid: "AllowECRToken", Effect: allow, Action: "ecr:GetAuthorizationToken", Resource: "*"},
		{
			// What the deploy and publishing roles do with the bootstrap's bucket;
			// CloudFormation and Lambda read the templates and the code from it.
			Sid: "AllowBootstrapAssets", Effect: allow,
			Action: []string{
				"s3:GetObject*", "s3:GetBucket*", "s3:GetEncryptionConfiguration", "s3:List*", "s3:PutObject*",
				"s3:DeleteObject*", "s3:Abort*",
			},
			Resource: withObjects(assets),
		},
		{Sid: "AllowStackBuckets", Effect: allow, Action: "s3:*", Resource: withObjects(stackBuckets)},
	}

	if len(p.ReadBuckets) > 0 {
		buckets := make([]string, 0, len(p.ReadBuckets))
		for _, b := range p.ReadBuckets {
			buckets = append(buckets, fmt.Sprintf("arn:%s:s3:::%s", part, b))
		}

		stmts = append(stmts, Statement{
			Sid: "AllowReadBuckets", Effect: allow,
			Action:   []string{"s3:GetObject", "s3:GetObjectVersion", "s3:GetBucketLocation", "s3:ListBucket"},
			Resource: withObjects(buckets...),
		})
	}

	params := []string{fmt.Sprintf("arn:%s:ssm:*:*:parameter/cdk-bootstrap/%s/*", part, p.Qualifier)}
	for _, path := range p.ReadParameterPaths {
		params = append(params, fmt.Sprintf("arn:%s:ssm:*:*:parameter/%s", part, path))
	}

	stmts = append(stmts,
		Statement{
			Sid: "AllowSSMRead", Effect: allow,
			Action: []string{"ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"}, Resource: params,
		},
		Statement{Sid: "AllowSSMDescribe", Effect: allow, Action: "ssm:DescribeParameters", Resource: "*"},
		Statement{
			Sid: "AllowStackBudgets", Effect: allow, Action: "budgets:*",
			Resource: fmt.Sprintf("arn:%s:budgets::*:budget/%s*", part, p.RolePrefix),
		},

		// Denies, for the day an allow above is widened by mistake.
		Statement{
			Sid: "DenyReadSecretValues", Effect: deny,
			Action: []string{"secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue"}, Resource: "*",
		},
		Statement{
			Sid: "DenyOrganizationAndBilling", Effect: deny,
			Action:   []string{"organizations:*", "account:*", "billing:*", "aws-portal:*", "payments:*"},
			Resource: "*",
		},
	)

	d := Document{Version: policyVersion, Statement: stmts}
	if err := checkSize("Deploy", d); err != nil {
		return Document{}, err
	}

	return d, nil
}
