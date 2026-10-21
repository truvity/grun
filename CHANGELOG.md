# Changelog

Tags `vX.Y.Z` version the repository. The Go module
`github.com/truvity/grun/boundary` is versioned by its own tags,
`boundary/vX.Y.Z`.

## boundary/v0.2.0

- **Breaking: `Runtime` and `Deploy` return `policy.Document` of `github.com/truvity/aws-structure/policy` (v0.1.0).** The package's own loosely typed `Document` and `Statement` (their fields were `any`) are gone, and with them `Document.JSON()`: marshal with `json.Marshal`, which is canonical, minified and the same bytes as before. `Document.Size()` is now `policy.Document.Size()`, and `Validate()` is new. The module's only dependency is the policy module, which has none of its own; the package still has no AWS SDK or infrastructure-tool dependency.
- The documents are byte for byte what v0.1.0 rendered: the golden files are untouched, and the test that `Runtime` plus the estate's two guards equals the earlier tool's document still passes. `MaxComponentSize`, `GuardReserve`, `MaxSize`, `DeployCoverage` and the drift guard are unchanged. A new test validates both documents.

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
