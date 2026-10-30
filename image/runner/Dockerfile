# The GitHub Actions runner image for the Fargate runners (grun).
#
# Moved here from truvity/ci-plane's image/runner. Left out on the way,
# because only Kubernetes runners use them: runner-watchdog (the ARC
# entrypoint wrapper) and nix-worker-client-setup (the remote-builder
# bootstrap). Everything else is unchanged: same base, packages, user and
# tool versions.
#
# The image contains ONLY what devbox cannot deliver: the bootstrap (nix +
# devbox), pre-devbox shell semantics (bash as sh), binaries outside nixpkgs
# (the runner, license-gated; the Go cache plugin, which must pre-exist any
# go invocation it caches), the docker client and buildx (daemonless, the
# daemon never ships), git-lfs (actions/checkout `lfs: true` needs it before
# any devbox exists) and gh (hosted runners ship it, and release automation
# runs it before devbox). EVERYTHING else (aws, kubectl, helm, toolchains)
# arrives per job from the repository's own devbox.json through the nix
# cache. Repository-specific or deployment-specific content in this image is
# a bug. The nix substituter list near the bottom is a build ARG
# (NIX_SUBSTITUTERS) naming only the public upstream; a cache in front of it
# is a deploy-time choice (NIX_CONFIG in the task environment beats this
# file), made without a rebuild.
#
# Multi-arch: .github/workflows/release.yaml builds it natively per
# architecture on a v* tag and publishes the manifest list as
# ghcr.io/truvity/grun/runner:<tag>. The build context is image/runner/.
#
# Releases are TAG-GATED: renovate keeps the pins below current and
# automerges, but nothing publishes until a v* tag. A patch tag on an
# unchanged Dockerfile is the legitimate "pure refresh" release (base image
# and CVE pickup). EVERY version ARG here needs a `# renovate:` line
# directly above it; a pin without one is invisible, and invisible is
# indistinguishable from current.

# PINNED, annotated (it replaced a `latest` exception): `latest` was
# invisible to renovate, so upstream runner (and its CVE) pickups
# happened only as a side effect of some OTHER image change. Pinned +
# annotated, renovate bumps it, automerge lands it, and the next tag
# ships it. The runner version also bounds how long a runner is
# accepted by GitHub, so the pin must not lag upstream.
# renovate: datasource=docker depName=ghcr.io/actions/actions-runner
ARG RUNNER_VERSION=2.338.1

# The nix substituter list baked into the image: the public upstream only,
# so the image names nothing cluster-shaped. An in-cluster cache is set at
# deploy time through NIX_CONFIG in the task environment (no rebuild); a
# build for another deployment may override the ARG instead. Name the FULL list
# -- the `extra-` form appends to nix's default and a cache listed there
# is then never chosen.
ARG NIX_SUBSTITUTERS="https://cache.nixos.org/"

# PINNED, and it must MATCH the nix version of truvity/ci-plane's
# image/nix-worker/Dockerfile (the remote builders) exactly.
#
# Remote building is a protocol between two nix installations. While one
# manifest served both the runner and the worker they matched by
# construction -- but nothing pinned them: the installer was fetched from
# nixos.org/nix/install, whatever that served that day. Now that the
# worker is its own image, two builds on different days would drift
# silently, and a drift shows up as a confusing build failure rather than
# as a version error. hack/nix-parity.sh refuses a release where the two
# disagree.
# renovate: datasource=github-releases depName=NixOS/nix
ARG NIX_VERSION=2.35.2

# ── go-cache-plugin: built from source (upstream publishes no binary
# releases). CROSS-compiled on the build platform: the previous form
# ran the arm64 half under QEMU, and that one emulated `go install`
# was 841s of the 18.5-minute image build (v1.0.1 measurement) vs
# 139s native. CGO is off, so Go cross-compiles for free. Version
# pinned — @latest in a Dockerfile is unrepeatable supply chain.
# renovate: datasource=docker depName=golang
FROM --platform=$BUILDPLATFORM golang:1.27 AS gocache
ARG TARGETARCH
# Built through a throwaway wrapper module, NOT `go install ...@v0.1.1`:
# v0.1.1 ships creachadair/atomicfile v0.3.7, whose WriteAll renamed the
# half-written temp file into place when its reader failed. A CI run
# cancelled while the proxy faulted a module in from S3 left a truncated
# zip in the local cache, which was then served with HTTP 200 -- every run
# failed `zip: not a valid zip file` (2026-09-13). atomicfile v0.4.2 aborts
# the write instead. Upstream has fixed this on master (3031b5d) but not
# tagged a release, so the commit is pinned. Master also pulls a
# go-json-experiment that does not compile on Go 1.27, hence the second
# pin. Return to a plain tag once upstream tags a release after 3031b5d
# (then restore a `# renovate: datasource=github-tags` annotation; the
# regex custom manager for `go install` cannot see this form, on purpose:
# a commit pin must not be bumped by a bot).
# The json pin is the commit (go resolves it to the pseudo-version).
# go build, unlike go install, takes -o, so no GOBIN/linux_$GOARCH dance.
RUN mkdir -p /out /w && cd /w \
 && go mod init gocacheplugin \
 && CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH \
    go get \
      github.com/tailscale/go-cache-plugin/cmd/go-cache-plugin@3031b5d01c50 \
      github.com/go-json-experiment/json@c27c302e5fc3 \
 && CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH \
    go build -trimpath -o /out/go-cache-plugin \
      github.com/tailscale/go-cache-plugin/cmd/go-cache-plugin

# ── the runner ──
FROM ghcr.io/actions/actions-runner:${RUNNER_VERSION}
ARG GORELEASER_VERSION

USER root

# devbox/moon hooks assume bash semantics; upstream sh
# is dash. xz: the nix installer unpacks an .xz tarball and the minimal
# base ships without it.
#
# ca-certificates is upgraded explicitly, and the build refuses a bundle
# older than 20260816ubuntu0.24.04.1 (USN-8944-1): that release drops
# "emSign ECC Root CA - G3" after the eMudhra/emSign intermediate CA key
# compromise (2026-10-23). The base image may carry an older bundle than
# the archive offers; nothing here may rely on it being current.
RUN ln -sf /bin/bash /bin/sh \
 && apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends openssh-server tini xz-utils \
 && apt-get install -y -qq --only-upgrade ca-certificates \
 && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' ca-certificates)" ge 20260816ubuntu0.24.04.1 \
 && rm -rf /var/lib/apt/lists/*

# goreleaser-pro is deliberately ABSENT: the Pro EULA's no-distribution
# clause covers the binary even without the key, and this image is
# public. Consumers install it job-time on their own runners — through
# their own tool pins, or release-private's install-goreleaser-pro
# input (ci-workflows v2.13.1).

# The ci-cache agent used to be copied in here beside the plugin, and is
# gone. The image carried two Go cache clients while the choice between them
# was open, and measurement decided against the agent: it costs
# about a second over Go's own GOCACHE, and what actually caps a build's
# fetch rate is `-p` -- how many packages compile at once, hence how many
# lookups are in flight -- at roughly 16 MB/s per CPU. No cache client
# moves that number. The server it talked to was retired as well.
#
# Dropping it is worth more than the ~39MB: every agent bump cost a
# release and a rollout of every runner for a binary no job was using.
#
# Safe because the refusal that used to greet a missing binary is gone.
# ci-actions' setup-devbox now WARNS on `go-cache-server` and falls
# through to the bucket (released before this) rather than
# failing with "ci-cache not on PATH -- runner image too old". That
# ordering is the whole risk here: pins move on their own schedule, not
# this repository's, so a caller on an old pin has to degrade, not break.
#
# go-cache-plugin below is now the only Go cache client in the image,
# and it stays until setup-devbox fetches it from the ci-cache release
# -- after which the image carries no cache client at all.
COPY --from=gocache /out/go-cache-plugin /usr/local/bin/go-cache-plugin

# The entrypoint prefix for a runner given extra CA certificates: at
# container start it makes the CA certificates mounted at $CI_EXTRA_CA_DIR
# trusted, then execs the runner. In the image, not delivered per job,
# because it must run before ANY job step does a TLS fetch (including the
# nix and devbox ones), and the image carries no CA of its own: the
# certificates arrive at runtime, from the deployment. A plain script with no
# dependency beyond bash, hence no stage above.
COPY --chmod=0755 runner-extra-ca.sh /usr/local/bin/runner-extra-ca

# docker client + buildx plugin (daemonless: CLIENT ONLY, builds go to
# the shared rootless builders over --driver remote). Static binaries,
# arch-explicit; buildx lands on the system-wide plugin path so no
# per-job symlink into ~/.docker is needed.
# The Docker Hub `docker` image is versioned identically to the CLI, so
# it tracks these static tarballs exactly; moby/moby publishes no
# matching release tag. semver versioning so the -dind / -windowsservercore
# tags are read as prereleases and ignored.
# renovate: datasource=docker depName=docker versioning=semver
ARG DOCKER_VERSION=29.8.0
# renovate: datasource=github-releases depName=docker/buildx
ARG BUILDX_VERSION=v0.38.1
RUN ARCH=$(dpkg --print-architecture) \
 && DOCKER_ARCH=$([ "$ARCH" = "arm64" ] && echo aarch64 || echo x86_64) \
 && curl -fsSL -o /tmp/docker.tgz "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-${DOCKER_VERSION}.tgz" \
 && tar -xz -C /tmp -f /tmp/docker.tgz docker/docker \
 && mv /tmp/docker/docker /usr/local/bin/docker \
 && rm -rf /tmp/docker /tmp/docker.tgz \
 && mkdir -p /usr/local/lib/docker/cli-plugins \
 && curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-buildx "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-${ARCH}" \
 && chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx \
 && docker --version \
 && docker buildx version

# git-lfs: part of git, not a tool. The base ships git but not git-lfs,
# while GitHub-hosted runners ship both, so `actions/checkout` with
# `lfs: true` fails here with "Unable to locate executable file: git-lfs"
# (a release job of a repository using LFS). actions/checkout runs
# `git lfs` as an external executable before any devbox environment
# exists, which is why devbox cannot deliver it. Static release binary,
# arch-explicit, verified against that release's own sha256sums.asc in
# the same build (same shape as sluisctl below; the file's names carry a
# leading `*`). `git lfs install --system` writes the clean/smudge/process
# filters to /etc/gitconfig, so every user and every checkout gets them,
# as on hosted runners.
# renovate: datasource=github-releases depName=git-lfs/git-lfs
ARG GIT_LFS_VERSION=v3.8.1
RUN ARCH=$(dpkg --print-architecture) \
 && F="git-lfs-linux-${ARCH}-${GIT_LFS_VERSION}.tar.gz" \
 && cd /tmp \
 && curl -fsSLO "https://github.com/git-lfs/git-lfs/releases/download/${GIT_LFS_VERSION}/sha256sums.asc" \
 && curl -fsSLO "https://github.com/git-lfs/git-lfs/releases/download/${GIT_LFS_VERSION}/${F}" \
 && awk -v f="*${F}" '$2 == f' sha256sums.asc | grep . | sha256sum -c - \
 && tar -xzf "${F}" --strip-components=1 --wildcards '*/git-lfs' \
 && install -m 0755 git-lfs /usr/local/bin/git-lfs \
 && rm -f sha256sums.asc "${F}" git-lfs \
 && git lfs install --system \
 && git lfs version \
 && git config --system --get filter.lfs.clean \
 && git config --system --get filter.lfs.smudge \
 && git config --system --get filter.lfs.process

# gh, the GitHub CLI: part of the GitHub toolchain the runner is a client
# of, not a tool devbox should deliver. GitHub-hosted runners ship it, and
# the shared `auto-release` action (truvity/ci-actions) runs bash, git and
# `gh` before any devbox environment exists, so a job that needs it has no
# earlier moment to get it from; callers had worked around the gap one
# repository at a time. Static release binary, arch-explicit, installed
# at build time into /usr/local/bin (nothing is installed at job time and
# nothing needs root), verified against that release's own
# gh_<version>_checksums.txt in the same build (same shape as sluisctl
# below; the awk matches the whole file name, because the checksums file
# also lists the .deb and .rpm of each architecture). `grep .` fails the
# build on no match. The token is the job's (GH_TOKEN); the image holds none.
# renovate: datasource=github-releases depName=cli/cli
ARG GH_VERSION=2.103.3
RUN ARCH=$(dpkg --print-architecture) \
 && F="gh_${GH_VERSION}_linux_${ARCH}.tar.gz" \
 && cd /tmp \
 && curl -fsSLO "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" \
 && curl -fsSLO "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${F}" \
 && awk -v f="${F}" '$2 == f' "gh_${GH_VERSION}_checksums.txt" | grep . | sha256sum -c - \
 && tar -xzf "${F}" --strip-components=2 "gh_${GH_VERSION}_linux_${ARCH}/bin/gh" \
 && install -m 0755 gh /usr/local/bin/gh \
 && rm -f "gh_${GH_VERSION}_checksums.txt" "${F}" gh \
 && gh --version

# devbox binary (its packages come per job, from the repo's devbox.json).
# Straight from the GitHub release with explicit arch: the official
# installer both insists on sudo (which the base's sudoers config
# refuses even for root) and downloads an arch-opaque URL — useless
# under a QEMU multi-arch build.
# renovate: datasource=github-releases depName=jetify-com/devbox
ARG DEVBOX_VERSION=0.18.5
RUN ARCH=$(dpkg --print-architecture) \
 && curl -fsSL -o /tmp/devbox.tgz "https://github.com/jetify-com/devbox/releases/download/${DEVBOX_VERSION}/devbox_${DEVBOX_VERSION}_linux_${ARCH}.tar.gz" \
 && tar -xz -C /usr/local/bin -f /tmp/devbox.tgz devbox \
 && rm /tmp/devbox.tgz \
 && devbox version

# sluisctl (truvity/sluis's CLI). Jobs call it directly (token exchange,
# OpenBao secrets) through truvity/ci-actions, and an
# AWS `credential_process` line can name it so
# the Go build cache's S3-compatible client reads a short-lived R2
# credential instead of a static key in a Secret: `sluisctl cloudflare
# r2 <preset>` (sluis's Cloudflare module mints the credential, no
# broker in between; see docs/architecture.md).
#
# BAKED, same reasoning as go-cache-plugin above: the credential_process
# the AWS SDK execs is invoked BY that client, which already has to
# pre-exist the first `go` invocation of a job -- so whatever it in turn
# execs has to pre-exist it too. A job that never names sluisctl leaves
# it idle on PATH.
#
# Verified against that release's own checksums.txt rather than a
# hand-pinned digest (contrast ci-plane's image/nix-worker/Dockerfile opkssh,
# hand-maintained because ITS upstream ships no per-release checksums
# file): a Renovate version bump here downloads the NEW release's
# checksums.txt in the same build, so the version pin and its checksum
# can never desync the way two separately hand-maintained values could.
# The checksum line is matched on the whole file name (awk, not grep -F):
# sluis's checksums.txt also lists each archive's `.sbom.spdx.json`, whose
# name a substring match catches too, and `sha256sum -c` then fails on a
# file that was never downloaded. `grep .` fails the build on no match.
#
# renovate: datasource=github-releases depName=truvity/sluis
ARG SLUISCTL_VERSION=1.79.4
RUN ARCH=$(dpkg --print-architecture) \
 && cd /tmp \
 && curl -fsSLO "https://github.com/truvity/sluis/releases/download/v${SLUISCTL_VERSION}/checksums.txt" \
 && curl -fsSLO "https://github.com/truvity/sluis/releases/download/v${SLUISCTL_VERSION}/sluisctl_${SLUISCTL_VERSION}_linux_${ARCH}.tar.gz" \
 && awk -v f="sluisctl_${SLUISCTL_VERSION}_linux_${ARCH}.tar.gz" '$2 == f' checksums.txt | grep . | sha256sum -c - \
 && tar -xzf "sluisctl_${SLUISCTL_VERSION}_linux_${ARCH}.tar.gz" sluisctl \
 && install -m 0755 sluisctl /usr/local/bin/sluisctl \
 && rm -f checksums.txt "sluisctl_${SLUISCTL_VERSION}_linux_${ARCH}.tar.gz" sluisctl \
 && sluisctl --version

# The nixbld accounts are what a multi-user nix daemon builds as; kept
# from the days this manifest also served the Nix workers (split into
# image/nix-worker on 2026-09-24), because the single-user install below
# has always run with them present. v5.0.0 removed the rest of that
# worker role from this image -- the `nixremote` login, sshd's config and
# the worker scripts -- together with the chart's fallback that could
# still run a worker on it.
RUN groupadd --system nixbld \
 && for i in $(seq 1 32); do \
      useradd --system --gid nixbld --home-dir /var/empty \
        --shell /usr/sbin/nologin "nixbld${i}"; \
    done \
 && nixbld_members=$(for i in $(seq 1 32); do printf 'nixbld%s,' "$i"; done) \
 && gpasswd -M "${nixbld_members%,}" nixbld

USER runner
# Docker's USER directive sets the uid, not the environment — nix's
# profile install resolves the profile dir from $USER/$HOME and dies
# with "unable to install Nix into your default profile" without them.
ENV USER=runner \
    HOME=/home/runner

# Single-user nix owned by the runner user (no daemon — containers have
# no systemd; the official installer's --no-daemon mode is the proven
# in-image shape). Substituters: cache.nixos.org by default; a cache in
# front of it (the cache-redirect `/nix` front-end) is set through
# NIX_CONFIG in the task environment, which lists it first. A cache down = slower,
# never broken, because upstream stays in the list.
#
# `substituters`, NOT `extra-substituters`: the extra- form APPENDS to
# nix's default (cache.nixos.org), so a cache named there would be listed
# after upstream. Order alone is not enough either: nix ranks substituters
# by the Priority in each nix-cache-info, and cache-redirect advertises a
# Priority below upstream's 40 (`cacheRedirect.nix.priority`).
#
# The S3 push cache is retired with this — and with it the
# require-sigs=false it forced: everything now originates upstream,
# whose narinfo signatures pass through the proxy intact and verify
# against nix's default trusted key.
# Re-declared INSIDE the stage: an ARG before the first FROM is global and
# is NOT in scope in a build stage until named again. Without this line
# ${NIX_SUBSTITUTERS} expands to empty and the image ships
# `substituters = `, which is not a fallback to upstream -- it is NO
# substituter at all, and every job builds the world from source. Same
# pattern as ARG GORELEASER_VERSION after the FROM above. No default here,
# so the value comes from the global ARG or the caller's --build-arg.
ARG NIX_SUBSTITUTERS
ARG NIX_VERSION
RUN sh <(curl -fsSL "https://releases.nixos.org/nix/nix-${NIX_VERSION}/install") --no-daemon \
 && mkdir -p /home/runner/.config/nix \
 && printf '%s\n' \
      'experimental-features = nix-command flakes' \
      "substituters = ${NIX_SUBSTITUTERS}" \
      > /home/runner/.config/nix/nix.conf

ENV PATH="/home/runner/.nix-profile/bin:/nix/var/nix/profiles/default/bin:${PATH}"
