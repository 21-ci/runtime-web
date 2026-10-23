package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/store/db"
)

const (
	// IdleTTL is how long a session lives without use.
	IdleTTL = 7 * 24 * time.Hour
	// AbsoluteTTL is the hard session lifetime from creation.
	AbsoluteTTL = 30 * 24 * time.Hour
	// MFAPendingTTL is the lifetime of a session waiting for its second
	// factor.
	MFAPendingTTL = 5 * time.Minute
	// touchEvery limits last_seen_at writes to one per interval.
	touchEvery = time.Minute

	cookieName    = "rtw_session"
	cookieNameTLS = "__Host-rtw_session"
	publicIDLen   = 12
)

// ErrNoSession means the cookie names no live session.
var ErrNoSession = errors.New("auth: no session")

// User is the authenticated user as seen by the auth layer.
type User struct {
	ID                 string
	Email              string
	Name               string
	MustChangePassword bool
	IsInstanceAdmin    bool
	Disabled           bool
}

func userFromRow(u db.User) User {
	return User{
		ID:                 u.ID,
		Email:              u.Email,
		Name:               u.Name,
		MustChangePassword: u.MustChangePassword != 0,
		IsInstanceAdmin:    u.IsInstanceAdmin != 0,
		Disabled:           u.Disabled != 0,
	}
}

// Session is a live session. ID is the stored sha256 of the cookie value.
type Session struct {
	ID         string
	UserID     string
	CSRF       string
	CreatedAt  time.Time
	LastSeenAt time.Time
	ExpiresAt  time.Time
	// IP and UA are set by LookupPending only.
	IP string
	UA string
}

// SessionInfo is a session as listed to its owner. ID is public: the first
// 12 hex characters of the stored hash.
type SessionInfo struct {
	ID         string
	IP         string
	UA         string
	CreatedAt  time.Time
	LastSeenAt time.Time
	Current    bool
}

// Sessions stores sessions in SQLite under sha256(cookie value).
type Sessions struct {
	Q   *db.Queries
	Now func() time.Time
	// Dev drops Secure and the __Host- prefix from the cookie.
	Dev bool
}

func (s *Sessions) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// hashCookie returns the stored id for a cookie value, or false if the
// value is not 32 hex-encoded bytes.
func hashCookie(v string) (string, bool) {
	raw, err := hex.DecodeString(v)
	if err != nil || len(raw) != 32 {
		return "", false
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), true
}

// Create starts a session and returns the cookie value and CSRF token.
func (s *Sessions) Create(ctx context.Context, userID, ip, ua string) (string, string, error) {
	return s.create(ctx, userID, ip, ua, false)
}

// CreatePending starts an MFA-pending session that lives MFAPendingTTL and
// is accepted only by LookupPending. It returns the cookie value.
func (s *Sessions) CreatePending(ctx context.Context, userID, ip, ua string) (string, error) {
	cookie, _, err := s.create(ctx, userID, ip, ua, true)
	return cookie, err
}

func (s *Sessions) create(ctx context.Context, userID, ip, ua string, pending bool) (string, string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", fmt.Errorf("auth: session id: %w", err)
	}
	csrf, err := randomHex(32)
	if err != nil {
		return "", "", fmt.Errorf("auth: csrf: %w", err)
	}
	cookie := hex.EncodeToString(raw)
	idHash, _ := hashCookie(cookie)
	now := s.now()
	ttl, mfa := AbsoluteTTL, int64(0)
	if pending {
		ttl, mfa = MFAPendingTTL, 1
	}
	err = s.Q.CreateSession(ctx, db.CreateSessionParams{
		IDHash:     idHash,
		UserID:     userID,
		Csrf:       csrf,
		MfaPending: mfa,
		CreatedAt:  now.UnixMilli(),
		LastSeenAt: now.UnixMilli(),
		ExpiresAt:  now.Add(ttl).UnixMilli(),
		Ip:         ip,
		UserAgent:  ua,
	})
	if err != nil {
		return "", "", fmt.Errorf("auth: create session: %w", err)
	}
	if pending {
		return cookie, "", nil
	}
	return cookie, csrf, nil
}

// LookupPending resolves an MFA-pending cookie to its session and user.
// Full, expired and disabled-user sessions are ErrNoSession.
func (s *Sessions) LookupPending(ctx context.Context, cookie string) (Session, User, error) {
	idHash, ok := hashCookie(cookie)
	if !ok {
		return Session{}, User{}, ErrNoSession
	}
	row, err := s.Q.GetSession(ctx, idHash)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, User{}, ErrNoSession
	}
	if err != nil {
		return Session{}, User{}, fmt.Errorf("auth: get session: %w", err)
	}
	if row.MfaPending == 0 {
		return Session{}, User{}, ErrNoSession
	}
	if s.now().UnixMilli() >= row.ExpiresAt {
		if _, err := s.Q.DeleteSession(ctx, idHash); err != nil {
			return Session{}, User{}, fmt.Errorf("auth: delete expired session: %w", err)
		}
		return Session{}, User{}, ErrNoSession
	}
	urow, err := s.Q.GetUserByID(ctx, row.UserID)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, User{}, ErrNoSession
	}
	if err != nil {
		return Session{}, User{}, fmt.Errorf("auth: get session user: %w", err)
	}
	if urow.Disabled != 0 {
		return Session{}, User{}, ErrNoSession
	}
	return Session{
		ID:         row.IDHash,
		UserID:     row.UserID,
		CreatedAt:  time.UnixMilli(row.CreatedAt),
		LastSeenAt: time.UnixMilli(row.LastSeenAt),
		ExpiresAt:  time.UnixMilli(row.ExpiresAt),
		IP:         row.Ip,
		UA:         row.UserAgent,
	}, userFromRow(urow), nil
}

// Lookup resolves a cookie value to its session and user, sliding the idle
// window. Expired, MFA-pending and disabled-user sessions are ErrNoSession.
func (s *Sessions) Lookup(ctx context.Context, cookie string) (Session, User, error) {
	idHash, ok := hashCookie(cookie)
	if !ok {
		return Session{}, User{}, ErrNoSession
	}
	row, err := s.Q.GetSession(ctx, idHash)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, User{}, ErrNoSession
	}
	if err != nil {
		return Session{}, User{}, fmt.Errorf("auth: get session: %w", err)
	}
	now := s.now()
	last := time.UnixMilli(row.LastSeenAt)
	if now.UnixMilli() >= row.ExpiresAt || now.Sub(last) >= IdleTTL {
		if _, err := s.Q.DeleteSession(ctx, idHash); err != nil {
			return Session{}, User{}, fmt.Errorf("auth: delete expired session: %w", err)
		}
		return Session{}, User{}, ErrNoSession
	}
	if row.MfaPending != 0 {
		return Session{}, User{}, ErrNoSession
	}
	urow, err := s.Q.GetUserByID(ctx, row.UserID)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, User{}, ErrNoSession
	}
	if err != nil {
		return Session{}, User{}, fmt.Errorf("auth: get session user: %w", err)
	}
	if urow.Disabled != 0 {
		return Session{}, User{}, ErrNoSession
	}
	if now.Sub(last) >= touchEvery {
		if _, err := s.Q.TouchSession(ctx, db.TouchSessionParams{LastSeenAt: now.UnixMilli(), IDHash: idHash}); err != nil {
			return Session{}, User{}, fmt.Errorf("auth: touch session: %w", err)
		}
		last = now
	}
	return Session{
		ID:         row.IDHash,
		UserID:     row.UserID,
		CSRF:       row.Csrf,
		CreatedAt:  time.UnixMilli(row.CreatedAt),
		LastSeenAt: last,
		ExpiresAt:  time.UnixMilli(row.ExpiresAt),
	}, userFromRow(urow), nil
}

// Revoke deletes one session by its stored id.
func (s *Sessions) Revoke(ctx context.Context, sessionID string) error {
	if _, err := s.Q.DeleteSession(ctx, sessionID); err != nil {
		return fmt.Errorf("auth: revoke session: %w", err)
	}
	return nil
}

// RevokeAllForUser deletes every session of userID except exceptSessionID
// (empty revokes all).
func (s *Sessions) RevokeAllForUser(ctx context.Context, userID, exceptSessionID string) error {
	_, err := s.Q.DeleteSessionsForUserExcept(ctx, db.DeleteSessionsForUserExceptParams{UserID: userID, ExceptIDHash: exceptSessionID})
	if err != nil {
		return fmt.Errorf("auth: revoke user sessions: %w", err)
	}
	return nil
}

// ListForUser lists userID's sessions; currentSessionID is marked Current.
func (s *Sessions) ListForUser(ctx context.Context, userID, currentSessionID string) ([]SessionInfo, error) {
	rows, err := s.Q.ListSessionsForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("auth: list sessions: %w", err)
	}
	now := s.now()
	out := make([]SessionInfo, 0, len(rows))
	for _, r := range rows {
		if now.UnixMilli() >= r.ExpiresAt || now.Sub(time.UnixMilli(r.LastSeenAt)) >= IdleTTL {
			continue
		}
		out = append(out, SessionInfo{
			ID:         r.IDHash[:publicIDLen],
			IP:         r.Ip,
			UA:         r.UserAgent,
			CreatedAt:  time.UnixMilli(r.CreatedAt),
			LastSeenAt: time.UnixMilli(r.LastSeenAt),
			Current:    r.IDHash == currentSessionID,
		})
	}
	return out, nil
}

// RevokeByPublicID revokes one of userID's sessions by its public id.
// Unknown ids and other users' sessions are apperr.ErrNotFound.
func (s *Sessions) RevokeByPublicID(ctx context.Context, userID, publicID string) error {
	if len(publicID) != publicIDLen {
		return fmt.Errorf("auth: session: %w", apperr.ErrNotFound)
	}
	if _, err := hex.DecodeString(publicID); err != nil {
		return fmt.Errorf("auth: session: %w", apperr.ErrNotFound)
	}
	rows, err := s.Q.ListSessionsForUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("auth: list sessions: %w", err)
	}
	publicID = strings.ToLower(publicID)
	for _, r := range rows {
		if r.IDHash[:publicIDLen] == publicID {
			return s.Revoke(ctx, r.IDHash)
		}
	}
	return fmt.Errorf("auth: session: %w", apperr.ErrNotFound)
}

// CookieName is the session cookie name for this mode.
func (s *Sessions) CookieName() string {
	if s.Dev {
		return cookieName
	}
	return cookieNameTLS
}

func (s *Sessions) cookie(value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     s.CookieName(),
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   !s.Dev,
		SameSite: http.SameSiteLaxMode,
	}
}

// SetCookie writes the session cookie.
func (s *Sessions) SetCookie(w http.ResponseWriter, value string) {
	http.SetCookie(w, s.cookie(value, int(AbsoluteTTL/time.Second)))
}

// ClearCookie expires the session cookie.
func (s *Sessions) ClearCookie(w http.ResponseWriter) {
	http.SetCookie(w, s.cookie("", -1))
}
