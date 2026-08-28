import { metrics } from '@opentelemetry/api';
import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';

const SCOPE = '@digiform-by-gs/observability-browser';

/**
 * Google's Core Web Vitals, recorded as OTel histograms.
 *
 * These are what a product owner means by "how fast is the site" — LCP for
 * perceived load, INP for responsiveness, CLS for visual stability. Spans
 * cannot answer those questions: they measure work the code did, while vitals
 * measure what the person saw.
 *
 * THE LABEL SET IS DELIBERATELY TINY. Vitals are reported once per page view,
 * so any per-user or per-URL label multiplies series by the number of users.
 * Only `route` (a template, supplied by the caller) and `rating` (three fixed
 * values from web-vitals) are attached; service and environment arrive from the
 * resource. Never add the URL, a session id, or the user agent here — the
 * collector prunes those from browser metrics precisely because this is where
 * they would otherwise land.
 *
 * CLS is unitless; the rest are milliseconds. They are separate instruments
 * rather than one instrument with a `name` label, so each keeps its own bucket
 * boundaries and a CLS of 0.1 is not pooled with an LCP of 2500.
 */
export function registerWebVitals(route: () => string): void {
  const meter = metrics.getMeter(SCOPE);

  const histograms = {
    LCP: meter.createHistogram('browser.web_vital.lcp', {
      description: 'Largest Contentful Paint',
      unit: 'ms',
    }),
    INP: meter.createHistogram('browser.web_vital.inp', {
      description: 'Interaction to Next Paint',
      unit: 'ms',
    }),
    CLS: meter.createHistogram('browser.web_vital.cls', {
      description: 'Cumulative Layout Shift (unitless score)',
      unit: '1',
    }),
    TTFB: meter.createHistogram('browser.web_vital.ttfb', {
      description: 'Time to First Byte',
      unit: 'ms',
    }),
    FCP: meter.createHistogram('browser.web_vital.fcp', {
      description: 'First Contentful Paint',
      unit: 'ms',
    }),
  } as const;

  const record = (metric: Metric): void => {
    const histogram = histograms[metric.name as keyof typeof histograms];
    if (!histogram) return;
    histogram.record(metric.value, {
      route: route(),
      rating: metric.rating,
    });
  };

  // web-vitals calls back when the value is FINAL, which for LCP/CLS/INP is at
  // page hide. The unload flush in unload.ts is what gets those last values
  // out; without it the most important vitals are computed and then discarded.
  onLCP(record);
  onINP(record);
  onCLS(record);
  onTTFB(record);
  onFCP(record);
}
