package auth

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// Login methods and results, as allowed by the login_events table.
const (
	MethodPassword = "password"
	MethodOAuth    = "oauth"
	MethodInvite   = "invite"

	ResultOK          = "ok"
	ResultBadPassword = "bad_password"
	ResultBadTOTP     = "bad_totp"
	ResultRateLimited = "rate_limited"
	ResultDisabled    = "disabled"
	ResultSSOOnly     = "sso_only"
	// ResultMFAPending is a correct first factor awaiting its second;
	// CompleteMFA records ok once the code is accepted.
	ResultMFAPending = "mfa_pending"
)

// LoginEvent is one login attempt. UserID is empty for unknown users.
type LoginEvent struct {
	ID     string
	UserID string
	Email  string
	IP     string
	UA     string
	Method string
	Result string
	At     time.Time
}

// LoginEvents records and lists login attempts.
type LoginEvents struct {
	Q   *db.Queries
	Now func() time.Time
}

// Record stores ev, stamping it with the current time.
func (l *LoginEvents) Record(ctx context.Context, ev LoginEvent) error {
	now := time.Now()
	if l.Now != nil {
		now = l.Now()
	}
	err := l.Q.InsertLoginEvent(ctx, db.InsertLoginEventParams{
		ID:     store.NewID("lev_"),
		At:     now.UnixMilli(),
		UserID: sql.NullString{String: ev.UserID, Valid: ev.UserID != ""},
		Email:  ev.Email,
		Ip:     ev.IP,
		Ua:     ev.UA,
		Method: ev.Method,
		Result: ev.Result,
	})
	if err != nil {
		return fmt.Errorf("auth: record login event: %w", err)
	}
	return nil
}

// ListForUser returns userID's most recent login attempts, newest first.
func (l *LoginEvents) ListForUser(ctx context.Context, userID string, limit int) ([]LoginEvent, error) {
	rows, err := l.Q.ListLoginEventsForUser(ctx, db.ListLoginEventsForUserParams{
		UserID: sql.NullString{String: userID, Valid: true},
		Lim:    int64(limit),
	})
	if err != nil {
		return nil, fmt.Errorf("auth: list login events: %w", err)
	}
	out := make([]LoginEvent, 0, len(rows))
	for _, r := range rows {
		out = append(out, LoginEvent{
			ID: r.ID, UserID: r.UserID.String, Email: r.Email, IP: r.Ip, UA: r.Ua,
			Method: r.Method, Result: r.Result, At: time.UnixMilli(r.At),
		})
	}
	return out, nil
}
