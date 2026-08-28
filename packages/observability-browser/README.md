# @digiform-by-gs/observability-browser

Real user monitoring for the browser. Page-load traces, browser→backend trace joining, Core Web Vitals, and JS errors — all over OTLP to the same collector your services already use.

The browser counterpart of [`@digiform-by-gs/observability`](../observability/). It answers the one question server-side instrumentation structurally cannot: **what did the user actually experience?**

## Install

```bash
npm install @digiform-by-gs/observability-browser@0.1.0
```

## Compatibility

| Requirement | Version | Notes |
|---|---|---|
| Browsers | Any with `PerformanceObserver` | Chrome/Edge 64+, Firefox 58+, Safari 14.1+. Degrades quietly on older ones. |
| Module system | **ESM only** | No CommonJS build. Bundlers (Vite, webpack 5, Next.js, Rollup) handle this natively. |
| OpenTelemetry JS | SDK `^2.10.0`, experimental `^0.221.0` | A **compatible set**, pinned together. |
| `@opentelemetry/api` | `^1.9.1` | `sdk-trace-web` peers `>=1.0.0 <1.10.0`, so 1.10 will need a coordinated bump. |
| web-vitals | `^6.2.1` | |

**This package is on a newer OpenTelemetry line than the Node wrapper** (2.10/0.221 vs 2.7/0.215). That is forced, not sloppy: `@opentelemetry/instrumentation-fetch` pins `sdk-trace-web` to an exact version, so the browser instrumentations decide the line. The two packages target different runtimes and are never installed in the same bundle, so they do not need to agree.

**Do not install `@opentelemetry/api` yourself** — it is already a dependency here, and two copies at different majors break context propagation silently.

### Platform requirement

The collector needs a **browser OTLP receiver with CORS** (port `4319` on this platform). A standard OTLP endpoint has no CORS headers, so every export dies at the preflight with nothing in your logs to explain it. Ask your platform operator to add your origin to the allowlist — this is a deliberate, per-origin operation.

## Quickstart

```ts
import { initBrowserObservability } from '@digiform-by-gs/observability-browser';

initBrowserObservability({
  serviceName: 'shop-browser',
  endpoint: import.meta.env.VITE_OTLP_BROWSER_ENDPOINT, // e.g. http://collector.internal:4319
  environment: import.meta.env.MODE,
});
```

Call it once, as early as possible — `document-load` timings are captured from the Performance API, so a late call still gets them, but fetches made before initialization are not traced.

In Next.js, call it from `pages/_app` (pages router) or a `'use client'` component mounted in the root layout (app router). It complements `@vercel/otel`, which covers the server side, rather than replacing it.

## Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `serviceName` | `string` | — | **Required.** Use a name distinct from the server-side service. |
| `endpoint` | `string` | — | **Required.** No default — see below. |
| `propagateTo` | `(string \| RegExp)[]` | `[]` | URLs that receive `traceparent`. **Read the warning below before setting.** |
| `environment` | `string` | `production` | |
| `serviceVersion` | `string` | `0.0.0` | |
| `route` | `() => string` | `() => 'unknown'` | Returns the current route **template**. |
| `captureErrors` | `boolean` | `true` | |
| `captureWebVitals` | `boolean` | `true` | |
| `resourceAttributes` | `Record<string,string>` | `{}` | |
| `metricExportIntervalMs` | `number` | `60000` | |

There is **no environment-variable layer**. `process.env` does not exist in a browser, and a bundler replaces it at build time — an "env fallback" would look like a runtime read while actually being a literal frozen when the bundle was compiled. Pass your build-time variables in explicitly.

## Four things that will bite you

### 1. `propagateTo` can break your application

Adding a `traceparent` header makes a cross-origin request **preflighted**. If your backend does not list `traceparent` in `Access-Control-Allow-Headers`, the preflight fails and **the real request never happens**. Enabling this against an unprepared backend does not merely lose correlation — it takes the app down.

Sequence it: **backend CORS first, `propagateTo` second.** This is why the default is empty.

**Same-origin requests are never preflighted**, so if your API is served from the same host as your app (`https://app.example.com` and `https://app.example.com/api/`), none of this applies — propagation is free and safe, and the backend needs no CORS change at all. Check the origin before assuming you need one.

```
Access-Control-Allow-Headers: traceparent, tracestate, content-type
```

Also add `Timing-Allow-Origin` on the backend, or cross-origin spans lose their timing detail.

### 2. `endpoint` has no default, on purpose

The Node wrapper defaults to `http://localhost:4318`, which is correct there — the process runs beside the collector. In a browser, `localhost` is **the visitor's own machine**. That default would work flawlessly on your laptop and report nothing from a single real user. This package refuses to start instead.

The endpoint ships inside your JS bundle and is readable by anyone. Treat it as public; it is why the collector uses an origin allowlist.

### 3. If your app is served over HTTPS, proxy through your own origin

This is the common case, and going straight at the collector does not work:

- **Mixed content.** A page on `https://` cannot POST to an `http://` endpoint.
  Browsers block it before the request leaves, and no CORS configuration
  changes that.
- **Routability.** A collector on a private address is not reachable from a
  user's phone or home network at all.

Rather than exposing the collector publicly with TLS, forward a path from the
app's own origin:

```js
// next.config.js
async rewrites() {
  return [{ source: '/otel/:path*', destination: 'http://collector.internal:4319/:path*' }];
}
```

```ts
initBrowserObservability({ serviceName: 'shop-browser', endpoint: '/otel' });
```

`endpoint` accepts a **path** as well as a URL. The browser then posts
same-origin, so there is no mixed content, **no preflight, and no CORS involved
at all** — the collector stays private and the plain-HTTP hop happens
server-side. Your app server must be able to reach the collector.

The equivalent for other stacks is the same idea: a `vite.config` proxy in
development, or an nginx/ingress `location` block in production.

### 4. `route` must return a template, never a URL

```ts
route: () => '/orders/:id'   // correct
route: () => location.pathname // WRONG: /orders/42, /orders/43, ...
```

Web vitals are labelled with `route`. A concrete path makes every distinct URL its own metric series, which fills the platform's metric store — and on a shared platform that rejects writes for **every** service, not just yours. When in doubt, return a constant.

## What it collects

| Signal | Source |
|---|---|
| Page load traces | `document-load` — DNS, TCP, TTFB, DOM processing, resource fetches |
| HTTP spans | `fetch` and `XMLHttpRequest`, with optional trace propagation |
| Web vitals | `browser.web_vital.{lcp,inp,cls,ttfb,fcp}` histograms, labelled `route` + `rating` only |
| Errors | `error` and `unhandledrejection` as OTLP logs, correlated to the active trace |

`user-interaction` instrumentation is **deliberately not included**: it names spans after event type plus DOM target, which is unbounded and would inflate span-metrics cardinality.

## Custom instrumentation

```ts
import { getTracer, getMeter, getLogger } from '@digiform-by-gs/observability-browser';

const span = getTracer('checkout').startSpan('apply-coupon');
// ...
span.end();
```

These return the API's no-op implementations before initialization rather than throwing. Module evaluation order in a bundle is not fully under your control, and a component recording a metric at import time must not white-screen the page.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing arrives; console shows a CORS error | Your origin is not on the collector's allowlist, or you are posting to the plain OTLP port instead of the browser one. |
| Nothing arrives; no console error at all | An ad blocker or privacy extension is dropping the request. Common ones block URLs containing `telemetry`, `analytics`, or `collect`. |
| API calls start failing right after enabling `propagateTo` | The backend rejects the `traceparent` preflight. See trap 1 — revert `propagateTo`, fix the backend's CORS, then re-enable. |
| `endpoint is required` thrown at startup | Your build-time variable is undefined. Bundlers silently substitute `undefined` for a missing `VITE_*` / `NEXT_PUBLIC_*`. |
| Browser and backend spans are in separate traces | `propagateTo` does not match the API URL, or the backend strips the header. |
| Page-load spans but no fetch spans | Requests are being made before `initBrowserObservability()` runs. |
| Vitals appear with `route="unknown"` | No `route` option supplied. Harmless, but you cannot break results down by page. |

## Server-side rendering

`initBrowserObservability()` returns a no-op handle when `window` is undefined, so importing it from code that also renders on the server is safe. A frontend must not break because its telemetry could not start.
