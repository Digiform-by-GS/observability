/**
 * Builds the `ignoreUrls` pattern that keeps the SDK from tracing its own
 * exports.
 *
 * The exporter POSTs over fetch. With fetch instrumented and nothing excluded,
 * that POST produces a span, exporting the span produces another POST, and so
 * on — a self-sustaining loop running in every open tab, aimed at the shared
 * collector. It is not a slow leak; it is an outbound flood.
 *
 * The endpoint is escaped rather than interpolated raw. Every hostname contains
 * dots, and an unescaped dot matches any character, so `http://a.b:4319` would
 * also match `http://axb:4319`. Over-matching here silently disables tracing
 * for URLs the application actually cares about, which is the harder bug to
 * find of the two.
 */
export function ignorePattern(endpoint: string): RegExp {
  return new RegExp(escapeRegExp(endpoint));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
