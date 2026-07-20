import type { Instrumentation } from '@opentelemetry/instrumentation';
import type { Level as PinoLevel } from 'pino';

export interface ObservabilityOptions {
  serviceName?: string;
  serviceVersion?: string;
  environment?: string;
  endpoint?: string;
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
