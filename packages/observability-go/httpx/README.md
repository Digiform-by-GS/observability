# observability-go/httpx

Router middleware for Go HTTP servers, wired so that server span names are
**route templates with the method** — `GET /orders/{id}` — on every supported
framework.

A separate module from [`observability-go`](../) so that adding it does not put
four routers into the dependency graph of services that use none of them. It is
also independently useful: it needs no other part of this project.

```bash
go get github.com/Digiform-by-GS/observability/packages/observability-go/httpx
```

| Router | Import | Middleware |
|---|---|---|
| chi | `httpx/chix` | `chix.Middleware("orders", r)` |
| gin | `httpx/ginx` | `ginx.Middleware("orders")` |
| Echo | `httpx/echox` | `echox.Middleware("orders")` |
| gorilla/mux | `httpx/muxx` | `muxx.Middleware("orders")` |

```go
r := mux.NewRouter()
r.Use(muxx.Middleware("orders"))
```

Each takes the framework's own option type as a variadic tail, so filters,
propagators, and tracer providers still reach the underlying middleware:

```go
r.Use(muxx.Middleware("orders", otelmux.WithFilter(skipWebsockets)))
```

## Why this is a package and not a paragraph of documentation

Span names become metric label values in Tempo's span-metrics generator, and
every distinct name multiplies by the latency histogram's bucket count. So a
naming mistake does not degrade the service that made it — it fills Mimir, and
Mimir then rejects metric writes **for every tenant on the platform**. One
team's routing mistake takes out everyone's dashboards.

There are two ways to get it wrong, and each router gets it wrong differently:

- **Unbounded** — the concrete path (`GET /orders/42`) reaches the span name, so
  every distinct URL mints a new series set. This is what bare
  `otelhttp.NewHandler` does on a server, and what otelchi does if you forget
  `WithChiRoutes`.
- **Collapsed** — the method is dropped (`/orders`), so `GET` and `POST` share
  one set of rate, error, and latency series and you cannot tell a read from a
  write. `http.method` is recorded as a span attribute but is not one of the
  platform's span-metrics dimensions, so it never reaches the metric labels and
  the distinction cannot be recovered afterwards.

The correct incantation is different for each router, which is the part nobody
remembers: otelchi needs two options, otelmux needs a hand-written formatter and
offers no option at all, and otelgin and otelecho are already correct. This
module makes all four one line, and pins the difference in tests rather than in
prose.

`ginx` and `echox` are thin pass-throughs today. They exist so that all four
routers are wired identically — a service author should not have to know which
frameworks need help — and so that their span-name tests fail if an upstream
release changes the default. That drift is otherwise invisible until Mimir
fills.

## For a framework not listed here

Find its OpenTelemetry contrib middleware and check one thing: a server span
must read `GET /orders/{id}`. Not `/orders/{id}` (collapsed), not
`GET /orders/42` (unbounded). If no middleware exists, `otelhttp` with an
explicit span-name formatter returning the route pattern is the last resort —
never bare `otelhttp.NewHandler`, which names every request in the service after
the service itself.

## Compatibility

| Requirement | Version |
|---|---|
| Go toolchain | 1.25+ |
| OpenTelemetry Go | v1.44.0 |
| opentelemetry-go-contrib | v0.69.0 (otelgin, otelecho, otelmux) |
| otelchi | v0.12.3 |

The contrib line is pinned to v0.69.0 deliberately: it is the release series
built against OTel v1.44.0, which is what `observability-go` requires. Newer
contrib releases pull OTel forward, and because Go resolves to the maximum
version in the graph, that would silently raise OTel for any service using both
modules. Bump the two together or not at all.

Module-graph pruning means importing one router package resolves only that
router: a `muxx` consumer gets `gorilla/mux` and `otelmux`, not chi, gin, or
Echo.

## Client-side HTTP

The cardinality trap is server-side naming only. On outbound calls,
`otelhttp.NewTransport` is correct and is what injects `traceparent`:

```go
client := &http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport)}
```

An HTTP client that builds its own transport without wrapping it — several SDKs
do — propagates nothing, and the trace silently ends at that hop.
