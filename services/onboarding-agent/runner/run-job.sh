#!/usr/bin/env bash
# One onboarding job, start to finish, inside a disposable container.
#
#   clone (read-only) -> seed platform.json -> run the onboard skill headless
#   -> emit a patch -> optionally open a PR
#
# Everything it produces lands in /out: onboarding.patch, result.json, agent.log.
# Nothing from the client's repository is ever executed.
set -uo pipefail

OUT=/out
REPO_DIR=/work/repo
mkdir -p "$OUT"

: "${REPO_URL:?REPO_URL is required}"
: "${OTLP_ENDPOINT:?OTLP_ENDPOINT is required}"
: "${GRAFANA_URL:?GRAFANA_URL is required}"
MODE="${MODE:-patch}"
SERVICE_NAME="${SERVICE_NAME:-}"
TEAM="${TEAM:-}"
BASE_BRANCH="${BASE_BRANCH:-}"
BUDGET_USD="${BUDGET_USD:-2.00}"

fail() {
  jq -n --arg status failed --arg error "$1" \
    '{status:$status, error:$error}' > "$OUT/result.json"
  echo "FAILED: $1" >&2
  exit 1
}

# --- clone -------------------------------------------------------------------
# Shallow and single-branch: we only ever diff against the tip.
# GitHub and GitLab want different credential users in the clone URL:
# GitHub personal/app tokens go in as x-access-token, GitLab PATs as oauth2.
# Getting this wrong fails with a generic 403 that looks like a bad token.
case "${PROVIDER:-github}" in
  gitlab) CRED_USER=oauth2 ;;
  *)      CRED_USER=x-access-token ;;
esac

authed_url() {
  # $1 = plain https URL. Emits the same URL with credentials, or unchanged
  # when no token was supplied (public repositories).
  if [ -n "${GIT_TOKEN:-}" ]; then
    printf '%s' "$1" | sed -E "s#^https://#https://${CRED_USER}:${GIT_TOKEN}@#"
  else
    printf '%s' "$1"
  fi
}

CLONE_URL="$(authed_url "$REPO_URL")"

git clone --depth 1 ${BASE_BRANCH:+--branch "$BASE_BRANCH"} --single-branch \
  "$CLONE_URL" "$REPO_DIR" >"$OUT/clone.log" 2>&1 \
  || fail "clone failed — check the URL, the branch, and (for private repos) the token. See clone.log"

cd "$REPO_DIR" || fail "clone produced no directory"
git config user.email "onboarding-agent@digiform.local"
git config user.name "Digiform Onboarding Agent"
# Drop the credential-bearing remote immediately; the push step re-adds it.
git remote set-url origin "$REPO_URL"

BASE_SHA="$(git rev-parse HEAD)"

# --- platform config ----------------------------------------------------------
# Seeding this means the skill's Step 0 has nothing to ask a human about, which
# is the whole point of running it unattended.
mkdir -p .observability
jq -n --arg o "$OTLP_ENDPOINT" --arg g "$GRAFANA_URL" --arg p "${PYROSCOPE_URL:-}" \
  '{otlp_http:$o, grafana:$g} + (if $p == "" then {} else {pyroscope:$p} end)' \
  > .observability/platform.json

# --- the agent ----------------------------------------------------------------
PROMPT="Onboard the service in this repository onto the Digiform observability platform.

Use the observability-onboard plugin's 'onboard' skill and follow it exactly.

Context for this run:
- .observability/platform.json is already present; do not ask for endpoints.
- Service name: ${SERVICE_NAME:-choose one from the repository and say which you chose and why}
- Team attribute: ${TEAM:-omit if unknown}

Constraints for this environment:
- You are running unattended. Never ask questions; make the call the skill
  implies and record it in your summary.
- Do NOT run the application, and do NOT run npm/yarn/pnpm install. Those
  execute arbitrary postinstall scripts from the client's dependency tree,
  which is remote code execution on this host.
- You MAY run go commands, and for a Go project you MUST. Go bakes dependency
  resolution into the tool: adding a module means downloading it, hashing it,
  and writing the checksum into go.sum, and Go refuses to build without those
  entries. Editing go.mod alone produces a patch that cannot compile. Run
  go get for each module you add, then go mod tidy, and confirm go.sum ends up
  in the diff. Unlike npm, these commands execute nothing from the dependency
  tree.
- go build ./... is allowed and encouraged as a correctness check: it compiles
  the code but does not run the service. Do not run go test (test code is the
  client's own and does execute), and never start the application.
- Do NOT run the verify skill; there is no reachable app here. Say in your
  summary that the client should run it after applying the change.
- Change only what onboarding requires. No refactors, no formatting sweeps,
  no dependency upgrades beyond the observability library itself.
- If this repository has no service you can onboard — no Node or Go
  application, only docs, or an unsupported stack — then make NO changes at
  all and say so plainly in your summary. Reporting 'nothing to onboard' is a
  correct, expected outcome. Do NOT invent files, scaffolding, or config to
  show progress; an empty result the client can trust is worth more than a
  plausible-looking one they cannot.

Finish with a short summary: which files you changed, the service name you
used, and anything the client must do by hand."

set +e
# --plugin-dir must point at the PLUGIN directory - the one containing
# .claude-plugin/plugin.json - NOT its parent. The parent holds the
# marketplace manifest, and pointing there loads nothing, silently: the
# agent runs with no skills and no error is raised. Three onboarding
# attempts were burned on that before a probe asked the agent which
# skills it could see and it answered NONE.
claude -p "$PROMPT" \
  --plugin-dir /opt/observability-plugin/plugin \
  --permission-mode bypassPermissions \
  --allowedTools "Read Edit Write Glob Grep Bash(go:*)" \
  --max-budget-usd "$BUDGET_USD" \
  --output-format json \
  > "$OUT/agent.json" 2>"$OUT/agent.log"
AGENT_RC=$?
set -e
[ "$AGENT_RC" -ne 0 ] && fail "the agent exited $AGENT_RC — see agent.log"

SUMMARY="$(jq -r '.result // empty' "$OUT/agent.json" 2>/dev/null)"
COST="$(jq -r '.total_cost_usd // empty' "$OUT/agent.json" 2>/dev/null)"

# --- results -------------------------------------------------------------------
git add -A
# Everything the agent could have changed, minus the platform.json this script
# seeded — if that file is the only difference, the agent itself changed nothing.
AGENT_CHANGES="$(git diff --cached --name-only | grep -v '^\.observability/platform\.json$' || true)"
if [ -z "$AGENT_CHANGES" ]; then
  # Not a failure. A repository with nothing to onboard is a real answer, and
  # the summary explains it; forcing this to fail is what pushes the agent to
  # invent files so the job "succeeds".
  jq -n --arg status no_changes --arg summary "$SUMMARY" --arg cost "$COST"     '{status:$status, summary:$summary, cost_usd:(($cost|tonumber?) // null), files_changed:[]}'     > "$OUT/result.json"
  echo "no changes: nothing to onboard in this repository"
  exit 0
fi

git diff --cached > "$OUT/onboarding.patch"
CHANGED="$(git diff --cached --name-only | jq -R . | jq -s .)"

PR_URL=""
if [ "$MODE" = "pr" ]; then
  [ -n "${GIT_TOKEN:-}" ] || fail "MODE=pr requires GIT_TOKEN with write access"
  BRANCH="observability/onboard-$(date +%Y%m%d-%H%M%S)"
  git checkout -q -b "$BRANCH"
  git commit -q -m "feat(observability): onboard onto the Digiform platform

Generated by the Digiform onboarding agent. Traces, metrics, and
trace-correlated logs are exported over OTLP to the shared platform.

Not verified from here: the agent never runs your application. After merging,
run the observability-onboard plugin's verify skill to confirm the signals
actually arrive."
  git remote set-url origin "$(authed_url "$REPO_URL")"
  git push -q origin "$BRANCH" >>"$OUT/clone.log" 2>&1 || fail "push failed — the token needs write access. See clone.log"
  git remote set-url origin "$REPO_URL"

  TITLE="Onboard onto the Digiform observability platform"
  TARGET="${BASE_BRANCH:-main}"
  HOST="$(printf '%s' "$REPO_URL" | sed -E 's#^https://([^/]+)/.*#\1#')"
  # Everything after the host, minus any .git: owner/repo on GitHub,
  # group/subgroup/project on GitLab.
  PATH_SLUG="$(printf '%s' "$REPO_URL" | sed -E 's#^https://[^/]+/##; s#\.git$##')"

  if [ "${PROVIDER:-github}" = "gitlab" ]; then
    # GitLab addresses a project by URL-encoded full path, so every slash in a
    # subgroup path must become %2F. jq does the encoding rather than sed,
    # because group names legitimately contain characters sed would mangle.
    ENC_PATH="$(jq -rn --arg p "$PATH_SLUG" '$p|@uri')"
    API_RESP="$(curl -sS -X POST "https://$HOST/api/v4/projects/$ENC_PATH/merge_requests" \
      -H "PRIVATE-TOKEN: $GIT_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg t "$TITLE" --arg sb "$BRANCH" --arg tb "$TARGET" --arg d "$SUMMARY" \
                  '{title:$t, source_branch:$sb, target_branch:$tb, description:$d}')")"
    PR_URL="$(printf '%s' "$API_RESP" | jq -r '.web_url // empty')"
  else
    API_RESP="$(curl -sS -X POST "https://api.github.com/repos/$PATH_SLUG/pulls" \
      -H "Authorization: Bearer $GIT_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -d "$(jq -n --arg t "$TITLE" --arg h "$BRANCH" --arg b "$TARGET" --arg body "$SUMMARY" \
                  '{title:$t, head:$h, base:$b, body:$body}')")"
    PR_URL="$(printf '%s' "$API_RESP" | jq -r '.html_url // empty')"
  fi

  # The branch pushed successfully either way; only the MR/PR call failed. Say
  # so instead of failing the job — the client can open the request by hand.
  if [ -z "$PR_URL" ]; then
    echo "warning: branch $BRANCH pushed, but opening the request failed: $(printf '%s' "$API_RESP" | jq -r '.message // .error // .' 2>/dev/null | head -c 300)" >&2
  fi
fi

jq -n --arg status succeeded --arg base "$BASE_SHA" --arg summary "$SUMMARY" \
      --arg cost "$COST" --arg pr "$PR_URL" --argjson files "$CHANGED" \
  '{status:$status, base_sha:$base, files_changed:$files, summary:$summary,
    cost_usd:(($cost|tonumber?) // null),
    pull_request:(if $pr == "" then null else $pr end)}' > "$OUT/result.json"

echo "done: $(jq -r '.files_changed | length' "$OUT/result.json") file(s) changed"
