# Changelog

Tags `vX.Y.Z` version the repository. The Go module
`github.com/truvity/grun/boundary` is versioned by its own tags,
`boundary/vX.Y.Z`.

## boundary/v0.1.0

- Add `github.com/truvity/grun/boundary`, a standard-library-only Go module that
  renders the stack's IAM permissions boundaries from parameters:
  `Runtime` (the stack's own roles; the document an earlier tool rendered,
  moved unchanged, minus the estate guards the caller appends) and
  `Deploy` (the CDK bootstrap roles: an allow list that can create the stack's
  resources and the roles bounded by the Runtime boundary, and nothing more in
  IAM). `DeployCoverage` reports the services and CloudFormation resource types
  the Deploy boundary covers.
- Each document is held to 5,000 characters minified, leaving room under IAM's
  6,144 for the caller's guards; the constructors return an error beyond it.
- Add a drift guard: `just boundary-coverage` writes the Deploy boundary's
  coverage and `cdk/test/boundary-drift.test.ts` fails when the synthesised
  stack has a resource type the boundary does not cover.
- README: "Permissions boundaries".
