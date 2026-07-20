import { logs, SeverityNumber, type LogAttributes } from '@opentelemetry/api-logs';
import pino, { type Logger } from 'pino';
import type { ResolvedConfig } from './types.js';

// pino numeric level → OTel SeverityNumber.
const SEVERITY_BY_PINO_LEVEL: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
};

// Keys pino writes itself; they map to LogRecord fields, not attributes.
type PinoRecord = {
  level: number;
  time: number;
  msg?: string;
  pid?: number;
  hostname?: string;
} & Record<string, unknown>;

export function createLogger(config: ResolvedConfig): Logger {
  // The OTel Logger comes from the global LoggerProvider that NodeSDK.start()
  // registers (see init.ts). It already carries the SDK Resource (service.name,
  // etc.), so we don't re-attach resource attributes per record.
  const otelLogger = logs.getLogger(config.serviceName, config.serviceVersion);

  // In-process bridge: pino serializes each record synchronously on the calling
  // thread and hands us the JSON line. We emit it to the OTel Logs API from that
  // same synchronous frame — so emit() captures the active span's context and
  // stamps trace_id/span_id onto the LogRecord. This is the whole point of the
  // rewrite: the previous pino-opentelemetry-transport ran in a worker thread
  // that could not see the active trace context, so logs shipped without it.
  const bridge = {
    write(line: string): void {
      // Mirror to stdout so logs remain visible in local dev / container logs.
      process.stdout.write(line);

      let record: PinoRecord;
      try {
        record = JSON.parse(line) as PinoRecord;
      } catch {
        return;
      }

      const { level, time, msg, pid, hostname, ...attributes } = record;
      void pid;
      void hostname;

      otelLogger.emit({
        timestamp: typeof time === 'number' ? time : Date.now(),
        severityNumber: SEVERITY_BY_PINO_LEVEL[level] ?? SeverityNumber.UNSPECIFIED,
        severityText: pino.levels.labels[level],
        body: msg,
        // JSON values are valid AnyValue (string/number/bool/null/object/array).
        attributes: attributes as LogAttributes,
      });
    },
  };

  return pino({ level: config.logLevel }, bridge);
}
