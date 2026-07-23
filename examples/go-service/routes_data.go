package main

import (
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// mountDataRoutes adds the Redis- and Postgres-backed endpoints. Each Redis
// command and SQL query becomes a child span of the HTTP span, so a slow
// request shows exactly which backend call cost the time.
func mountDataRoutes(r chi.Router, d *deps, m *messaging, log *slog.Logger, requests metric.Int64Counter) {
	// /publish sends an order to RabbitMQ. The producer span is PRODUCER-kind
	// and lives in the HTTP request's trace; the consumer will start a separate
	// trace linked back to it. ?fail=1 makes the consumer dead-letter it.
	r.Post("/publish", func(w http.ResponseWriter, req *http.Request) {
		ctx := req.Context()
		requests.Add(ctx, 1, metric.WithAttributes(attribute.String("route", "/publish")))

		if m == nil {
			writeJSON(w, http.StatusServiceUnavailable,
				map[string]string{"error": "rabbitmq not configured (set RABBITMQ_URL)"})
			return
		}

		orderID := fmt.Sprintf("ord-%d", time.Now().UnixNano())
		if req.URL.Query().Get("fail") == "1" {
			orderID = "fail-" + orderID
		}

		if err := m.publishOrder(ctx, orderID, 42); err != nil {
			log.ErrorContext(ctx, "publish failed", slog.Any("error", err))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		log.InfoContext(ctx, "order published", slog.String("order_id", orderID))
		writeJSON(w, http.StatusAccepted, map[string]any{"published": true, "order_id": orderID})
	})
	r.Get("/cache", func(w http.ResponseWriter, req *http.Request) {
		ctx := req.Context()
		requests.Add(ctx, 1, metric.WithAttributes(attribute.String("route", "/cache")))

		if d.redis == nil {
			writeJSON(w, http.StatusServiceUnavailable,
				map[string]string{"error": "redis not configured (set REDIS_ADDR)"})
			return
		}

		key := "demo:counter"
		count, err := d.redis.Incr(ctx, key).Result()
		if err != nil {
			log.ErrorContext(ctx, "redis incr failed", slog.Any("error", err))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if err := d.redis.Expire(ctx, key, 10*time.Minute).Err(); err != nil {
			log.WarnContext(ctx, "redis expire failed", slog.Any("error", err))
		}

		log.InfoContext(ctx, "cache hit", slog.String("key", key), slog.Int64("count", count))
		writeJSON(w, http.StatusOK, map[string]any{"key": key, "count": count})
	})

	r.Get("/widgets", func(w http.ResponseWriter, req *http.Request) {
		ctx := req.Context()
		requests.Add(ctx, 1, metric.WithAttributes(attribute.String("route", "/widgets")))

		if d.db == nil {
			writeJSON(w, http.StatusServiceUnavailable,
				map[string]string{"error": "postgres not configured (set POSTGRES_DSN)"})
			return
		}

		rows, err := d.db.QueryContext(ctx, `SELECT id, name, price FROM widgets ORDER BY id`)
		if err != nil {
			log.ErrorContext(ctx, "query widgets failed", slog.Any("error", err))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		defer rows.Close() //nolint:errcheck // deferred close on a read-only query

		type widget struct {
			ID    int    `json:"id"`
			Name  string `json:"name"`
			Price int    `json:"price"`
		}
		var widgets []widget
		for rows.Next() {
			var wdg widget
			if err := rows.Scan(&wdg.ID, &wdg.Name, &wdg.Price); err != nil {
				log.ErrorContext(ctx, "scan widget failed", slog.Any("error", err))
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			widgets = append(widgets, wdg)
		}
		if err := rows.Err(); err != nil {
			log.ErrorContext(ctx, "iterate widgets failed", slog.Any("error", err))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		log.InfoContext(ctx, "widgets listed", slog.Int("count", len(widgets)))
		writeJSON(w, http.StatusOK, map[string]any{"widgets": widgets})
	})

	// /widgets/slow is deliberately written badly: it issues one query per row
	// (the classic N+1) plus a Redis GET each. Server-side metrics stay
	// completely healthy while it runs — Postgres and Redis each see a stream of
	// fast, correct commands. Only the client spans show ~2N nested calls under
	// one request, which is the entire argument for instrumenting both sides.
	r.Get("/widgets/slow", func(w http.ResponseWriter, req *http.Request) {
		ctx := req.Context()
		requests.Add(ctx, 1, metric.WithAttributes(attribute.String("route", "/widgets/slow")))

		if d.db == nil {
			writeJSON(w, http.StatusServiceUnavailable,
				map[string]string{"error": "postgres not configured (set POSTGRES_DSN)"})
			return
		}

		ids, err := widgetIDs(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}

		total := 0
		for _, id := range ids {
			var price int
			err := d.db.QueryRowContext(ctx,
				`SELECT price FROM widgets WHERE id = $1`, id).Scan(&price)
			switch {
			case errors.Is(err, sql.ErrNoRows):
				continue
			case err != nil:
				log.ErrorContext(ctx, "n+1 query failed",
					slog.Int("widget_id", id), slog.Any("error", err))
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			total += price

			if d.redis != nil {
				// A cache lookup per row, for good measure.
				if err := d.redis.Get(ctx, fmt.Sprintf("widget:%d", id)).Err(); err != nil &&
					!errors.Is(err, redis.Nil) {
					log.WarnContext(ctx, "cache lookup failed", slog.Any("error", err))
				}
			}
		}

		log.InfoContext(ctx, "n+1 walk complete",
			slog.Int("widget_count", len(ids)), slog.Int("total_price", total))
		writeJSON(w, http.StatusOK, map[string]any{"widgets": len(ids), "total_price": total})
	})
}

func widgetIDs(req *http.Request) ([]int, error) {
	n := 12
	if raw := req.URL.Query().Get("n"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			return nil, fmt.Errorf("invalid n: %w", err)
		}
		// Bounded: an unbounded n would let a caller generate an arbitrarily
		// large trace, which is its own kind of outage.
		if parsed < 1 || parsed > 100 {
			return nil, errors.New("n must be between 1 and 100")
		}
		n = parsed
	}

	ids := make([]int, 0, n)
	for i := 1; i <= n; i++ {
		ids = append(ids, i)
	}
	return ids, nil
}
