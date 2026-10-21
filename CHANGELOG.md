# Changelog

Tags `vX.Y.Z` version the repository. The Go module
`github.com/truvity/grun/boundary` is versioned by its own tags,
`boundary/vX.Y.Z`.

## Unreleased

- **Fix: a failed runner image build alerts through EventBridge, not CodeStar Notifications.** The library's `failedImageBuildsTopic` is an `AWS::CodeStarNotifications::NotificationRule`, whose creation races that service's service-linked role on a fresh account ("Invalid request provided: AWS::CodeStarNotifications::NotificationRule") and failed the first deploy into one. The stack now has an EventBridge rule on the image builder's CodeBuild project (`CodeBuild Build State Change`, `FAILED`, `FAULT` or `TIMED_OUT`; a stopped build is somebody's decision) that publishes a readable message (project, build id, status, log link) to the alerts topic, which now allows `events.amazonaws.com` to publish. This replaces the second topic (`Failed Runner Image Builds`), its email subscriptions (one confirmation mail per address instead of two) and the unused AWS Image Builder filter function the library added with it. The template has no CodeStar Notifications rule any more; the Deploy boundary still allows the service-linked role and can drop it in a later `boundary/v*` release.
- **Add `orgs[].runnerGroup`.** The GitHub runner group an organisation's runners register in (the library's provider `group`); absent, the organisation's default group, as before. The group's repository access then limits which repositories the runners serve, which is how a tier is piloted on one repository. The group must exist in GitHub before the first job. Tests: the schema, and the organisation's state machine names the group while another organisation's does not.
- README: "Runner groups and labels" says why two stacks in one organisation need shape labels of their own (the labels are the only routing between them) and how the group and the App's installation limit a tier.
- **Fix: the daily budget no longer asks for a forecast.** AWS refuses a `DAILY` budget with a `FORECASTED` notification at create time ("DAILY budget only supports notification type as ACTUAL"), which `cdk synth` cannot see; the first deploy failed there. `grun-<env>-daily` now notifies at 80 % and 100 % of the actual spend only. Two ordering fixes ride with it: the budget is created after the topic policy that lets Budgets publish (Budgets checks it at create time, and the budget only referenced the topic), and before the API Gateway custom domains, so a budget that is rejected fails while nothing slow exists. Before, the rollback met mutual TLS domains that were still updating and could not delete them ("There is already an update in progress for the domain"), leaving the stack in `ROLLBACK_FAILED`.
- **Config: two more create-time rules checked at load.** A shape's memory must go with its vCPU as Fargate lists them (ECS refuses the task definition otherwise), and a webhook certificate must be in the stack's region and the domain name a lowercase DNS name (API Gateway refuses the regional custom domain otherwise).
- Tests for rules AWS enforces at create time and `cdk synth` does not: no `FORECASTED` on a `DAILY` budget, the Budgets notification and subscriber limits, the budget's dependencies, the mutual TLS domain (regional, TLS 1.2, truststore, base path mapping), email subscriptions, the Arm CodeBuild compute type, log retention values (and every value the schema allows), DynamoDB billing mode, queue visibility timeout against the function timeout, alarm datapoints, and the 4 KB Lambda environment.
- **Add `cdk.qualifier`.** The CDK qualifier of the bootstrap the stack deploys through, set as the `DefaultStackSynthesizer` qualifier of the stack: its assets, publishing roles and bootstrap-version parameter become `cdk-<qualifier>-*` and `/cdk-bootstrap/<qualifier>/version`. 1 to 10 lowercase letters and digits; the default is CDK's own, `hnb659fds`, so a configuration without it synthesizes what it did before. It must be the qualifier the account was bootstrapped with and the `Qualifier` the Deploy boundary was rendered with. Tests: the synthesized stack and its asset manifest carry the qualifier; the schema accepts only the CDK shape.
- README: "Permissions boundaries" no longer claims that plain `cdk bootstrap --custom-permissions-boundary` bounds the bootstrap roles. Bootstrapping is the estate's job (the roles must all carry the Deploy boundary, qualifier matching `cdk.qualifier`); the README says what is required, with a generic example.

## boundary/v0.2.1

- **Fix: the Deploy boundary lets CloudFormation create the API Gateway service-linked role.** A custom domain with mutual TLS (`AWS::ApiGateway::DomainName`) makes API Gateway create `AWSServiceRoleForAPIGateway` (service `ops.apigateway.amazonaws.com`) the first time one exists in an account; with only the ECS and CodeStar Notifications roles allowed, the first deploy into a fresh account failed there with "Caller does not have permissions to create a Service Linked Role". The allow-list is now `codestar-notifications`, `ecs` and `ops.apigateway`, each with the resource type that needs it in a comment; the audit of the synthesized stack found no other type that creates one.
- `iam:CreateServiceLinkedRole` is now scoped to `role/aws-service-role/*` instead of every resource, still only for the listed `iam:AWSServiceName` values. The size grows by about 100 characters, well inside `MaxComponentSize`.
- **Drift guard for service-linked roles.** `Coverage` gains `ServiceLinkedRoles` (read from the rendered document) and `NeedsServiceLinkedRole` (a table in the package of the resource types that create a service-linked role, and its service). `cdk/test/boundary-drift.test.ts` fails when a resource type of the synthesized stack needs a role the boundary does not allow, so the next such type cannot repeat this at deploy time; a Go test fails on an allowed role that no type in the table needs.

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
