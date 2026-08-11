package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" database/sql driver
	"github.com/redis/go-redis/v9"

	"github.com/digiform/observability/packages/observability-go/redisx"
	"github.com/digiform/observability/packages/observability-go/sqlx"
)

// deps holds the instrumented backing services. Both are optional: if the
// address is unset the service still starts and the corresponding route reports
// that it is disabled. A demo that refuses to boot without Redis teaches the
// wrong lesson about coupling.
type deps struct {
	redis   *redis.Client
	db      *sql.DB
	closeDB func() error
}

func openDeps(ctx context.Context) (*deps, error) {
	d := &deps{}

	if addr := os.Getenv("REDIS_ADDR"); addr != "" {
		client := redis.NewClient(&redis.Options{Addr: addr})

		// Instrument BEFORE issuing any command — hooks are not retroactive.
		if err := redisx.Instrument(client); err != nil {
			return nil, err
		}
		if err := client.Ping(ctx).Err(); err != nil {
			return nil, fmt.Errorf("ping redis at %s: %w", addr, err)
		}
		d.redis = client
	}

	if dsn := os.Getenv("POSTGRES_DSN"); dsn != "" {
		db, closeDB, err := sqlx.Open("pgx", dsn, "postgresql")
		if err != nil {
			return nil, err
		}

		// Pool sizing belongs to the app, not the library. Small on purpose:
		// a modest pool makes saturation observable in the pool gauges rather
		// than hiding it behind hundreds of idle connections.
		db.SetMaxOpenConns(10)
		db.SetMaxIdleConns(5)
		db.SetConnMaxLifetime(30 * time.Minute)

		pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if err := db.PingContext(pingCtx); err != nil {
			return nil, fmt.Errorf("ping postgres: %w", err)
		}

		if err := migrate(pingCtx, db); err != nil {
			return nil, err
		}
		d.db, d.closeDB = db, closeDB
	}

	return d, nil
}

// migrate creates the demo table. Real services use a migration tool; this is
// here so the example is runnable from an empty database.
func migrate(ctx context.Context, db *sql.DB) error {
	const stmt = `CREATE TABLE IF NOT EXISTS widgets (
		id    SERIAL PRIMARY KEY,
		name  TEXT NOT NULL,
		price INTEGER NOT NULL
	)`
	if _, err := db.ExecContext(ctx, stmt); err != nil {
		return fmt.Errorf("create widgets table: %w", err)
	}

	var count int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM widgets`).Scan(&count); err != nil {
		return fmt.Errorf("count widgets: %w", err)
	}
	if count == 0 {
		if _, err := db.ExecContext(ctx,
			`INSERT INTO widgets (name, price) VALUES ($1,$2), ($3,$4), ($5,$6)`,
			"sprocket", 199, "flange", 249, "grommet", 99); err != nil {
			return fmt.Errorf("seed widgets: %w", err)
		}
	}
	return nil
}

func (d *deps) Close() error {
	if d.closeDB != nil {
		if err := d.closeDB(); err != nil {
			return err
		}
	}
	if d.redis != nil {
		return d.redis.Close()
	}
	return nil
}
