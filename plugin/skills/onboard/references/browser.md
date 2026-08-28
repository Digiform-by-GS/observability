# Browser / RUM onboarding reference

Real user monitoring: what the **user** experienced, as opposed to what the
server did. Page-load timings, fetch/XHR spans, Core Web Vitals, and JS errors.

This is an **addition to** server-side instrumentation, never a replacement. A
Next.js app wants both: `@vercel/otel` for SSR (see [node.md](node.md)) and this
for the browser.

## Before you touch any code: confirm the platform is ready

Browser telemetry needs a **CORS-enabled OTLP receiver**, which is a different
port from the one services use (`4319` on this platform, versus `4318`). A
standard OTLP endpoint sends no CORS headers, so the browser's preflight fails
and every export is dropped — with **no error the application can see**.

The app's origin must also be on that receiver's allowlist. That is a platform
operation, not something you can do from the client repo.

If `.observability/platform.json` has no browser endpoint, **stop and tell the
user** they need one from their platform operator, then onboard the server side
only. Do not guess a port. Shipping browser instrumentation that cannot deliver
is worse than not shipping it: it looks instrumented and reports nothing.

## Install

```bash
npm install @digiform-by-gs/observability-browser@0.1.0
```

Version from [compat.json](compat.json) — do not substitute your own. Then
regenerate the lockfile (`npm install --package-lock-only --ignore-scripts`) and
verify with `npm ci --dry-run`.

## Wire it in

```ts
import { initBrowserObservability } from '@digiform-by-gs/observability-browser';

initBrowserObservability({
  serviceName: 'shop-browser',
  endpoint: import.meta.env.VITE_OTLP_BROWSER_ENDPOINT,
  environment: import.meta.env.MODE,
});
```

Call it once, as early as the app has a client entry point. For Next.js that is
`pages/_app` on the pages router, or a `'use client'` component mounted from the
root layout on the app router.

`initBrowserObservability()` returns a no-op when `window` is undefined, so it is
safe to import from code that also renders on the server.

## Configuration comes from build-time variables, not env vars

**The env-var contract in SKILL.md Step 2 does not apply here.** A browser has no
environment. Bundlers replace `process.env.X` / `import.meta.env.X` at build
time with a literal, so:

- Values must be exposed through the bundler's public prefix — `NEXT_PUBLIC_*`,
  `VITE_*`, `REACT_APP_*`. A plain `OTEL_EXPORTER_OTLP_ENDPOINT` is simply
  absent from the bundle.
- They are baked in when the app is **built**, not when it runs. Changing them
  requires a rebuild, and one build cannot serve two environments.
- Everything here is **public**. Anyone can read the endpoint out of the bundle.
  Never put a token in this config.

A missing variable becomes `undefined`, which is why `endpoint` throws rather
than defaulting.

## The four traps

### 1. `propagateTo` can break the application — sequence it

This is the setting that joins a browser span to the server span it triggered,
and the only change in this skill that can take an app down.

Adding a `traceparent` header makes a cross-origin request **preflighted**. If
the API does not list `traceparent` in `Access-Control-Allow-Headers`, the
preflight fails and **the real request never happens**. Not a lost trace — a
broken feature.

```ts
propagateTo: [/^https:\/\/api\.example\.com/],   // only after the API allows the header
```

Order of operations, and say this to the user explicitly:

1. Backend sends `Access-Control-Allow-Headers: traceparent, tracestate, content-type`
   (and ideally `Timing-Allow-Origin`, or cross-origin spans lose timing detail).
2. Deploy that.
3. *Then* set `propagateTo`.

**Check the origins before assuming any of this applies.** Same-origin requests
are never preflighted, so if the API is served from the same host as the app -
`https://app.example.com` and `https://app.example.com/api/` - propagation is
free, safe, and needs no backend change. Compare the app's deployed URL with its
API base URL before proposing a CORS change to another team.

Default is empty. Leave it empty unless you have confirmed same-origin or
confirmed the backend allows the header, and say which in the PR body.

### 2. If your app is served over HTTPS, proxy through your own origin

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

### 3. `serviceName` must differ from the server-side service

Use `shop-browser` alongside `shop`. Sharing one name pools server-render
latency with real-user latency under a single service label, which quietly makes
p95 meaningless on every existing dashboard.

### 4. `route` must return a template, never a URL

```ts
route: () => '/orders/:id'        // correct
route: () => location.pathname    // WRONG
```

It labels the web-vital metrics. A concrete path mints one metric series per
distinct URL, which fills the shared metric store — and that rejects writes for
**every** service on the platform, not just this one. If the app has no router
hook available, omit the option; the constant fallback is safe.

## What you get, and what you do not

Collected: `document-load` page timings, `fetch`/`XHR` spans, web vitals
(`browser.web_vital.{lcp,inp,cls,ttfb,fcp}`), and `error` /
`unhandledrejection` as trace-correlated logs.

Not collected, deliberately: **user-interaction spans**. That instrumentation
names spans after event type plus DOM target, which is unbounded and inflates
span-metrics cardinality.

## Verification, and why the browser is different

Do not report success from a clean build. Browser telemetry fails in ways that
produce no error anywhere:

- Open devtools → Network, filter on the endpoint. A **CORS error** means the
  origin is not allowlisted, or you used the service port rather than the
  browser one.
- **No request at all, and no error**: an ad blocker or privacy extension is
  dropping it. Many block URLs containing `telemetry`, `analytics`, or
  `collect`. Ask the user to check with extensions disabled — otherwise this
  reads as "some users just do not report".
- Navigate away from the page and confirm a final batch is sent. The vitals that
  matter most (LCP, CLS, INP) are only final at page hide.
