import { describe, expect, it } from 'vitest';
import { escapeRegExp, ignorePattern } from '../src/ignore.js';

// A single backslash, by char code. A literal backslash is exactly what these
// tests are about, and every quoting style has its own rule for it - String.raw
// cannot even end in one - so the character is built rather than written.
const BACKSLASH = String.fromCharCode(92);

describe('ignorePattern', () => {
  it('matches URLs under the collector endpoint', () => {
    const pattern = ignorePattern('http://collector.internal:4319');
    expect(pattern.test('http://collector.internal:4319/v1/traces')).toBe(true);
    expect(pattern.test('http://collector.internal:4319/v1/logs')).toBe(true);
  });

  it('does not match the application API', () => {
    const pattern = ignorePattern('http://collector.internal:4319');
    expect(pattern.test('http://api.internal:8080/orders')).toBe(false);
  });

  // Every hostname contains dots, and an unescaped dot matches any character.
  // Over-matching silently stops tracing URLs the application cares about,
  // which is far harder to notice than under-matching.
  it('escapes dots so a host cannot match a lookalike', () => {
    const pattern = ignorePattern('http://a.b:4319');
    expect(pattern.test('http://a.b:4319/v1/traces')).toBe(true);
    expect(pattern.test('http://axb:4319/v1/traces')).toBe(false);
  });

  it('escapes every regex metacharacter', () => {
    const specials = '.*+?^${}()|[]' + BACKSLASH;
    const escaped = escapeRegExp(specials);

    // Every character comes back preceded by a backslash...
    expect(escaped).toBe([...specials].map((c) => BACKSLASH + c).join(''));
    // ...and the result matches the literal it was built from, which is the
    // property that actually matters.
    expect(new RegExp(escaped).test(specials)).toBe(true);
  });
});

describe('ignorePattern with a relative endpoint', () => {
  // The instrumentation sees the RESOLVED absolute URL, so the pattern built
  // from the relative endpoint still has to match it - otherwise the exporter
  // traces its own POSTs and the export loop is back.
  it('matches the resolved absolute URL of a proxied endpoint', () => {
    const pattern = ignorePattern('/otel');
    expect(pattern.test('https://app.example.com/otel/v1/traces')).toBe(true);
    expect(pattern.test('https://app.example.com/api/orders')).toBe(false);
  });
});
