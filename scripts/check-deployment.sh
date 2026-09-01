#!/usr/bin/env bash
# Reports drift between what this host is RUNNING and what the repository says
# it should be running. Run it on the platform host.
#
#   ./scripts/check-deployment.sh          # report
#   ./scripts/check-deployment.sh --quiet  # exit code only, for cron
#
# Why this exists: the platform sat 17 commits behind on a stale branch, and the
# onboarding runner image predated the compat manifest and the browser skill
# entirely - so it was still onboarding clients with the defects those changes
# fixed. Nothing anywhere reported either condition. Both were found by hand,
# late, and only because someone happened to look.
#
# Every check here answers "is the deployed thing the same as the source thing",
# because that question has no other answer on this host. A container that is Up
# tells you nothing about which version it is running.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

DRIFT=0

say() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }
ok()   { say "  [ok]    $*"; }
warn() { say "  [DRIFT] $*"; DRIFT=1; }

say "=== repository ==="

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  say "  [skip]  not a git checkout"
else
  git fetch origin --quiet 2>/dev/null
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  LOCAL="$(git rev-parse HEAD)"
  REMOTE="$(git rev-parse origin/main 2>/dev/null || echo '')"

  if [ "$BRANCH" != "main" ]; then
    # This is how the platform ended up 17 commits behind: it was left on a
    # feature branch after a deploy, and `git pull` there keeps reporting
    # success while main moves on without it.
    warn "on branch '$BRANCH', not main"
  else
    ok "on main"
  fi

  if [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
    BEHIND="$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo '?')"
    warn "$BEHIND commit(s) behind origin/main"
    [ "$QUIET" -eq 1 ] || git log --oneline "HEAD..origin/main" | head -5 | sed 's/^/            /'
  else
    ok "up to date with origin/main"
  fi
fi

say ""
say "=== onboarding runner image ==="

RUNNER_IMAGE="$(docker inspect onboarding-agent \
  --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
  | sed -n 's/^RUNNER_IMAGE=//p' | head -1)"
RUNNER_IMAGE="${RUNNER_IMAGE:-digiform/onboarding-runner:dev}"

if ! docker image inspect "$RUNNER_IMAGE" >/dev/null 2>&1; then
  say "  [skip]  $RUNNER_IMAGE not present on this host"
else
  IMAGE_REV="$(docker image inspect "$RUNNER_IMAGE" \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)"

  if [ -z "$IMAGE_REV" ] || [ "$IMAGE_REV" = "unknown" ] || [ "$IMAGE_REV" = "<no value>" ]; then
    # Pre-dates the build stamp. Cannot be compared, which is the whole problem.
    warn "$RUNNER_IMAGE carries no build revision - rebuild it to make this checkable"
  elif ! git cat-file -e "${IMAGE_REV}^{commit}" 2>/dev/null; then
    warn "$RUNNER_IMAGE was built from $IMAGE_REV, which is not in this repository"
  else
    # Only these paths go into the image, so only changes to them make it stale.
    STALE="$(git log --oneline "${IMAGE_REV}..HEAD" -- \
      services/onboarding-agent/runner/ plugin/ 2>/dev/null)"
    if [ -n "$STALE" ]; then
      warn "runner image is stale - built at ${IMAGE_REV:0:8}, missing:"
      [ "$QUIET" -eq 1 ] || printf '%s\n' "$STALE" | head -5 | sed 's/^/            /'
      say "            rebuild: docker build -f services/onboarding-agent/runner/Dockerfile \\"
      say "                       --build-arg GIT_SHA=\$(git rev-parse HEAD) -t $RUNNER_IMAGE ."
    else
      ok "runner image current (${IMAGE_REV:0:8})"
    fi
  fi
fi

say ""
say "=== running containers vs config on disk ==="

# A bind-mounted config edited after a container started is live on disk and
# stale in the process. `docker compose restart` does not fix a port change
# either - only a recreate does - so this reports rather than guesses.
CONFIGS="docker-compose.yml docker-compose.platform.yml
infra/otel-collector/config.platform.yaml
infra/grafana/provisioning/dashboards
infra/grafana/provisioning/alerting"

for svc in otel-collector grafana; do
  STARTED="$(docker inspect "$svc" --format '{{.State.StartedAt}}' 2>/dev/null)"
  if [ -z "$STARTED" ]; then
    say "  [skip]  container '$svc' not running"
    continue
  fi
  STARTED_EPOCH="$(date -d "$STARTED" +%s 2>/dev/null || echo 0)"
  NEWER=""
  for path in $CONFIGS; do
    [ -e "$path" ] || continue
    MTIME="$(find "$path" -newermt "@$STARTED_EPOCH" -print -quit 2>/dev/null)"
    [ -n "$MTIME" ] && NEWER="$NEWER $path"
  done
  if [ -n "$NEWER" ]; then
    warn "$svc started before config changed:$NEWER"
  else
    ok "$svc newer than its config"
  fi
done

say ""
if [ "$DRIFT" -eq 1 ]; then
  say "DRIFT DETECTED. To reconcile:"
  say "  git checkout main && git pull --ff-only origin main"
  say "  docker compose -f docker-compose.yml -f docker-compose.platform.yml up -d"
  say "  # plus the runner rebuild above, if it was flagged"
  exit 1
fi

say "deployment matches the repository"
exit 0
