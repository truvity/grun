package boundary

import (
	"slices"
	"sort"
	"strings"

	"github.com/truvity/aws-structure/policy"
)

// Coverage says which services the Deploy boundary lets the bootstrap roles
// use, and which CloudFormation resource types that covers. A test of the
// stack uses it to fail when the stack grows a resource type the boundary
// would refuse at deploy time.
type Coverage struct {
	// Allowed is every IAM namespace the Deploy document allows an action in,
	// sorted: the union of Full and the keys of Limited.
	Allowed []string `json:"allowed"`
	// Full are the namespaces allowed with every action on every resource.
	// Every CloudFormation resource type of such a service is covered.
	Full []string `json:"full"`
	// Limited are the other allowed namespaces, each with the resource types
	// the document's narrower allowance covers (a security group's rules, a
	// bucket of the stack, a role of the stack). A namespace with no types is
	// read or use only: it covers no resource type.
	Limited map[string][]string `json:"limited"`
	// Namespaces maps the CloudFormation service name of a resource type
	// (AWS::<Service>::...) to its IAM namespace where that is not the service
	// name in lower case.
	Namespaces map[string]string `json:"namespaces"`
	// Exempt are resource types that make no API call and need no permission.
	Exempt []string `json:"exempt"`
	// CustomResourceNamespace is the namespace of the function that backs a
	// "Custom::" resource: CloudFormation invokes it.
	CustomResourceNamespace string `json:"customResourceNamespace"`
	// ServiceLinkedRoles are the services (iam:AWSServiceName) whose
	// service-linked role the document lets CloudFormation create.
	ServiceLinkedRoles []string `json:"serviceLinkedRoles"`
	// NeedsServiceLinkedRole maps a CloudFormation resource type to the
	// services whose service-linked role creating it can implicitly create. A
	// type listed here is covered only if the document allows each of its
	// services in ServiceLinkedRoles.
	NeedsServiceLinkedRole map[string][]string `json:"needsServiceLinkedRole"`
}

// limitedTypes are the CloudFormation resource types the narrow allowances of
// the Deploy document cover, by IAM namespace. Every namespace the document
// allows that is not in [fullServices] must be a key here (empty for read or
// use only); a test holds the two in step.
var limitedTypes = map[string][]string{
	"acm":                  nil,
	"budgets":              {"AWS::Budgets::Budget"},
	"ec2":                  {"AWS::EC2::SecurityGroup", "AWS::EC2::SecurityGroupEgress", "AWS::EC2::SecurityGroupIngress"},
	"ecr":                  {"AWS::ECR::Repository"},
	"elasticloadbalancing": nil,
	"iam":                  {"AWS::IAM::Policy", "AWS::IAM::Role"},
	"kms":                  nil,
	"route53":              nil,
	"s3":                   {"AWS::S3::Bucket", "AWS::S3::BucketPolicy"},
	"ssm":                  nil,
	"sts":                  nil,
}

// slrCreatingTypes maps the CloudFormation resource types that implicitly
// create a service-linked role, the first time one is created in an account,
// to the service of that role (iam:AWSServiceName). A type missing here is
// assumed to need none, so adding a resource type of a service not yet used
// means checking that service's documentation for a service-linked role. The
// table lists more than the stack uses, so that a type added later is already
// known; the types of the stack must all be listed for the roles in
// [deployServiceLinkedRoles] (a test holds the two in step).
var slrCreatingTypes = map[string][]string{
	"AWS::ApiGateway::DomainName":                  {"ops.apigateway.amazonaws.com"},
	"AWS::CodeStarNotifications::NotificationRule": {"codestar-notifications.amazonaws.com"},
	"AWS::ECS::Cluster":                            {"ecs.amazonaws.com"},
	"AWS::ECS::Service":                            {"ecs.amazonaws.com"},
	"AWS::ElasticLoadBalancingV2::LoadBalancer":    {"elasticloadbalancing.amazonaws.com"},
}

// irregularNamespaces are the CloudFormation services whose IAM namespace is
// not their lower-case name.
var irregularNamespaces = map[string]string{
	"ApiGatewayV2":           "apigateway",
	"CertificateManager":     "acm",
	"CodeStarNotifications":  "codestar-notifications",
	"ElasticLoadBalancingV2": "elasticloadbalancing",
	"StepFunctions":          "states",
}

// DeployCoverage returns the coverage of the document [Deploy] renders for p.
func DeployCoverage(p Params) (Coverage, error) {
	d, err := Deploy(p)
	if err != nil {
		return Coverage{}, err
	}

	allowed := map[string]bool{}
	full := map[string]bool{}

	for _, s := range d.Statement {
		if s.Effect != allow {
			continue
		}

		for _, a := range s.Action {
			ns, act, _ := strings.Cut(a, ":")
			allowed[ns] = true

			if act == "*" && slices.Equal(s.Resource, []string{"*"}) && len(s.Condition) == 0 {
				full[ns] = true
			}
		}
	}

	c := Coverage{
		Allowed:                 sortedKeys(allowed),
		Full:                    sortedKeys(full),
		Limited:                 map[string][]string{},
		Namespaces:              irregularNamespaces,
		Exempt:                  []string{"AWS::CDK::Metadata"},
		CustomResourceNamespace: "lambda",
		ServiceLinkedRoles:      serviceLinkedRoleServices(d),
		NeedsServiceLinkedRole:  slrCreatingTypes,
	}

	for ns := range allowed {
		if !full[ns] {
			c.Limited[ns] = slices.Clone(limitedTypes[ns])
			if c.Limited[ns] == nil {
				c.Limited[ns] = []string{}
			}
		}
	}

	return c, nil
}

// serviceLinkedRoleServices returns the iam:AWSServiceName values under which
// the document allows iam:CreateServiceLinkedRole. It reads the rendered
// document, so the coverage cannot drift from it.
func serviceLinkedRoleServices(d policy.Document) []string {
	out := []string{}

	for _, s := range d.Statement {
		if s.Effect != allow || !slices.Contains(s.Action, "iam:CreateServiceLinkedRole") {
			continue
		}

		for _, c := range s.Condition {
			if c.Key == "iam:AWSServiceName" && c.Operator == "StringEquals" {
				out = append(out, c.Values...)
			}
		}
	}

	slices.Sort(out)

	return out
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}

	sort.Strings(out)

	return out
}
