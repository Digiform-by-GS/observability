# Sandbox for one onboarding job. Disposable: created per job, destroyed after.
#
# It clones the client's repository but NEVER executes its code — it does not
# run the app, and it does not run anything from the dependency tree. The
# onboard skill's work is a source transformation (edit package.json, add the
# preload flag, rewrite main()), so executing the client's code buys nothing,
# and a plain `npm install` would be arbitrary remote code execution via
# postinstall scripts, one hop from the shared observability platform.
# Verification stays on the client side, where running their own app is
# unremarkable.
#
# Two narrow exceptions exist, both non-executing, both earned by a defect that
# reached a client. `go build`/`go mod tidy` (see below), and exactly two npm
# forms: `npm install --package-lock-only --ignore-scripts` and
# `npm ci --dry-run`. Neither writes node_modules or runs a lifecycle script,
# but both resolve the dependency tree — which is the only way for the agent to
# discover that the version it picked is stale or that its package.json change
# has desynced the lockfile. Both of those shipped to a client unnoticed. The
# allowlist in run-job.sh matches these by exact flag prefix, never `npm:*`.
# BUILD CONTEXT IS THE REPO ROOT, not this directory — the image bakes in the
# plugin, which lives at the root. Build with:
#   docker build -f services/onboarding-agent/runner/Dockerfile -t digiform/onboarding-runner:dev .
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl jq \
 && rm -rf /var/lib/apt/lists/*

# Go toolchain. Required, not optional: unlike Node — where adding a dependency
# is a text edit to package.json and npm resolves it later — Go bakes resolution
# into the tool. Adding a module means downloading it, hashing it, and writing
# the checksum to go.sum, and Go refuses to build without those entries. Without
# a toolchain here the agent cannot add a Go dependency at all; the first real Go
# repo it saw, it worked around the gap by hand-rolling instrumentation from
# packages already in the tree.
#
# This is a much smaller grant than it first appears. `npm install` executes
# arbitrary postinstall scripts; `go mod tidy` and `go get` execute nothing —
# they download, verify checksums, and read source to see what is imported.
# Checksum verification against sum.golang.org stays on.
ENV GO_VERSION=1.26.5
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
      | tar -C /usr/local -xz \
 && /usr/local/go/bin/go version
ENV PATH="/usr/local/go/bin:${PATH}" \
    GOTOOLCHAIN=auto \
    GOFLAGS=-mod=mod

# The agent itself.
RUN npm install -g @anthropic-ai/claude-code@2.1.76

# The onboarding plugin is baked in rather than fetched from the marketplace at
# run time: the runner image and the skills it runs are then versioned together,
# and a job cannot be broken by a marketplace change mid-flight.
COPY plugin /opt/observability-plugin/plugin
COPY .claude-plugin /opt/observability-plugin/.claude-plugin

COPY services/onboarding-agent/runner/run-job.sh /usr/local/bin/run-job
RUN chmod +x /usr/local/bin/run-job

# Unprivileged: the job has no reason to be root, and the clone is untrusted.
#
# /home/runner/go/pkg/mod is created here, not merely mounted at runtime:
# docker creates a named-volume mount point as root:root when the path is
# absent from the image, because there is no ownership for it to inherit, and
# the non-root runner then cannot write the module cache. Same trap as the
# artifact bind mount and the /work tmpfs, in a third disguise.
RUN useradd -m -u 10001 runner \
 && mkdir -p /work /out /home/runner/go/pkg/mod /home/runner/.cache /home/runner/.npm \
 && chown -R runner:runner /work /out /home/runner
# HOME must be set explicitly. Docker does NOT derive it from /etc/passwd
# when USER changes - it stays /root, which the runner cannot write. Go never
# hit this because GOPATH/GOCACHE/GOMODCACHE are absolute, but npm resolves
# its cache from HOME and would fail on /root/.npm with EACCES. Fourth
# appearance of the same ownership trap. npm_config_cache is belt-and-braces
# so a future HOME change cannot silently break the lockfile step.
ENV HOME=/home/runner \
    GOPATH=/home/runner/go \
    GOCACHE=/home/runner/.cache/go-build \
    GOMODCACHE=/home/runner/go/pkg/mod \
    npm_config_cache=/home/runner/.npm
# Build provenance. Without this an image has no identity beyond its tag, and a
# stale runner is indistinguishable from a current one - which is exactly how a
# runner built before the compat manifest and the browser skill existed stayed
# in service, silently onboarding clients with the defects those changes fixed.
# Image creation date is not a substitute: it says when `docker build` ran, not
# which source it ran against.
#
# Last, deliberately: an ARG invalidates every layer below it, and this value
# changes on every commit.
ARG GIT_SHA=unknown
ENV OBS_RUNNER_REVISION=${GIT_SHA}
LABEL org.opencontainers.image.revision=${GIT_SHA}

USER runner
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/run-job"]
