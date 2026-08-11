---
name: instrument
description: Add custom spans, metrics, and structured logs to business logic in a service already onboarded to the Digiform observability platform. Use when the user asks how to trace a business operation, add a custom metric or KPI counter, or instrument code beyond what auto-instrumentation covers.
---

# Instrument custom code

The service is already onboarded (HTTP, DB, cache, and queue calls are traced
automatically). This skill is about the judgement calls when instrumenting
*business logic* — and the platform-shared constraints that make some obvious
approaches wrong.

## The mental model: three signals, three questions

| Signal | Answers | Consumed as |
|---|---|---|
| **Metric** | "How often / how much, in aggregate?" | dashboards, alerts |
| **Span** | "Where did the time go in *this* request?" | trace waterfall |
| **Log** | "What exactly happened, with what data?" | search, joined to the trace by `trace_id` |

The unit of instrumentation is the **business operation** — `redeem-voucher`,
`settle-invoice` — not the function. One operation = one span + one outcome
counter (if the business counts it) + logs at state changes. Helper functions
inside it get **nothing**; a span per helper turns traces into noise.

## RED metrics are already free — never duplicate them

The platform generates rate, error, and duration series from **every span
name** automatically. The moment an operation has a span, its request rate,
error rate, and latency histogram exist, with links back to example traces.

Consequences:
- **Never hand-roll a `*_duration`/`*_latency` histogram for anything that has
  a span.** It duplicates existing data minus the trace links, and each
  histogram costs ~16+ series on the shared platform.
- Custom metrics are for **business semantics only** — things no span knows:
  order amounts, items per basket, redemptions by outcome, queue depths.
  Mostly counters and gauges. If a proposed metric name contains `duration` or
  `latency`, stop and point at the span instead.

## The core pattern (memorize this shape)

1. **One span** wrapping the operation, named after it, with *bounded*
   attributes (`voucher.type`, never `voucher.id`).
2. **Errors recorded twice, deliberately** — on the span (drives error-rate
   series and red traces) *and* as an error log (carries detail, searchable).
   Different consumers; not duplication.
3. **One counter with an `outcome` attribute** (`redeemed`/`expired`/
   `rejected`) if the business cares how often — the span already covers
   how slow.
4. **Logs at state changes**, identifiers in structured fields, message a
   constant string, always via the context-carrying call.
5. **Business outcomes are not system errors.** An expired voucher: Info log +
   `outcome=expired` counter, span stays OK. A DB failure: error status + error
   log. If declined cards mark spans failed, the error-rate alert measures
   customers, not the system.

### Node

```ts
import { getTracer, getMeter, getLogger } from '@digiform/observability';
import { SpanStatusCode } from '@opentelemetry/api';

const tracer = getTracer('vouchers');
const meter = getMeter('vouchers');
const log = getLogger();

// Instruments once at module scope, never per request.
const redemptions = meter.createCounter('app.vouchers.redemptions', {
  description: 'Voucher redemption attempts, by outcome.',
});

export async function redeemVoucher(code: string, orderId: string) {
  return tracer.startActiveSpan('redeem-voucher', async (span) => {
    try {
      span.setAttribute('voucher.type', voucherType(code)); // bounded value
      const voucher = await repo.findByCode(code);          // auto-traced, nests here

      if (voucher.expired) {
        log.info({ voucherCode: code }, 'voucher expired'); // business outcome
        redemptions.add(1, { outcome: 'expired' });
        throw new VoucherExpiredError(code);
      }

      await payments.applyDiscount(orderId, voucher.amount); // fetch propagates trace
      log.info({ voucherCode: code, orderId }, 'voucher redeemed');
      redemptions.add(1, { outcome: 'redeemed' });
    } catch (err) {
      if (!(err instanceof VoucherExpiredError)) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        log.error({ voucherCode: code, err: { message: (err as Error).message } },
          'voucher redemption failed');
        redemptions.add(1, { outcome: 'error' });
      }
      throw err;
    } finally {
      span.end(); // always — a never-ended span is a leaked trace
    }
  });
}
```

### Go

```go
var (
    tracer = observability.Tracer("vouchers")
    meter  = observability.Meter("vouchers")
)

// Once at construction, never per request; failure fails startup.
redemptions, err := meter.Int64Counter("app.vouchers.redemptions",
    metric.WithDescription("Voucher redemption attempts, by outcome."))

func (s *Service) RedeemVoucher(ctx context.Context, code, orderID string) error {
    // ctx in, ctx out — the returned ctx carries this span to everything below.
    ctx, span := tracer.Start(ctx, "redeem-voucher",
        trace.WithAttributes(attribute.String("voucher.type", voucherType(code))))
    defer span.End()

    voucher, err := s.repo.FindByCode(ctx, code) // auto-traced, nests here
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "voucher lookup failed")
        s.log.ErrorContext(ctx, "voucher lookup failed",
            slog.String("voucher_code", code), slog.Any("error", err))
        redemptions.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", "error")))
        return fmt.Errorf("redeem voucher: %w", err)
    }

    if voucher.Expired() {
        // Business outcome: Info + counter, span stays OK.
        s.log.InfoContext(ctx, "voucher expired", slog.String("voucher_code", code))
        redemptions.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", "expired")))
        return ErrVoucherExpired
    }

    s.log.InfoContext(ctx, "voucher redeemed",
        slog.String("voucher_code", code), slog.String("order_id", orderID))
    redemptions.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", "redeemed")))
    return nil
}
```

## Naming rules

| What | Rule | Good | Bad |
|---|---|---|---|
| Span name | verb-noun, constant, bounded set | `redeem-voucher` | `redeem voucher A7X-99` |
| Metric name | `app.` namespace, dots | `app.vouchers.redemptions` | `redemptions`, `app.time` |
| Metric attribute values | small closed set | `outcome=expired` | `voucher_code=A7X-99` |
| Span attribute keys | dotted namespaces | `voucher.type` | `voucherTypeValue` |
| Log fields | ids in fields; snake_case in Go, camelCase in Node | `slog.String("order_id", id)` | id interpolated into message |
| Log message | constant string | `"voucher redeemed"` | `fmt.Sprintf("voucher %s ...", code)` |

**Why the cardinality rules are hard rules here:** every distinct span name and
metric-attribute value mints new time series on a *shared* platform with a hard
series cap that rejects writes loudly when crossed. IDs are cheap in span
attributes and log fields, ruinous in span names and metric attributes.

## Decision table

| Situation | Add |
|---|---|
| New HTTP endpoint | Usually **nothing** — middleware traces it, RED metrics exist, request logs correlate. Business logs/counters only. |
| "Endpoint slow, but where?" | Child spans around suspect phases, then read the waterfall. |
| Business KPI ("how many X/hour?") | Counter with low-cardinality `outcome`/`type` attribute. |
| New cache/DB/queue dependency | The client **wrapper** (never raw clients) — the wrapper is what nests it into the trace. |
| Background job | One span per execution as a new root, completion counter with `outcome`, staleness gauge if timing matters. |
| "What did the payload look like?" | Log fields — sizes, types, flags; not full payload dumps. |

## Don'ts

- No span per helper function.
- No hand-rolled duration histograms for anything spanned.
- No ids/paths/timestamps in span names or metric attribute values.
- No logging inside per-item loops — aggregate, log once with counts. A
  500-item basket must not produce 500 log lines.
- (Go) No `context.Background()` mid-request-path; no bare `logger.Info` —
  only `...Context(ctx, ...)` correlates.
