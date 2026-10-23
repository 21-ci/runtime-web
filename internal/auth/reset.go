package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// Reset2FA clears the user's TOTP and recovery codes, revokes all their
// sessions and writes an audit row by actor (such as "cli"), in one
// transaction. The audit row has no actor user; actor is recorded in its
// detail. It returns the user id; unknown emails are ErrNotFound.
func Reset2FA(ctx context.Context, st *store.Store, email, actor string, now time.Time) (string, error) {
	var userID string
	err := st.Tx(ctx, func(q *db.Queries) error {
		u, err := q.GetUserByEmail(ctx, normalizeEmail(email))
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("auth: user: %w", apperr.ErrNotFound)
		}
		if err != nil {
			return fmt.Errorf("auth: get user: %w", err)
		}
		userID = u.ID
		if err := clear2FA(ctx, q, u.ID); err != nil {
			return err
		}
		if _, err := q.DeleteSessionsForUser(ctx, u.ID); err != nil {
			return fmt.Errorf("auth: revoke user sessions: %w", err)
		}
		err = q.InsertAudit(ctx, db.InsertAuditParams{
			ID:     store.NewID("aud_"),
			At:     now.UnixMilli(),
			Action: "user.reset_2fa",
			Target: u.ID,
			Detail: "actor=" + actor + " email=" + u.Email,
		})
		if err != nil {
			return fmt.Errorf("auth: audit: %w", err)
		}
		return nil
	})
	return userID, err
}
