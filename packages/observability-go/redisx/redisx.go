// Package redisx wires go-redis to OpenTelemetry.
//
// This exists as a package mainly to make one thing hard to forget: you need
// BOTH tracing and metrics. The collector's redis receiver already reports
// server-side health (memory, evictions, hit rate) — that tells you Redis is
// fine. It cannot tell you that one endpoint issues 400 sequential GETs per
// request, because from the server's side those are 400 perfectly healthy
// commands. Only client spans attribute Redis work back to the request that
// caused it.
package redisx

import (
	"fmt"

	"github.com/redis/go-redis/extra/redisotel/v9"
	"github.com/redis/go-redis/v9"
)

// Instrument enables tracing and metrics on a go-redis client.
//
// Call it immediately after constructing the client and before any command is
// issued — hooks added later do not apply retroactively.
func Instrument(client *redis.Client) error {
	// Produces a child span per command, so a slow request shows its Redis
	// calls nested under the HTTP span with their own timings.
	if err := redisotel.InstrumentTracing(client); err != nil {
		return fmt.Errorf("redisx: instrument tracing: %w", err)
	}

	// Connection-pool gauges (hits, misses, timeouts, idle). Pool exhaustion is
	// a common cause of latency that looks like "Redis is slow" while Redis is
	// idle — the pool metrics are what distinguish the two.
	if err := redisotel.InstrumentMetrics(client); err != nil {
		return fmt.Errorf("redisx: instrument metrics: %w", err)
	}

	return nil
}
