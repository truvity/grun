// Command boundary-services writes the Deploy boundary's coverage (the IAM
// namespaces it allows and the CloudFormation resource types they cover) as
// JSON. The CDK app's test reads it, so a stack change cannot outgrow the
// boundary unnoticed. The coverage does not depend on any name, so the
// parameters are synthetic.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/truvity/grun/boundary"
)

func main() {
	out := flag.String("o", "", "write the JSON to this file (default: standard output)")
	flag.Parse()

	if err := run(*out); err != nil {
		fmt.Fprintln(os.Stderr, "boundary-services:", err)
		os.Exit(1)
	}
}

func run(out string) error {
	c, err := boundary.DeployCoverage(boundary.Params{
		RolePrefix: "grun-", RuntimeBoundaryName: "example-runtime", Qualifier: "hnb659fds",
	})
	if err != nil {
		return err
	}

	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal coverage: %w", err)
	}

	b = append(b, '\n')

	if out == "" {
		_, err = os.Stdout.Write(b)

		return err
	}

	return os.WriteFile(out, b, 0o644) //nolint:gosec // a generated, non-secret file
}
