# observability-onboard

Agentic onboarding for the Digiform observability platform. Point Claude Code
at your repo, and it instruments your service — distributed traces, metrics,
and trace-correlated logs over OTLP — then proves the signals actually arrive
by reading them back out of the platform.

## Install

```bash
claude plugin marketplace add Digiform-by-GS/observability
claude plugin install observability-onboard@digiform
```

## Use

In your service's repository:

| Say | Skill | What happens |
|---|---|---|
| "onboard this service to observability" | `onboard` | Detects Node/Go + framework, adds the library, wires env vars, writes `.observability/platform.json` |
| "verify my observability works" | `verify` | Pushes a synthetic signal set, runs your app, reads traces/logs/metrics back from the platform; checks correlation and span-name hygiene |
| "how do I trace my checkout logic?" | `instrument` | Custom spans, business-outcome counters, structured logs — with the platform's cardinality rules baked in |
| "give me a dashboard for my service" | `dashboards` | Provisions a service-overview dashboard (RED + logs) in the platform's Grafana |

You'll need the platform endpoints from your platform operator on first run
(OTLP ingest and Grafana URLs); they're saved to `.observability/platform.json`
so every later run — and every teammate — skips the question.

## What onboarding looks like

- **Node**: 1 dependency + 1 flag on your start command. Zero code changes.
- **Go**: 1 dependency + ~8 lines in `main()` + 1 router-middleware line.
- Both: two env vars (`OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`).

Supported out of the box: Express/Fastify/plain Node (ESM), Next.js (special
path), Go with chi/gin/echo, plus Redis, SQL, and RabbitMQ helpers on the Go
side.

## Versioning

The plugin version tracks the platform's library releases. Skills are
self-contained; nothing here requires access to the platform's source
repository.
