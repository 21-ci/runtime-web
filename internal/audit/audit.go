// Package audit records and lists admin actions. Entries are append-only.
package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

const (
	defaultLimit = 50
	maxLimit     = 200
)

// Actor is who performed an audited action. UserID is "cli" for CLI actions.
type Actor struct {
	UserID          string
	AsInstanceAdmin bool
}

// Entry is one audit row.
type Entry struct {
	ID              string
	At              int64
	ActorUserID     string
	AsInstanceAdmin bool
	OrgID           *string
	Action          string
	Target          string
	Detail          string
}

// Filter narrows List. A nil OrgID lists instance-wide entries across all orgs.
type Filter struct {
	OrgID       *string
	ActorUserID string
	Action      string
	// Before is the cursor returned by a previous List call; empty starts at the newest.
	Before string
	// Limit is the page size; zero means 50 and the maximum is 200.
	Limit int
}

// Log appends one entry. An empty orgID records an instance-wide entry; detail is JSON-encoded
// when non-nil.
func Log(ctx context.Context, q *db.Queries, actor Actor, orgID, action, target string, detail any) error {
	var d string
	if detail != nil {
		b, err := json.Marshal(detail)
		if err != nil {
			return fmt.Errorf("audit: encode detail: %w", err)
		}
		d = string(b)
	}
	err := q.InsertAudit(ctx, db.InsertAuditParams{
		ID:              store.NewID("aud_"),
		At:              time.Now().UnixMilli(),
		ActorUserID:     sql.NullString{String: actor.UserID, Valid: actor.UserID != ""},
		AsInstanceAdmin: boolInt(actor.AsInstanceAdmin),
		OrgID:           nullString(orgID),
		Action:          action,
		Target:          target,
		Detail:          d,
	})
	if err != nil {
		return fmt.Errorf("audit: insert %s: %w", action, err)
	}
	return nil
}

// List returns one page of entries, newest first, and the cursor for the next page ("" when none).
func List(ctx context.Context, q *db.Queries, f Filter) ([]Entry, string, error) {
	limit := f.Limit
	switch {
	case limit <= 0:
		limit = defaultLimit
	case limit > maxLimit:
		limit = maxLimit
	}
	p := db.ListAuditFilteredParams{Limit: int64(limit)}
	if f.OrgID != nil {
		p.OrgID = *f.OrgID
	}
	if f.ActorUserID != "" {
		p.ActorUserID = f.ActorUserID
	}
	if f.Action != "" {
		p.Action = f.Action
	}
	if f.Before != "" {
		at, id, err := decodeCursor(f.Before)
		if err != nil {
			return nil, "", err
		}
		p.BeforeAt = at
		p.BeforeID = sql.NullString{String: id, Valid: true}
	}
	rows, err := q.ListAuditFiltered(ctx, p)
	if err != nil {
		return nil, "", fmt.Errorf("audit: list: %w", err)
	}
	out := make([]Entry, 0, len(rows))
	for _, r := range rows {
		out = append(out, entryFrom(r))
	}
	next := ""
	if len(out) == limit {
		last := out[len(out)-1]
		next = encodeCursor(last.At, last.ID)
	}
	return out, next, nil
}

func entryFrom(r db.Audit) Entry {
	e := Entry{
		ID:              r.ID,
		At:              r.At,
		ActorUserID:     r.ActorUserID.String,
		AsInstanceAdmin: r.AsInstanceAdmin != 0,
		Action:          r.Action,
		Target:          r.Target,
		Detail:          r.Detail,
	}
	if r.OrgID.Valid {
		org := r.OrgID.String
		e.OrgID = &org
	}
	return e
}

func encodeCursor(at int64, id string) string {
	return strconv.FormatInt(at, 10) + ":" + id
}

func decodeCursor(c string) (int64, string, error) {
	at, id, ok := strings.Cut(c, ":")
	if !ok || id == "" {
		return 0, "", fmt.Errorf("audit: bad cursor: %w", apperr.ErrInvalid)
	}
	n, err := strconv.ParseInt(at, 10, 64)
	if err != nil {
		return 0, "", fmt.Errorf("audit: bad cursor: %w", apperr.ErrInvalid)
	}
	return n, id, nil
}

func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

func nullString(s string) sql.NullString {
	return sql.NullString{String: s, Valid: s != ""}
}
