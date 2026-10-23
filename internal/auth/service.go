package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/seal"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// ErrInvalidCredentials is the single login failure for unknown users,
// wrong passwords and disabled users, so callers cannot tell them apart.
var ErrInvalidCredentials = errors.New("auth: invalid email or password")

// Service ties passwords, sessions, rate limiting, login history and setup
// together.
type Service struct {
	Store    *store.Store
	Hasher   Hasher
	Sessions *Sessions
	Events   *LoginEvents
	Limiter  *Limiter
	TOTP     *TOTP
	// SSOConfigured reports whether an OAuth/OIDC provider is configured;
	// nil means none. Policy.PasswordLoginDisabled requires one.
	SSOConfigured func(context.Context) bool
	// SetupToken is the token Setup requires (see NewSetupToken).
	SetupToken string
	// TrustedProxies are the peers (RTWEB_TRUSTED_PROXIES) whose X-Forwarded-For is honoured.
	TrustedProxies []netip.Prefix
	Now            func() time.Time

	dummyOnce sync.Once
	dummyHash string
}

// NewService wires a Service on st. sl seals TOTP secrets; dev selects
// the dev session cookie.
func NewService(st *store.Store, h Hasher, sl *seal.Sealer, setupToken string, dev bool) *Service {
	q := st.Q()
	lim := &Limiter{Q: q}
	return &Service{
		Store:      st,
		Hasher:     h,
		Sessions:   &Sessions{Q: q, Dev: dev},
		Events:     &LoginEvents{Q: q},
		Limiter:    lim,
		TOTP:       &TOTP{Q: q, Store: st, Sealer: sl, Hasher: h, Limiter: lim},
		SetupToken: setupToken,
	}
}

// LoginResult is a successful first factor. Cookie is a full session
// (with CSRF) or, when MFARequired, an MFA-pending session that only
// CompleteMFA accepts (CSRF empty).
type LoginResult struct {
	User        User
	MFARequired bool
	Cookie      string
	CSRF        string
}

// SetNow replaces the clock of the service and its parts.
func (s *Service) SetNow(now func() time.Time) {
	s.Now = now
	s.Sessions.Now = now
	s.Events.Now = now
	s.Limiter.Now = now
	s.TOTP.Now = now
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// dummy returns a real hash of a random value, verified for unknown users
// so they cost the same as known ones.
func (s *Service) dummy() string {
	s.dummyOnce.Do(func() {
		tok, err := randomHex(16)
		if err == nil {
			s.dummyHash, _ = s.Hasher.Hash(tok)
		}
		if s.dummyHash == "" {
			s.dummyHash = "$argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
		}
	})
	return s.dummyHash
}

func normalizeEmail(e string) string {
	return strings.ToLower(strings.TrimSpace(e))
}

// Login checks email and password. Unknown user, wrong password and
// disabled user all return ErrInvalidCredentials; 10 failures per 15 min
// per (ip, email) return apperr.ErrRateLimited. When the policy disables
// password login, users other than instance admins get a
// password_login_disabled Forbidden. Every attempt is recorded. On success
// it creates a session; users with TOTP get an MFA-pending one.
func (s *Service) Login(ctx context.Context, email, password, ip, ua string) (LoginResult, error) {
	email = normalizeEmail(email)
	ev := LoginEvent{Email: email, IP: ip, UA: ua, Method: MethodPassword}

	blocked, err := s.Limiter.Blocked(ctx, ip, email)
	if err != nil {
		return LoginResult{}, err
	}
	if blocked {
		if row, err := s.Store.Q().GetUserByEmail(ctx, email); err == nil {
			ev.UserID = row.ID
		}
		ev.Result = ResultRateLimited
		if err := s.Events.Record(ctx, ev); err != nil {
			return LoginResult{}, err
		}
		return LoginResult{}, fmt.Errorf("auth: login: %w", apperr.ErrRateLimited)
	}

	row, err := s.Store.Q().GetUserByEmail(ctx, email)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		s.Hasher.Verify(s.dummy(), password)
		return LoginResult{}, s.fail(ctx, ev, ResultBadPassword)
	case err != nil:
		return LoginResult{}, fmt.Errorf("auth: get user: %w", err)
	}
	ev.UserID = row.ID
	ok := s.Hasher.Verify(row.PasswordHash, password)
	if !ok {
		return LoginResult{}, s.fail(ctx, ev, ResultBadPassword)
	}
	if row.Disabled != 0 {
		return LoginResult{}, s.fail(ctx, ev, ResultDisabled)
	}
	if err := s.Limiter.Reset(ctx, ip, email); err != nil {
		return LoginResult{}, err
	}
	if row.IsInstanceAdmin == 0 {
		pol, err := s.Policy(ctx)
		if err != nil {
			return LoginResult{}, err
		}
		if pol.PasswordLoginDisabled {
			ev.Result = ResultSSOOnly
			if err := s.Events.Record(ctx, ev); err != nil {
				return LoginResult{}, err
			}
			return LoginResult{}, fmt.Errorf("auth: login: %w", apperr.Forbidden{Code: "password_login_disabled"})
		}
	}
	return s.begin(ctx, userFromRow(row), ev)
}

// LoginUser starts a session for a user already authenticated another way
// (method is MethodOAuth or MethodInvite). It applies the same disabled
// and second-factor checks as Login.
func (s *Service) LoginUser(ctx context.Context, userID, method, ip, ua string) (LoginResult, error) {
	row, err := s.Store.Q().GetUserByID(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return LoginResult{}, ErrInvalidCredentials
	}
	if err != nil {
		return LoginResult{}, fmt.Errorf("auth: get user: %w", err)
	}
	ev := LoginEvent{UserID: row.ID, Email: row.Email, IP: ip, UA: ua, Method: method}
	if row.Disabled != 0 {
		ev.Result = ResultDisabled
		if err := s.Events.Record(ctx, ev); err != nil {
			return LoginResult{}, err
		}
		return LoginResult{}, ErrInvalidCredentials
	}
	return s.begin(ctx, userFromRow(row), ev)
}

// begin records a successful first factor (mfa_pending or ok) and creates the session: an
// MFA-pending one if u has confirmed TOTP, a full one otherwise.
func (s *Service) begin(ctx context.Context, u User, ev LoginEvent) (LoginResult, error) {
	on, err := s.TOTP.Enabled(ctx, u.ID)
	if err != nil {
		return LoginResult{}, err
	}
	ev.Result = ResultOK
	if on {
		ev.Result = ResultMFAPending
	}
	if err := s.Events.Record(ctx, ev); err != nil {
		return LoginResult{}, err
	}
	if on {
		cookie, err := s.Sessions.CreatePending(ctx, u.ID, ev.IP, ev.UA)
		if err != nil {
			return LoginResult{}, err
		}
		return LoginResult{User: u, MFARequired: true, Cookie: cookie}, nil
	}
	cookie, csrf, err := s.Sessions.Create(ctx, u.ID, ev.IP, ev.UA)
	if err != nil {
		return LoginResult{}, err
	}
	return LoginResult{User: u, Cookie: cookie, CSRF: csrf}, nil
}

// CompleteMFA swaps an MFA-pending session for a full one given a TOTP
// code or a recovery code. Unknown, expired or full-session cookies are
// ErrNoSession; bad codes are ErrInvalidCode; failures share the
// second-factor limiter (apperr.ErrRateLimited).
func (s *Service) CompleteMFA(ctx context.Context, pendingCookie, code string) (string, string, error) {
	sess, u, err := s.Sessions.LookupPending(ctx, pendingCookie)
	if err != nil {
		return "", "", err
	}
	ev := LoginEvent{UserID: u.ID, Email: u.Email, IP: sess.IP, UA: sess.UA, Method: MethodPassword}
	if validCodeShape(normalizeCode(code)) {
		err = s.TOTP.Verify(ctx, u.ID, code)
	} else {
		err = s.TOTP.UseRecovery(ctx, u.ID, code)
	}
	if err != nil {
		switch {
		case errors.Is(err, apperr.ErrRateLimited):
			ev.Result = ResultRateLimited
		case errors.Is(err, ErrInvalidCode):
			ev.Result = ResultBadTOTP
		default:
			return "", "", err
		}
		if rerr := s.Events.Record(ctx, ev); rerr != nil {
			return "", "", rerr
		}
		return "", "", err
	}
	// Only the caller that deletes the pending row gets a session.
	n, err := s.Store.Q().DeleteSession(ctx, sess.ID)
	if err != nil {
		return "", "", fmt.Errorf("auth: delete pending session: %w", err)
	}
	if n == 0 {
		return "", "", ErrNoSession
	}
	ev.Result = ResultOK
	if err := s.Events.Record(ctx, ev); err != nil {
		return "", "", err
	}
	return s.Sessions.Create(ctx, u.ID, sess.IP, sess.UA)
}

func (s *Service) fail(ctx context.Context, ev LoginEvent, result string) error {
	if err := s.Limiter.Fail(ctx, ev.IP, ev.Email); err != nil {
		return err
	}
	ev.Result = result
	if err := s.Events.Record(ctx, ev); err != nil {
		return err
	}
	return ErrInvalidCredentials
}

// ChangePassword sets a new password after checking the current one, and
// revokes every other session of the user.
func (s *Service) ChangePassword(ctx context.Context, userID, currentSessionID, current, next string) error {
	row, err := s.Store.Q().GetUserByID(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("auth: user: %w", apperr.ErrNotFound)
	}
	if err != nil {
		return fmt.Errorf("auth: get user: %w", err)
	}
	if !s.Hasher.Verify(row.PasswordHash, current) {
		return ErrInvalidCredentials
	}
	if err := s.setPassword(ctx, userID, next, false); err != nil {
		return err
	}
	return s.Sessions.RevokeAllForUser(ctx, userID, currentSessionID)
}

// ResetPassword sets a temporary password the user must change, and
// revokes all of the user's sessions.
func (s *Service) ResetPassword(ctx context.Context, userID, temp string) error {
	if err := s.setPassword(ctx, userID, temp, true); err != nil {
		return err
	}
	return s.Sessions.RevokeAllForUser(ctx, userID, "")
}

func (s *Service) setPassword(ctx context.Context, userID, p string, mustChange bool) error {
	if err := ValidatePassword(p); err != nil {
		return err
	}
	hash, err := s.Hasher.Hash(p)
	if err != nil {
		return fmt.Errorf("auth: hash password: %w", err)
	}
	var must int64
	if mustChange {
		must = 1
	}
	n, err := s.Store.Q().UpdateUserPassword(ctx, db.UpdateUserPasswordParams{
		PasswordHash: hash, MustChangePassword: must, UpdatedAt: s.now().UnixMilli(), ID: userID,
	})
	if err != nil {
		return fmt.Errorf("auth: update password: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("auth: user: %w", apperr.ErrNotFound)
	}
	return nil
}

// SetDisabled disables or enables a user; disabling revokes all sessions.
func (s *Service) SetDisabled(ctx context.Context, userID string, disabled bool) error {
	var d int64
	if disabled {
		d = 1
	}
	n, err := s.Store.Q().SetUserDisabled(ctx, db.SetUserDisabledParams{Disabled: d, UpdatedAt: s.now().UnixMilli(), ID: userID})
	if err != nil {
		return fmt.Errorf("auth: set disabled: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("auth: user: %w", apperr.ErrNotFound)
	}
	if disabled {
		return s.Sessions.RevokeAllForUser(ctx, userID, "")
	}
	return nil
}
