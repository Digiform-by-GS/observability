import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';

const OTEL_VARS = [
  'OTEL_SERVICE_NAME',
  'OTEL_SERVICE_VERSION',
  'OTEL_DEPLOYMENT_ENVIRONMENT',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_RESOURCE_ATTRIBUTES',
  'npm_package_name',
  'npm_package_version',
  'NODE_ENV',
];

describe('resolveConfig', () => {
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of OTEL_VARS) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of OTEL_VARS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it('throws a clear error when serviceName is missing and no env fallback exists', () => {
    expect(() => resolveConfig({})).toThrowError(/serviceName is required/);
  });

  it('prefers programmatic options over env vars', () => {
    process.env.OTEL_SERVICE_NAME = 'env-service';
    process.env.OTEL_DEPLOYMENT_ENVIRONMENT = 'env-env';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://env:4318';

    const cfg = resolveConfig({
      serviceName: 'opt-service',
      environment: 'opt-env',
      endpoint: 'http://opt:4318',
    });

    expect(cfg.serviceName).toBe('opt-service');
    expect(cfg.environment).toBe('opt-env');
    expect(cfg.endpoint).toBe('http://opt:4318');
  });

  it('falls back to env vars when options are omitted', () => {
    process.env.OTEL_SERVICE_NAME = 'env-service';
    process.env.NODE_ENV = 'staging';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';

    const cfg = resolveConfig();
    expect(cfg.serviceName).toBe('env-service');
    expect(cfg.environment).toBe('staging');
    expect(cfg.endpoint).toBe('http://collector:4318');
  });

  it('falls back to sensible defaults when neither is set', () => {
    const cfg = resolveConfig({ serviceName: 'my-svc' });
    expect(cfg.environment).toBe('development');
    expect(cfg.endpoint).toBe('http://localhost:4318');
    expect(cfg.metricExportIntervalMs).toBe(60_000);
    expect(cfg.logLevel).toBe('info');
  });

  it('strips a trailing slash from the endpoint', () => {
    const cfg = resolveConfig({
      serviceName: 'svc',
      endpoint: 'http://collector:4318/',
    });
    expect(cfg.endpoint).toBe('http://collector:4318');
  });

  it('merges OTEL_RESOURCE_ATTRIBUTES with programmatic resourceAttributes, options winning', () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'team=platform,region=us-east-1';
    const cfg = resolveConfig({
      serviceName: 'svc',
      resourceAttributes: { region: 'eu-west-1', tier: 'backend' },
    });
    expect(cfg.resourceAttributes).toEqual({
      team: 'platform',
      region: 'eu-west-1',
      tier: 'backend',
    });
  });

  it('ignores malformed entries in OTEL_RESOURCE_ATTRIBUTES', () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'good=yes,,=orphan,bad,also=fine';
    const cfg = resolveConfig({ serviceName: 'svc' });
    expect(cfg.resourceAttributes).toEqual({ good: 'yes', also: 'fine' });
  });
});
