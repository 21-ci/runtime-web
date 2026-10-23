package auth

import (
	"context"
	"fmt"
	"time"

	"github.com/21cloud/runtime-web/internal/store/db"
)

const (
	// MaxLoginFailures is the failure budget per (ip, email) per window.
	MaxLoginFailures = 10
	// LoginFailureWindow is the sliding window for MaxLoginFailures.
	LoginFailureWindow = 15 * time.Minute
)

// Limiter counts failed logins per (ip, email) in SQLite.
type Limiter struct {
	Q   *db.Queries
	Now func() time.Time
}

func (l *Limiter) now() time.Time {
	if l.Now != nil {
		return l.Now()
	}
	return time.Now()
}

// Blocked reports whether (ip, email) has used its failure budget.
func (l *Limiter) Blocked(ctx context.Context, ip, email string) (bool, error) {
	n, err := l.Q.CountLoginFailuresSince(ctx, db.CountLoginFailuresSinceParams{
		Ip: ip, Email: email, Since: l.now().Add(-LoginFailureWindow).UnixMilli(),
	})
	if err != nil {
		return false, fmt.Errorf("auth: count login failures: %w", err)
	}
	return n >= MaxLoginFailures, nil
}

// Fail records one failure for (ip, email) and prunes old rows.
func (l *Limiter) Fail(ctx context.Context, ip, email string) error {
	now := l.now()
	if err := l.Q.InsertLoginFailure(ctx, db.InsertLoginFailureParams{Ip: ip, Email: email, At: now.UnixMilli()}); err != nil {
		return fmt.Errorf("auth: record login failure: %w", err)
	}
	if _, err := l.Q.DeleteLoginFailuresBefore(ctx, now.Add(-LoginFailureWindow).UnixMilli()); err != nil {
		return fmt.Errorf("auth: prune login failures: %w", err)
	}
	return nil
}

// Reset clears the failures of (ip, email) after a successful login.
func (l *Limiter) Reset(ctx context.Context, ip, email string) error {
	if err := l.Q.DeleteLoginFailures(ctx, db.DeleteLoginFailuresParams{Ip: ip, Email: email}); err != nil {
		return fmt.Errorf("auth: reset login failures: %w", err)
	}
	return nil
}
