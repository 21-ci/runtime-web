// Package store owns the SQLite database: it opens the file, runs embedded
// goose migrations, and exposes the sqlc-generated queries in ./db.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"embed"
	"fmt"
	"net/url"
	"sync"
	"time"

	"github.com/21cloud/runtime-web/internal/store/db"
	"github.com/oklog/ulid/v2"
	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Store is the open database handle plus its generated queries.
type Store struct {
	sqlDB *sql.DB
	q     *db.Queries
}

// Open opens the SQLite database at path (or ":memory:"), applies the
// pragmas on every connection, and runs all pending migrations.
func Open(ctx context.Context, path string) (*Store, error) {
	dsn, memory := buildDSN(path)
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("store: open: %w", err)
	}
	if memory {
		// Each connection to a plain :memory: database is its own database,
		// so keep a single connection for the lifetime of the store.
		sqlDB.SetMaxOpenConns(1)
	}
	if err := sqlDB.PingContext(ctx); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("store: ping: %w", err)
	}
	if err := migrate(ctx, sqlDB); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("store: migrate: %w", err)
	}
	return &Store{sqlDB: sqlDB, q: db.New(sqlDB)}, nil
}

// buildDSN adds the connection pragmas to the modernc sqlite DSN.
func buildDSN(path string) (string, bool) {
	pragmas := url.Values{}
	pragmas.Add("_pragma", "journal_mode(WAL)")
	pragmas.Add("_pragma", "foreign_keys(ON)")
	pragmas.Add("_pragma", "busy_timeout(5000)")

	if path == ":memory:" {
		return "file::memory:?" + pragmas.Encode(), true
	}
	return "file:" + path + "?" + pragmas.Encode(), false
}

func migrate(ctx context.Context, sqlDB *sql.DB) error {
	goose.SetBaseFS(migrations)
	defer goose.SetBaseFS(nil)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("sqlite3"); err != nil {
		return fmt.Errorf("dialect: %w", err)
	}
	if err := goose.UpContext(ctx, sqlDB, "migrations"); err != nil {
		return fmt.Errorf("up: %w", err)
	}
	return nil
}

// Q returns the generated queries bound to the root connection.
func (s *Store) Q() *db.Queries {
	return s.q
}

// Tx runs fn inside a transaction, committing when fn returns nil and
// rolling back otherwise.
func (s *Store) Tx(ctx context.Context, fn func(*db.Queries) error) error {
	tx, err := s.sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin tx: %w", err)
	}
	if err := fn(s.q.WithTx(tx)); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit tx: %w", err)
	}
	return nil
}

// DB returns the underlying handle, for tooling and tests that need SQL
// outside the generated queries.
func (s *Store) DB() *sql.DB {
	return s.sqlDB
}

// Close releases the database handle.
func (s *Store) Close() error {
	return s.sqlDB.Close()
}

var (
	idMu      sync.Mutex
	idEntropy = ulid.Monotonic(rand.Reader, 0)
)

// NewID returns prefix followed by a monotonic ULID, so ids created later
// sort later within the process.
func NewID(prefix string) string {
	idMu.Lock()
	defer idMu.Unlock()
	return prefix + ulid.MustNew(ulid.Timestamp(time.Now()), idEntropy).String()
}
