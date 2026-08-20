import type { Instrumentation } from '@opentelemetry/instrumentation';
import type { Level as PinoLevel } from 'pino';

export interface ObservabilityOptions {
  serviceName?: string;
  serviceVersion?: string;
  environment?: string;
  endpoint?: string;
  /**
   * Extra headers sent on every OTLP export request (all three signals) —
   * e.g. `{ Authorization: 'Bearer <key>' }` for an authenticated collector.
   * Deliberately NOT resolved from OTEL_EXPORTER_OTLP_HEADERS here: the
   * exporters read that env var themselves, including the per-signal
   * OTEL_EXPORTER_OTLP_TRACES_HEADERS overrides, and re-parsing it in the
   * wrapper would shadow that spec behavior. Programmatic headers win over
   * env headers on key collisions (exporter-level merge).
   */
  headers?: Record<string, string>;
  resourceAttributes?: Record<string, string>;
  instrumentations?: Instrumentation[];
  additionalInstrumentations?: Instrumentation[];
  disableAutoInstrumentations?: boolean;
  metricExportIntervalMs?: number;
  logLevel?: PinoLevel;
}

export interface ResolvedConfig {
  serviceName: string;
  serviceVersion: string;
  environment: string;
  endpoint: string;
  headers?: Record<string, string>;
  resourceAttributes: Record<string, string>;
  instrumentations?: Instrumentation[];
  additionalInstrumentations: Instrumentation[];
  disableAutoInstrumentations: boolean;
  metricExportIntervalMs: number;
  logLevel: PinoLevel;
}

export interface ObservabilityHandle {
  shutdown(): Promise<void>;
}
