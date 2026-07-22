// Package sqlx wires database/sql to OpenTelemetry via XSAM/otelsql.
//
// Two things matter here and only one is obvious. The obvious one is query
// spans. The less obvious one is RegisterDBStatsMetrics: connection-pool
// exhaustion presents as "the database is slow" while the database sits idle,
// and the pool gauges are the only signal that distinguishes those two.
package sqlx

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/XSAM/otelsql"
	semconv "go.opentelemetry.io/otel/semconv/v1.30.0"
)

// Open returns an instrumented *sql.DB and a close function.
//
// Use the returned func instead of db.Close(): it also unregisters the pool
// metric callback, which otherwise keeps polling a closed pool for the life of
// the process.
//
// driverName is the registered database/sql driver (e.g. "pgx"); system is the
// semconv value for it (e.g. "postgresql"). Pool sizing stays with the caller —
// SetMaxOpenConns and friends are workload-specific, and a library guessing them
// causes exactly the exhaustion these metrics exist to reveal.
func Open(driverName, dsn, system string) (*sql.DB, func() error, error) {
	attrs := otelsql.WithAttributes(semconv.DBSystemNameKey.String(system))

	db, err := otelsql.Open(driverName, dsn, attrs)
	if err != nil {
		return nil, nil, fmt.Errorf("sqlx: open %s: %w", driverName, err)
	}

	// Pool gauges: open/idle/in-use connections, wait count, wait duration.
	// Without these a saturated pool is invisible.
	registration, err := otelsql.RegisterDBStatsMetrics(db, attrs)
	if err != nil {
		return nil, nil, errors.Join(
			fmt.Errorf("sqlx: register db stats: %w", err), db.Close())
	}

	closeFn := func() error {
		return errors.Join(registration.Unregister(), db.Close())
	}
	return db, closeFn, nil
}
