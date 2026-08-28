import type { Instrumentation } from '@opentelemetry/instrumentation';

export interface BrowserObservabilityOptions {
  /**
   * Identity of this app in every dashboard and query.
   *
   * Required, with no environment fallback — a browser bundle has no
   * environment to read. Use a name DISTINCT from the server-side service, even
   * for the same application: sharing one name merges server-render latency and
   * real user latency into a single `service` label, which makes p95 on the
   * existing dashboards mean nothing.
   */
  serviceName: string;

  /**
   * Base URL of the platform's browser OTLP receiver, e.g.
   * `http://collector.internal:4319`. Required, and deliberately with NO
   * default.
   *
   * The Node wrapper defaults to `http://localhost:4318`, which is safe there
   * because the process runs alongside the collector. In a browser that same
   * default would mean each visitor's own machine, so every export would fail
   * on every device except a developer's laptop — the kind of thing that looks
   * fine in testing and reports nothing in production. Better to refuse to
   * start.
   *
   * Comes from a build-time variable (`NEXT_PUBLIC_*`, `VITE_*`), and is
   * therefore readable by anyone who opens devtools. Treat it as public.
   */
  endpoint: string;

  serviceVersion?: string;

  /** Defaults to `production`. See the note on `endpoint` about build-time vars. */
  environment?: string;

  /**
   * URLs that should receive a `traceparent` header, joining a browser span to
   * the server span it triggered. Opt-in, with no default, and the reason is
   * important:
   *
   * Adding a header to a cross-origin request makes it *preflighted*. If the
   * target server does not list `traceparent` in `Access-Control-Allow-Headers`,
   * the preflight fails and THE REAL REQUEST NEVER HAPPENS. Enabling this
   * against a backend that is not ready does not merely lose correlation — it
   * breaks the application.
   *
   * Sequence it: backend CORS first, this second. Same-origin requests are
   * never preflighted, so a frontend that proxies its API through itself is
   * unaffected.
   */
  propagateTo?: (string | RegExp)[];

  /** Extra headers on every OTLP export. Rarely needed on a browser endpoint. */
  headers?: Record<string, string>;

  resourceAttributes?: Record<string, string>;

  /**
   * Returns the current ROUTE TEMPLATE (`/orders/:id`), not the URL
   * (`/orders/42`). Used as the only high-value label on web-vital metrics.
   *
   * If this returns a concrete path, every distinct URL becomes its own metric
   * series — the failure that fills Mimir and gets writes rejected for every
   * service on the platform. When in doubt, return a constant.
   */
  route?: () => string;

  /** Capture `error` and `unhandledrejection` as OTLP logs. Default `true`. */
  captureErrors?: boolean;

  /** Capture LCP/CLS/INP/TTFB/FCP as metrics. Default `true`. */
  captureWebVitals?: boolean;

  /** Replaces the default instrumentations entirely. */
  instrumentations?: Instrumentation[];

  /** Appended to the default instrumentations. */
  additionalInstrumentations?: Instrumentation[];

  /** Default 60000. */
  metricExportIntervalMs?: number;
}

export interface ResolvedBrowserConfig {
  serviceName: string;
  serviceVersion: string;
  environment: string;
  endpoint: string;
  propagateTo: (string | RegExp)[];
  headers?: Record<string, string>;
  resourceAttributes: Record<string, string>;
  route: () => string;
  captureErrors: boolean;
  captureWebVitals: boolean;
  instrumentations?: Instrumentation[];
  additionalInstrumentations: Instrumentation[];
  metricExportIntervalMs: number;
}

export interface BrowserObservabilityHandle {
  /** Flush and detach every listener. Rarely needed — the page unload path is automatic. */
  shutdown(): Promise<void>;
  /** Force an immediate export. Called for you on page hide. */
  flush(): Promise<void>;
}
