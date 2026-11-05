# arc-runners

A Helm chart for GitHub Actions runners on Kubernetes with
[Actions Runner Controller](https://github.com/actions/actions-runner-controller)
(ARC): one `AutoscalingRunnerSet` per runner profile, with the runner image
this repository publishes (`image/runner/`).

Published by every `v*` tag of this repository, at the tag's version:

```sh
helm install arc-runners oci://ghcr.io/truvity/grun/charts/arc-runners \
  --version <version> --namespace <runner-namespace> -f values.yaml
```

The release stamps the digest of the runner image it has just pushed into the
chart's defaults (`runnerImage.digest`), so a chart version pins one image.

## What it renders

- An `AutoscalingRunnerSet` per entry of `scaleSets`, and the manager `Role`
  and `RoleBinding` the controller needs in the runner namespace (what the
  upstream `gha-runner-scale-set` chart creates). The CRs are rendered
  directly, so this chart does not follow the upstream chart's version
  stream. The controller and its CRDs are a separate install (the upstream
  `gha-runner-scale-set-controller` chart); `arcVersion` must equal the
  installed controller's version, or the controller deletes the sets.
- `NIX_CONFIG` for the runner, from an immutable, content-addressed
  `ConfigMap` (`nixConfig`, `nixCache.url`, per-set `extraNixConfig`).
- Optional: an AWS config profile with a `credential_process` line
  (`awsConfig`), projected ServiceAccount tokens, extra volumes and init
  containers, Nix's build sandbox per set (`scaleSets.<name>.nixSandbox`,
  [docs/nix-sandbox.md](docs/nix-sandbox.md)) with an admission fence
  (`nixSandbox.fence`), and the Pod Security `restricted` profile per set
  (`scaleSets.<name>.restricted`, [docs/restricted-runners.md](docs/restricted-runners.md)).
- The janitor `CronJob` (`janitor`), which deletes runners stranded by
  [actions/actions-runner-controller#4307](https://github.com/actions/actions-runner-controller/issues/4307)
  and releases runners wedged in deletion.

Every value is described in [values.yaml](values.yaml). Two have no default:
`githubConfigUrl` (the organization) and `controllerServiceAccount.namespace`
(where the controller is installed). The three default profiles
(`preview-large`, `preview-medium`, `preview-small`) are sized for a cloud
pool; delete them with `null` in `helm.values` (a string), because Argo CD
drops nulls from `helm.valuesObject`.

## Moving from truvity/ci-plane's chart

This chart is truvity/ci-plane's `arc-runners` 5.2.0
(`oci://ghcr.io/truvity/charts/arc-runners`), moved here when that
repository was archived. Values written for 5.2.0 render with no change,
with these differences:

- **The runner image** is `ghcr.io/truvity/grun/runner`, at the digest of
  the same release. It is the image ci-plane published, moved here, without
  `nix-worker-client-setup` (the remote-builder bootstrap). Its nix.conf
  lists only `https://cache.nixos.org/`; set `nixCache.url` for a cache in
  front of it.
- **`nixBuilders` (remote Nix builders) is gone.** `nixBuilders.enabled:
  false` is accepted; `enabled: true` or any other `nixBuilders` key fails
  the render with a message.
- **The release-wide NIX_CONFIG ConfigMap is named after its whole
  content.** It was named after `nixConfig` alone, so changing
  `nixCache.url` kept the name of an immutable ConfigMap and the apply was
  refused. A set with `extraNixConfig` or `nixSandbox` also gets a new
  name, and every scale set's `values-hash` now includes the ConfigMap's
  name. Both change once, on the move, and recycle each listener once; the
  runner pods are replaced anyway, because the image changes.
- **The chart version** follows this repository's tags, so it starts again
  below 5.2.0. Pin the version of `oci://ghcr.io/truvity/grun/charts/arc-runners`,
  not a range spanning both packages.

The packing label (`ci-plane.io/packing-group: runners`) keeps its name, so
runners of both charts pack onto the same nodes while an installation moves.

## Tests

`just chart-lint`, `chart-golden` (renders of `tests/cases/arc-runners/*`
against `tests/golden/arc-runners/*`, and every `tests/invalid/arc-runners/*`
refused for the reason its first line names), `chart-schema` (kubeconform),
`chart-janitor` (the janitor's script run against a stub kubectl) and
`chart-stamp` (the release's digest stamper). After a template change,
`just chart-golden-update` and review the diff.
