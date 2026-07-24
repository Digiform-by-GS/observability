package sqlx

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"testing"
)

// A minimal in-memory driver so Open can be exercised without a real database.
// It does just enough for sql.Open + Ping + Close to succeed.
type fakeDriver struct{}
type fakeConn struct{}

func (fakeDriver) Open(string) (driver.Conn, error)  { return fakeConn{}, nil }
func (fakeConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (fakeConn) Close() error                        { return nil }
func (fakeConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }
func (fakeConn) Ping(context.Context) error          { return nil }
func (fakeConn) ResetSession(context.Context) error  { return nil }
func (fakeConn) IsValid() bool                       { return true }

func init() {
	sql.Register("fake-sqlx-test", fakeDriver{})
}

// Open must return a usable DB AND a close func. The close func is the point of
// the signature: otelsql.RegisterDBStatsMetrics returns a registration that has
// to be unregistered, or its callback keeps polling a closed pool forever. This
// test would fail to compile if Open regressed to returning a bare *sql.DB.
func TestOpenReturnsWorkingCloseFunc(t *testing.T) {
	db, closeFn, err := Open("fake-sqlx-test", "", "postgresql")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if db == nil {
		t.Fatal("Open returned a nil *sql.DB")
	}
	if closeFn == nil {
		t.Fatal("Open returned a nil close func — the pool metric registration would leak")
	}

	if err := db.PingContext(context.Background()); err != nil {
		t.Fatalf("Ping: %v", err)
	}

	// close must unregister the stats callback and close the pool without error.
	if err := closeFn(); err != nil {
		t.Errorf("close func returned an error: %v", err)
	}
}
