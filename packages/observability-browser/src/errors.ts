import { logs, SeverityNumber } from '@opentelemetry/api-logs';

const SCOPE = '@digiform-by-gs/observability-browser';

/**
 * Captures uncaught errors and unhandled promise rejections as OTLP log
 * records.
 *
 * These are emitted through the Logs API in the same synchronous frame as the
 * event, so `context.active()` is captured and the record carries `trace_id`
 * when an error happens inside an instrumented fetch. That is the whole point:
 * "the page broke" becomes a stack trace joined to the request that broke it.
 *
 * Both handlers are additive listeners, never assignments to `window.onerror`.
 * Assigning would silently replace an error handler the application had already
 * installed — plausibly its own error reporting.
 */
export function registerErrorCapture(): () => void {
  const logger = logs.getLogger(SCOPE);

  const onError = (event: ErrorEvent): void => {
    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: event.message || 'uncaught error',
      attributes: {
        'exception.type': event.error?.name ?? 'Error',
        'exception.message': event.error?.message ?? event.message,
        'exception.stacktrace': event.error?.stack ?? '',
        // Source location, not the page URL: the page URL is already on the
        // resource, and putting a full URL here would push query strings (which
        // routinely carry tokens) into log bodies.
        'code.filepath': event.filename ?? '',
        'code.lineno': event.lineno ?? 0,
      },
    });
  };

  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason: unknown = event.reason;
    const isError = reason instanceof Error;
    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: isError ? reason.message : String(reason),
      attributes: {
        'exception.type': isError ? reason.name : typeof reason,
        'exception.message': isError ? reason.message : String(reason),
        'exception.stacktrace': isError ? (reason.stack ?? '') : '',
        'exception.escaped': true,
      },
    });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
