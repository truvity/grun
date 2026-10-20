package boundary

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Params are the caller's inputs to both documents. Nothing here has a
// default that names an organisation, an account or an environment.
type Params struct {
	// RolePrefix is what the names of the stack's roles start with, such as
	// "grun-" (the stack names every role "<RolePrefix><env>-..." with no path).
	// The Runtime boundary lets a role pass only roles with this prefix; the
	// Deploy boundary lets CloudFormation create only roles with this prefix.
	// Required.
	RolePrefix string

	// RuntimeBoundaryName is the name of the managed policy created from the
	// Runtime document, such as "pb@tech-grun". The Deploy boundary delegates
	// exactly this boundary: it only lets a role named RolePrefix* come to be
	// with it. The name belongs to the caller's configuration, never to this
	// package. Required by [Deploy]; unused by [Runtime].
	RuntimeBoundaryName string

	// Qualifier is the CDK bootstrap qualifier, such as "hnb659fds" (the CDK
	// default). The bootstrap names are "cdk-<Qualifier>-*" for its roles,
	// "cdk-<Qualifier>-assets-*" for its bucket, "cdk-<Qualifier>-container-assets-*"
	// for its repository and "/cdk-bootstrap/<Qualifier>/*" for its version
	// parameter. Required by [Deploy]; unused by [Runtime].
	Qualifier string

	// ReadParameterPaths are SSM parameter paths, without the leading slash and
	// with their wildcards, that the Deploy boundary lets CloudFormation read,
	// such as "team/runners/*": the stack resolves GitHub App settings and the
	// like from them. A path made only of wildcards is refused. Optional.
	ReadParameterPaths []string

	// ReadBuckets are bucket-name patterns (no ARN prefix) whose objects the
	// Deploy boundary lets CloudFormation read, such as the bucket that holds
	// an API Gateway mutual TLS truststore. A pattern made only of wildcards
	// is refused. Optional.
	ReadBuckets []string

	// Partition is the ARN partition. Empty means "aws".
	Partition string
}

var (
	reName      = regexp.MustCompile(`^[A-Za-z0-9+=,.@_-]+$`)
	reQualifier = regexp.MustCompile(`^[A-Za-z0-9]{1,10}$`)
	rePartition = regexp.MustCompile(`^[a-z]+(-[a-z]+)*$`)
	reSSMPath   = regexp.MustCompile(`^[A-Za-z0-9_.*?/-]+$`)
	reBucket    = regexp.MustCompile(`^[a-z0-9.*?-]+$`)
)

const (
	maxRolePrefix    = 64  // IAM role names are at most 64 characters
	maxPolicyName    = 128 // IAM policy names are at most 128 characters
	defaultPartition = "aws"
)

func (p Params) partition() string {
	if p.Partition == "" {
		return defaultPartition
	}

	return p.Partition
}

// validate returns every problem with the parameters both documents need.
func (p Params) validate() []error {
	var errs []error

	switch {
	case p.RolePrefix == "":
		errs = append(errs, errors.New("RolePrefix is empty"))
	case !reName.MatchString(p.RolePrefix) || len(p.RolePrefix) >= maxRolePrefix:
		errs = append(errs, fmt.Errorf("RolePrefix %q is not a role-name prefix (letters, digits and +=,.@_-, under %d characters)", p.RolePrefix, maxRolePrefix))
	}

	if !rePartition.MatchString(p.partition()) {
		errs = append(errs, fmt.Errorf("partition %q is not an ARN partition", p.Partition))
	}

	return errs
}

// validateDeploy returns every problem with the parameters only [Deploy] needs.
func (p Params) validateDeploy() []error {
	var errs []error

	switch {
	case p.RuntimeBoundaryName == "":
		errs = append(errs, errors.New("RuntimeBoundaryName is empty"))
	case !reName.MatchString(p.RuntimeBoundaryName) || len(p.RuntimeBoundaryName) > maxPolicyName:
		errs = append(errs, fmt.Errorf("RuntimeBoundaryName %q is not a policy name", p.RuntimeBoundaryName))
	}

	if !reQualifier.MatchString(p.Qualifier) {
		errs = append(errs, fmt.Errorf("qualifier %q is not a CDK qualifier (1 to 10 letters and digits)", p.Qualifier))
	}

	errs = append(errs, validateList("ReadParameterPaths", p.ReadParameterPaths, reSSMPath, "/")...)
	errs = append(errs, validateList("ReadBuckets", p.ReadBuckets, reBucket, "")...)

	return errs
}

func validateList(field string, values []string, re *regexp.Regexp, forbidLeading string) []error {
	var errs []error

	for _, v := range values {
		switch {
		case v == "":
			errs = append(errs, fmt.Errorf("%s has an empty entry", field))
		case !re.MatchString(v):
			errs = append(errs, fmt.Errorf("%s entry %q has characters outside the allowed set", field, v))
		case forbidLeading != "" && strings.HasPrefix(v, forbidLeading):
			errs = append(errs, fmt.Errorf("%s entry %q must not start with %q", field, v, forbidLeading))
		case strings.Trim(v, "*?/") == "":
			errs = append(errs, fmt.Errorf("%s entry %q is only wildcards and would allow everything", field, v))
		}
	}

	return errs
}
