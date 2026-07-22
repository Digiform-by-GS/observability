package observability

import (
	"context"
	"log/slog"
	"os"

	"go.opentelemetry.io/contrib/bridges/otelslog"
)

// newLogger builds an slog.Logger that fans out to the OTel Logs API (→ OTLP →
// Loki) and, unless disabled, to stdout as JSON.
//
// The Node equivalent (packages/observability/src/logging.ts) had to work hard
// for correlation: its bridge must emit synchronously on the calling thread so
// context.active() is still in scope. Go has no such hazard — slog.Handler's
// Handle receives ctx as its first argument, so otelslog reads the active span
// directly. Correlation here is explicit context passing, which is why the
// Context-suffixed slog methods are mandatory.
func newLogger(cfg *Config) *slog.Logger {
	handlers := []slog.Handler{
		otelslog.NewHandler(cfg.ServiceName),
	}

	if !cfg.DisableStdoutLogs {
		handlers = append(handlers, slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
			Level: parseLevel(cfg.LogLevel),
		}))
	}

	return slog.New(&multiHandler{handlers: handlers})
}

// multiHandler fans one record out to several handlers. The stdout copy is what
// you read when the collector is unreachable — without it a collector outage
// means no logs anywhere, which is precisely when you need them most.
type multiHandler struct {
	handlers []slog.Handler
}

func (m *multiHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, h := range m.handlers {
		if h.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (m *multiHandler) Handle(ctx context.Context, record slog.Record) error {
	// Each handler gets its own clone: Handle may retain or mutate the record,
	// and slog.Record contains a shared attribute backing array.
	for _, h := range m.handlers {
		if !h.Enabled(ctx, record.Level) {
			continue
		}
		if err := h.Handle(ctx, record.Clone()); err != nil {
			return err
		}
	}
	return nil
}

func (m *multiHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := make([]slog.Handler, len(m.handlers))
	for i, h := range m.handlers {
		next[i] = h.WithAttrs(attrs)
	}
	return &multiHandler{handlers: next}
}

func (m *multiHandler) WithGroup(name string) slog.Handler {
	next := make([]slog.Handler, len(m.handlers))
	for i, h := range m.handlers {
		next[i] = h.WithGroup(name)
	}
	return &multiHandler{handlers: next}
}

func parseLevel(level string) slog.Level {
	switch level {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
