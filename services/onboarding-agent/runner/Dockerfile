# Sandbox for one onboarding job. Disposable: created per job, destroyed after.
#
# It clones the client's repository but NEVER executes its code — no npm
# install, no go build, no running the app. The onboard skill's work is a
# source transformation (edit package.json, add the preload flag, rewrite
# main()), so execution buys nothing and `npm install` alone would be arbitrary
# remote code execution via postinstall scripts, one hop from the shared
# observability platform. Verification stays on the client side, where running
# their own app is unremarkable.
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
 && mkdir -p /work /out /home/runner/go/pkg/mod /home/runner/.cache \
 && chown -R runner:runner /work /out /home/runner
ENV GOPATH=/home/runner/go \
    GOCACHE=/home/runner/.cache/go-build \
    GOMODCACHE=/home/runner/go/pkg/mod
USER runner
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/run-job"]
