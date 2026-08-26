# Onboarding Agent (hosted)

A client submits a **GitHub or GitLab** repository URL; an agent instruments it
for the observability platform and returns a patch — or opens a pull/merge
request if they've granted write access. No Claude Code installation required on the client side, which is the
whole point: the plugin only reaches teams that already use Claude Code, and
this reaches everyone else.

## Shape

```
POST /api/jobs   {repoUrl, mode, provider?, serviceName?, team?, baseBranch?, gitToken?}  -> 202 {id}
GET  /api/jobs                                                                 -> recent jobs
GET  /api/jobs/:id                                                             -> status + summary
GET  /api/jobs/:id/patch                                                       -> the diff
GET  /                                                                         -> one-page UI over the same API
```

The API server spawns one disposable **runner** container per job. The runner
clones the repo, seeds `.observability/platform.json`, runs the
`observability-onboard` plugin's `onboard` skill headless (`claude -p
--plugin-dir`), and emits `onboarding.patch` plus `result.json`.

## Guardrails

| Concern | Control |
|---|---|
| Executing client code | `--allowedTools "Read Edit Write Glob Grep"` — no `Bash`. The agent cannot run commands, install packages, or start the app |
| Touching secrets | The prompt forbids creating or editing `.env` and friends. Those are normally gitignored, so an edit there would vanish from the patch and the client would receive code that silently sends telemetry nowhere |
| Env vars the client must set | Derived by the runner from its own inputs — not asked of the agent — and returned in `required_env`, shown in the UI and in the PR/MR body |
| Changes beyond onboarding | Every changed file is classified **from the real diff** into `files_expected` and `files_for_review`. Surfaced, never blocked: a legitimate edit can live anywhere, and the reviewer is the judge. Computing it from the diff rather than the agent's summary means an over-claimed summary cannot hide a file |
| Retention on this host | `ARTIFACT_TTL_MS` (default 24h). Patches are the client's source and `agent.json` is a transcript of everything the agent read; without a TTL this box becomes a permanent archive of other people's code |
| Retention at Anthropic | **Not a code control.** Code is sent to the API by design. Configure Zero Data Retention at the org level before onboarding external clients |

## What it deliberately does not do

**It never executes client code.** No `npm install`, no `go build`, no running
the app. Onboarding is a source transformation — edit `package.json`, add the
preload flag, rewrite `main()` — so execution buys nothing, while `npm install`
on an untrusted repo is arbitrary code execution one hop from the shared
platform. Verification stays with the client, who runs the plugin's `verify`
skill against their own app where that is unremarkable.

Consequence to be honest with clients about: the patch is **reviewed, not
proven**. It should be read before merging, and verified after.

## Running it

```bash
# Runner image (built from the repo root — it bakes the plugin in)
docker build -f services/onboarding-agent/runner/Dockerfile -t digiform/onboarding-runner:dev .

# API + UI
docker compose -f docker-compose.onboard.yml up -d --build
```

Required in `.env`:

| Variable | Why |
|---|---|
| `ANTHROPIC_API_KEY` | the agent's credentials; the service refuses to start without it |
| `PUBLIC_OTLP_ENDPOINT` | baked into every generated `platform.json` — must be the address a **client** can reach, not a container name |
| `PUBLIC_GRAFANA_URL` | same |
| `ONBOARD_API_KEY` | shared secret for `POST`. Optional on a trusted LAN, **required** anywhere else, because a submitted job can carry a customer's repo token |
| `ONBOARD_BUDGET_USD` | per-job ceiling, default `2.00` |
| `ARTIFACT_TTL_MS` | how long job artifacts (patch, agent transcript) survive on disk; default 24h |
| `ONBOARD_GITLAB_HOSTS` | comma-separated self-hosted GitLab hostnames. `gitlab.com`/`github.com` need no configuration; other hosts must be listed here or the caller must send `provider` |

## Cost and capacity

Each job is a metered API call — `--max-budget-usd` caps a single run and the
actual spend comes back in `result.json` as `cost_usd`. Jobs run **one at a
time**: the host has 2 vCPU shared with the observability stack, and parallel
agent runs would make the platform's latency a function of demo traffic.

## Providers

`github.com` and `gitlab.com` are detected from the URL. Self-hosted GitLab —
common in this market — needs its hostname in `ONBOARD_GITLAB_HOSTS`, or a
`provider` field on the request.

Three things genuinely differ between them, and each fails confusingly if
guessed wrong:

| | GitHub | GitLab |
|---|---|---|
| Clone credential user | `x-access-token` | `oauth2` |
| Request API | `POST /repos/{owner}/{repo}/pulls` | `POST /api/v4/projects/{url-encoded path}/merge_requests` |
| Project path | always `owner/repo` | nested subgroups allowed, so the path must be URL-encoded whole |

If the branch pushes but opening the request fails, the job still succeeds and
says so — the client can open it by hand rather than re-running the agent.

## Security posture

- Runner: `--cap-drop ALL`, `no-new-privileges`, non-root, tmpfs workspace,
  memory/CPU/pids capped, and **not** on the platform's `obs` network.
- Secrets reach the container through a stdin env-file, never argv — argv is
  visible to `docker inspect` and to any process reading `/proc`.
- `gitToken` is never written to the job record, to disk, or to logs.
- Accepting self-hosted hosts means accepting arbitrary ones, so `parseRepoUrl`
  refuses loopback, RFC1918, link-local and cloud-metadata addresses — and the
  platform's own hostnames, which are ordinary public IPs the private-range
  rules would miss. Covered by tests.
- The API server mounts the Docker socket, which is effectively host root. It
  is therefore kept toolchain-free and never touches client code itself. If
  this service is ever exposed beyond a trusted network, that trade-off needs
  revisiting — rootless Docker or a dedicated build host.
