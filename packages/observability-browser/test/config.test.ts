import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';

const MINIMAL = { serviceName: 'shop-browser', endpoint: 'http://collector:4319' };

describe('resolveConfig', () => {
  it('requires serviceName, and says why there is no env fallback', () => {
    expect(() => resolveConfig({ ...MINIMAL, serviceName: '' })).toThrowError(/serviceName is required/);
    expect(() => resolveConfig({ ...MINIMAL, serviceName: '' })).toThrowError(/browser/);
  });

  // The single most valuable guard in this file. The Node wrapper defaults to
  // http://localhost:4318, which is correct there. Copying that default here
  // would mean every visitor's browser posting to their own machine: it works
  // perfectly on the developer's laptop and reports nothing from anyone else.
  it('requires endpoint rather than defaulting to localhost', () => {
    expect(() => resolveConfig({ ...MINIMAL, endpoint: '' })).toThrowError(/endpoint is required/);
    expect(() => resolveConfig({ ...MINIMAL, endpoint: '' })).toThrowError(/VISITOR/);
  });

  it('strips a trailing slash so signal paths do not double up', () => {
    const config = resolveConfig({ ...MINIMAL, endpoint: 'http://collector:4319/' });
    expect(config.endpoint).toBe('http://collector:4319');
  });

  // Propagation adds a header, which makes cross-origin requests preflighted.
  // If it defaulted to on, installing this package would break every app whose
  // backend does not yet allow the traceparent header.
  it('leaves trace propagation off unless asked for', () => {
    expect(resolveConfig(MINIMAL).propagateTo).toEqual([]);
  });

  it('defaults environment to production, not development', () => {
    // NODE_ENV does not exist in a browser, and a bundle that reports itself as
    // "development" in production makes every environment filter lie.
    expect(resolveConfig(MINIMAL).environment).toBe('production');
  });

  it('captures errors and vitals by default, and honours opting out', () => {
    const on = resolveConfig(MINIMAL);
    expect(on.captureErrors).toBe(true);
    expect(on.captureWebVitals).toBe(true);

    const off = resolveConfig({ ...MINIMAL, captureErrors: false, captureWebVitals: false });
    expect(off.captureErrors).toBe(false);
    expect(off.captureWebVitals).toBe(false);
  });

  it('falls back to a constant route so vitals cannot mint unbounded series', () => {
    expect(resolveConfig(MINIMAL).route()).toBe('unknown');
  });
});
