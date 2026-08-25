# Sandbox for one onboarding job. Disposable: created per job, destroyed after.
#
# It clones the client's repository but NEVER executes its code — no npm
# install, no go build, no running the app. The onboard skill's work is a
# source transformation (edit package.json, add the preload flag, rewrite
# main()), so execution buys nothing and `npm install` alone would be arbitrary
# remote code execution via postinstall scripts, one hop from the shared
# observability platform. Verification stays on the client side, where running
# their own app is unremarkable.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl jq \
 && rm -rf /var/lib/apt/lists/*

# The agent itself.
RUN npm install -g @anthropic-ai/claude-code@2.1.76

# The onboarding plugin is baked in rather than fetched from the marketplace at
# run time: the runner image and the skills it runs are then versioned together,
# and a job cannot be broken by a marketplace change mid-flight.
COPY plugin /opt/observability-plugin/plugin
COPY .claude-plugin /opt/observability-plugin/.claude-plugin

COPY runner/run-job.sh /usr/local/bin/run-job
RUN chmod +x /usr/local/bin/run-job

# Unprivileged: the job has no reason to be root, and the clone is untrusted.
RUN useradd -m -u 10001 runner && mkdir -p /work /out && chown runner:runner /work /out
USER runner
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/run-job"]
