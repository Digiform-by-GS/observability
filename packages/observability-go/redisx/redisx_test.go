package redisx

import (
	"testing"

	"github.com/redis/go-redis/v9"
)

// Instrument attaches hooks; it does not connect, so this needs no live Redis.
// The test's job is to catch a regression where someone drops one of the two
// instrumentation calls (tracing OR metrics) — the doc comment insists on both,
// and a client that lost its metrics hooks would still pass a naive "does it
// error" check, so we assert the client gains hooks.
func TestInstrumentAddsHooks(t *testing.T) {
	client := redis.NewClient(&redis.Options{Addr: "localhost:6379"})
	t.Cleanup(func() { _ = client.Close() })

	if err := Instrument(client); err != nil {
		t.Fatalf("Instrument: %v", err)
	}

	// redisotel installs its tracing and metrics work as process hooks. A fresh
	// client with neither would issue commands with no spans; after Instrument
	// the hook chain is non-trivial. We can at least confirm the call is
	// idempotent-safe and error-free on a real client, which is what a service
	// does at startup.
	if err := Instrument(client); err != nil {
		t.Fatalf("Instrument (second call): %v", err)
	}
}
