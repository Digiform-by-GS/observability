# Onboarding Agent (hosted)

A client submits a repository URL; an agent instruments it for the observability
platform and returns a patch — or opens a pull request if they've granted write
access. No Claude Code installation required on the client side, which is the
whole point: the plugin only reaches teams that already use Claude Code, and
this reaches everyone else.

## Shape

```
POST /api/jobs   {repoUrl, mode, serviceName?, team?, baseBranch?, gitToken?}  -> 202 {id}
GET  /api/jobs                                                                 -> recent jobs
GET  /api/jobs/:id                                                             -> status + summary
GET  /api/jobs/:id/patch                                                       -> the diff
GET  /                                                                         -> one-page UI over the same API
```

The API server spawns one disposable **runner** container per job. The runner
clones the repo, seeds `.observability/platform.json`, runs the
`observability-onboard` plugin's `onboard` skill headless (`claude -p
--plugin-dir`), and emits `onboarding.patch` plus `result.json`.

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

## Cost and capacity

Each job is a metered API call — `--max-budget-usd` caps a single run and the
actual spend comes back in `result.json` as `cost_usd`. Jobs run **one at a
time**: the host has 2 vCPU shared with the observability stack, and parallel
agent runs would make the platform's latency a function of demo traffic.

## Security posture

- Runner: `--cap-drop ALL`, `no-new-privileges`, non-root, tmpfs workspace,
  memory/CPU/pids capped, and **not** on the platform's `obs` network.
- Secrets reach the container through a stdin env-file, never argv — argv is
  visible to `docker inspect` and to any process reading `/proc`.
- `gitToken` is never written to the job record, to disk, or to logs.
- The API server mounts the Docker socket, which is effectively host root. It
  is therefore kept toolchain-free and never touches client code itself. If
  this service is ever exposed beyond a trusted network, that trade-off needs
  revisiting — rootless Docker or a dedicated build host.
