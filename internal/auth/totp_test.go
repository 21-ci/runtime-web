package auth

import (
	"context"
	"database/sql"
	"encoding/base32"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// secretFromURL extracts the raw TOTP secret from an otpauth URL.
func secretFromURL(t *testing.T, raw string) []byte {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse otpauth url: %v", err)
	}
	if u.Scheme != "otpauth" || u.Host != "totp" {
		t.Fatalf("otpauth url = %q", raw)
	}
	sec, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(u.Query().Get("secret"))
	if err != nil {
		t.Fatalf("decode secret: %v", err)
	}
	return sec
}

func (e *env) codeAt(secret []byte, at time.Time) string {
	return totpCode(secret, at.Unix()/totpPeriod)
}

// enroll enrolls and confirms TOTP for userID and returns the secret and
// recovery codes. The clock advances one step so the next code is fresh.
func (e *env) enroll(t *testing.T, userID string) ([]byte, []string) {
	t.Helper()
	ctx := context.Background()
	link, err := e.svc.TOTP.Enroll(ctx, userID)
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}
	sec := secretFromURL(t, link)
	codes, err := e.svc.TOTP.Confirm(ctx, userID, e.codeAt(sec, e.clock.Now()))
	if err != nil {
		t.Fatalf("Confirm: %v", err)
	}
	e.clock.Advance(totpPeriod * time.Second)
	return sec, codes
}

func TestTOTPCodeRFC6238(t *testing.T) {
	// RFC 6238 appendix B, SHA-1, truncated to 6 digits.
	secret := []byte("12345678901234567890")
	tests := []struct {
		unix int64
		want string
	}{
		{59, "287082"},
		{1111111109, "081804"},
		{1234567890, "005924"},
		{2000000000, "279037"},
	}
	for _, tt := range tests {
		if got := totpCode(secret, tt.unix/totpPeriod); got != tt.want {
			t.Errorf("totpCode(%d) = %s, want %s", tt.unix, got, tt.want)
		}
	}
}

func TestTOTPEnrollRequiresValidCode(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")

	link, err := e.svc.TOTP.Enroll(ctx, u.ID)
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}
	row, err := e.st.Q().GetUserTOTP(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserTOTP: %v", err)
	}
	if row.EnabledAt.Valid {
		t.Fatal("enabled_at set before Confirm")
	}
	sec := secretFromURL(t, link)
	if string(row.SecretSealed) == string(sec) {
		t.Fatal("secret stored unsealed")
	}
	if on, _ := e.svc.TOTP.Enabled(ctx, u.ID); on {
		t.Fatal("Enabled before Confirm")
	}

	for _, bad := range []string{"", "12345", "abcdef", wrongCode(e.codeAt(sec, e.clock.Now()))} {
		if _, err := e.svc.TOTP.Confirm(ctx, u.ID, bad); !errors.Is(err, ErrInvalidCode) {
			t.Fatalf("Confirm(%q) err = %v, want ErrInvalidCode", bad, err)
		}
	}
	codes, err := e.svc.TOTP.Confirm(ctx, u.ID, e.codeAt(sec, e.clock.Now()))
	if err != nil {
		t.Fatalf("Confirm: %v", err)
	}
	if len(codes) != RecoveryCodeCount {
		t.Fatalf("recovery codes = %d, want %d", len(codes), RecoveryCodeCount)
	}
	if on, _ := e.svc.TOTP.Enabled(ctx, u.ID); !on {
		t.Fatal("not Enabled after Confirm")
	}
	_, err = e.svc.TOTP.Enroll(ctx, u.ID)
	if c, ok := apperr.ConflictCode(err); !ok || c != "totp_already_enabled" {
		t.Fatalf("Enroll while enabled err = %v, want totp_already_enabled", err)
	}
}

// wrongCode returns a valid-looking code different from c.
func wrongCode(c string) string {
	b := []byte(c)
	b[0] = '0' + (b[0]-'0'+1)%10
	return string(b)
}

func TestTOTPReplayRejected(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	sec, _ := e.enroll(t, u.ID)

	code := e.codeAt(sec, e.clock.Now())
	if err := e.svc.TOTP.Verify(ctx, u.ID, code); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if err := e.svc.TOTP.Verify(ctx, u.ID, code); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("replayed Verify err = %v, want ErrInvalidCode", err)
	}
	// The previous step's code is inside the ±1 window but older than the
	// last used step.
	e.clock.Advance(10 * time.Second)
	prev := e.codeAt(sec, e.clock.Now().Add(-totpPeriod*time.Second))
	if err := e.svc.TOTP.Verify(ctx, u.ID, prev); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("older step Verify err = %v, want ErrInvalidCode", err)
	}
	e.clock.Advance(totpPeriod * time.Second)
	if err := e.svc.TOTP.Verify(ctx, u.ID, e.codeAt(sec, e.clock.Now())); err != nil {
		t.Fatalf("next step Verify: %v", err)
	}
}

func TestTOTPWindow(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	sec, _ := e.enroll(t, u.ID)
	far := e.codeAt(sec, e.clock.Now().Add(2*totpPeriod*time.Second))
	if err := e.svc.TOTP.Verify(ctx, u.ID, far); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("+2 step Verify err = %v, want ErrInvalidCode", err)
	}
	next := e.codeAt(sec, e.clock.Now().Add(totpPeriod*time.Second))
	if err := e.svc.TOTP.Verify(ctx, u.ID, next); err != nil {
		t.Fatalf("+1 step Verify: %v", err)
	}
}

func TestRecoveryCodesShownOnceAndConsumed(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	_, codes := e.enroll(t, u.ID)

	seen := map[string]bool{}
	for _, c := range codes {
		if seen[c] {
			t.Fatalf("duplicate recovery code %q", c)
		}
		seen[c] = true
	}
	rows, err := e.st.Q().CountUnusedRecoveryCodes(ctx, u.ID)
	if err != nil || rows != RecoveryCodeCount {
		t.Fatalf("unused codes = %d, %v", rows, err)
	}
	// Stored as hashes, never plaintext.
	for _, c := range codes {
		n, err := e.st.Q().ConsumeRecoveryCode(ctx, db.ConsumeRecoveryCodeParams{
			UsedAt: sql.NullInt64{Int64: 1, Valid: true}, UserID: u.ID, Hash: c,
		})
		if err != nil || n != 0 {
			t.Fatalf("recovery code stored in plaintext (%d, %v)", n, err)
		}
	}

	if err := e.svc.TOTP.UseRecovery(ctx, u.ID, codes[0]); err != nil {
		t.Fatalf("UseRecovery: %v", err)
	}
	if err := e.svc.TOTP.UseRecovery(ctx, u.ID, codes[0]); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("reused recovery err = %v, want ErrInvalidCode", err)
	}
	if err := e.svc.TOTP.UseRecovery(ctx, u.ID, "zzzz-zzzz-zzzz-zzzz"); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("unknown recovery err = %v, want ErrInvalidCode", err)
	}

	// Regenerate needs the password, replaces every old code.
	if _, err := e.svc.TOTP.Regenerate(ctx, u.ID, "wrong-password-1"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Regenerate bad password err = %v", err)
	}
	fresh, err := e.svc.TOTP.Regenerate(ctx, u.ID, "password-123456")
	if err != nil || len(fresh) != RecoveryCodeCount {
		t.Fatalf("Regenerate = %d codes, %v", len(fresh), err)
	}
	if err := e.svc.TOTP.UseRecovery(ctx, u.ID, codes[1]); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("old code after Regenerate err = %v", err)
	}
	if err := e.svc.TOTP.UseRecovery(ctx, u.ID, fresh[1]); err != nil {
		t.Fatalf("new code: %v", err)
	}
}

func TestTOTPRateLimited(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	sec, _ := e.enroll(t, u.ID)

	good := e.codeAt(sec, e.clock.Now())
	for i := 0; i < MaxTOTPFailures; i++ {
		if err := e.svc.TOTP.Verify(ctx, u.ID, wrongCode(good)); !errors.Is(err, ErrInvalidCode) {
			t.Fatalf("failure %d err = %v", i, err)
		}
	}
	if err := e.svc.TOTP.Verify(ctx, u.ID, good); !errors.Is(err, apperr.ErrRateLimited) {
		t.Fatalf("Verify after budget err = %v, want ErrRateLimited", err)
	}
	if err := e.svc.TOTP.UseRecovery(ctx, u.ID, "aaaa-aaaa-aaaa-aaaa"); !errors.Is(err, apperr.ErrRateLimited) {
		t.Fatalf("UseRecovery after budget err = %v, want ErrRateLimited", err)
	}
	e.clock.Advance(LoginFailureWindow + time.Second)
	if err := e.svc.TOTP.Verify(ctx, u.ID, e.codeAt(sec, e.clock.Now())); err != nil {
		t.Fatalf("Verify after window: %v", err)
	}
}

func TestDisableTOTPRequiresPasswordAndCode(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	sec, _ := e.enroll(t, u.ID)

	code := e.codeAt(sec, e.clock.Now())
	if err := e.svc.TOTP.Disable(ctx, u.ID, "", "wrong-password-1", code); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Disable bad password err = %v", err)
	}
	if err := e.svc.TOTP.Disable(ctx, u.ID, "", "password-123456", ""); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("Disable no code err = %v", err)
	}
	if err := e.svc.TOTP.Disable(ctx, u.ID, "", "password-123456", wrongCode(code)); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("Disable bad code err = %v", err)
	}
	if on, _ := e.svc.TOTP.Enabled(ctx, u.ID); !on {
		t.Fatal("disabled by failed attempts")
	}
	if err := e.svc.TOTP.Disable(ctx, u.ID, "", "password-123456", code); err != nil {
		t.Fatalf("Disable: %v", err)
	}
	if on, _ := e.svc.TOTP.Enabled(ctx, u.ID); on {
		t.Fatal("still Enabled after Disable")
	}
	if n, _ := e.st.Q().CountUnusedRecoveryCodes(ctx, u.ID); n != 0 {
		t.Fatalf("recovery codes left = %d", n)
	}
}

func TestLoginRequiresTOTPWhenEnabled(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	sec, codes := e.enroll(t, u.ID)

	res, err := e.svc.Login(ctx, u.Email, "password-123456", "1.2.3.4", "ua")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if !res.MFARequired || res.Cookie == "" || res.CSRF != "" {
		t.Fatalf("Login = %+v, want MFARequired with pending cookie only", res)
	}

	// The pending cookie is not a session for any other route.
	if _, _, err := e.svc.Sessions.Lookup(ctx, res.Cookie); !errors.Is(err, ErrNoSession) {
		t.Fatalf("Lookup(pending) err = %v, want ErrNoSession", err)
	}
	h := e.svc.Sessions.RequireSession(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler reached with pending session")
	}))
	for _, path := range []string{"/api/me", "/api/orgs", "/api/me/totp/enroll"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.AddCookie(&http.Cookie{Name: e.svc.Sessions.CookieName(), Value: res.Cookie})
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s with pending = %d, want 401", path, rec.Code)
		}
	}

	if _, _, err := e.svc.CompleteMFA(ctx, res.Cookie, wrongCode(e.codeAt(sec, e.clock.Now()))); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("CompleteMFA bad code err = %v", err)
	}
	cookie, csrf, err := e.svc.CompleteMFA(ctx, res.Cookie, e.codeAt(sec, e.clock.Now()))
	if err != nil || cookie == "" || csrf == "" {
		t.Fatalf("CompleteMFA = %q, %q, %v", cookie, csrf, err)
	}
	if _, got, err := e.svc.Sessions.Lookup(ctx, cookie); err != nil || got.ID != u.ID {
		t.Fatalf("Lookup(full) = %+v, %v", got, err)
	}
	// The pending session is spent.
	if _, _, err := e.svc.CompleteMFA(ctx, res.Cookie, codes[0]); !errors.Is(err, ErrNoSession) {
		t.Fatalf("reused pending err = %v, want ErrNoSession", err)
	}

	// A recovery code completes a fresh pending login; pending expires in 5 min.
	res, _ = e.svc.Login(ctx, u.Email, "password-123456", "1.2.3.4", "ua")
	if _, _, err := e.svc.CompleteMFA(ctx, res.Cookie, codes[0]); err != nil {
		t.Fatalf("CompleteMFA recovery: %v", err)
	}
	res, _ = e.svc.Login(ctx, u.Email, "password-123456", "1.2.3.4", "ua")
	e.clock.Advance(MFAPendingTTL + time.Second)
	if _, _, err := e.svc.CompleteMFA(ctx, res.Cookie, codes[1]); !errors.Is(err, ErrNoSession) {
		t.Fatalf("expired pending err = %v, want ErrNoSession", err)
	}
	// A full session cookie is not a pending one.
	if _, _, err := e.svc.CompleteMFA(ctx, cookie, codes[1]); !errors.Is(err, ErrNoSession) {
		t.Fatalf("CompleteMFA(full cookie) err = %v, want ErrNoSession", err)
	}
}

func TestLoginWithoutTOTPGetsFullSession(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	res, err := e.svc.Login(ctx, u.Email, "password-123456", "1.2.3.4", "ua")
	if err != nil || res.MFARequired || res.CSRF == "" {
		t.Fatalf("Login = %+v, %v", res, err)
	}
	if _, got, err := e.svc.Sessions.Lookup(ctx, res.Cookie); err != nil || got.ID != u.ID {
		t.Fatalf("Lookup = %+v, %v", got, err)
	}
	// An unconfirmed enrollment does not require a code.
	if _, err := e.svc.TOTP.Enroll(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	if res, _ := e.svc.Login(ctx, u.Email, "password-123456", "1.2.3.4", "ua"); res.MFARequired {
		t.Fatal("MFARequired with unconfirmed enrollment")
	}
}

func TestMFAFailuresRecordedAndRateLimited(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	sec, _ := e.enroll(t, u.ID)
	res, _ := e.svc.Login(ctx, u.Email, "password-123456", "1.2.3.4", "ua")
	good := e.codeAt(sec, e.clock.Now())
	for i := 0; i < MaxTOTPFailures; i++ {
		_, _, _ = e.svc.CompleteMFA(ctx, res.Cookie, wrongCode(good))
	}
	if _, _, err := e.svc.CompleteMFA(ctx, res.Cookie, good); !errors.Is(err, apperr.ErrRateLimited) {
		t.Fatalf("CompleteMFA after budget err = %v, want ErrRateLimited", err)
	}
	evs, err := e.svc.Events.ListForUser(ctx, u.ID, 20)
	if err != nil {
		t.Fatal(err)
	}
	var bad, limited int
	for _, ev := range evs {
		switch ev.Result {
		case ResultBadTOTP:
			bad++
		case ResultRateLimited:
			limited++
		}
	}
	if bad != MaxTOTPFailures || limited != 1 {
		t.Fatalf("events bad_totp=%d rate_limited=%d", bad, limited)
	}
}

func TestOAuthLoginStillRequiresTOTP(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	plain := e.mkUser(t, "b@example.com", "password-123456")
	sec, _ := e.enroll(t, u.ID)

	for _, method := range []string{MethodOAuth, MethodInvite} {
		t.Run(method, func(t *testing.T) {
			res, err := e.svc.LoginUser(ctx, u.ID, method, "1.2.3.4", "ua")
			if err != nil || !res.MFARequired || res.CSRF != "" {
				t.Fatalf("LoginUser = %+v, %v; want MFARequired", res, err)
			}
			if _, _, err := e.svc.Sessions.Lookup(ctx, res.Cookie); !errors.Is(err, ErrNoSession) {
				t.Fatalf("pending usable as session: %v", err)
			}
			e.clock.Advance(totpPeriod * time.Second)
			if _, _, err := e.svc.CompleteMFA(ctx, res.Cookie, e.codeAt(sec, e.clock.Now())); err != nil {
				t.Fatalf("CompleteMFA: %v", err)
			}
		})
	}
	res, err := e.svc.LoginUser(ctx, plain.ID, MethodOAuth, "1.2.3.4", "ua")
	if err != nil || res.MFARequired || res.CSRF == "" {
		t.Fatalf("LoginUser(no totp) = %+v, %v", res, err)
	}
	if err := e.svc.SetDisabled(ctx, plain.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.LoginUser(ctx, plain.ID, MethodOAuth, "1.2.3.4", "ua"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("LoginUser(disabled) err = %v", err)
	}
}

// failRecoveryInserts makes every recovery_codes insert abort until the
// returned func drops the trigger.
func (e *env) failRecoveryInserts(t *testing.T) func() {
	t.Helper()
	ctx := context.Background()
	_, err := e.st.DB().ExecContext(ctx, `CREATE TRIGGER fail_rc BEFORE INSERT ON recovery_codes
		BEGIN SELECT RAISE(ABORT, 'injected'); END`)
	if err != nil {
		t.Fatal(err)
	}
	return func() {
		if _, err := e.st.DB().ExecContext(ctx, `DROP TRIGGER fail_rc`); err != nil {
			t.Fatal(err)
		}
	}
}

func TestConfirmIsAtomic(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	link, err := e.svc.TOTP.Enroll(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	sec := secretFromURL(t, link)
	restore := e.failRecoveryInserts(t)
	if _, err := e.svc.TOTP.Confirm(ctx, u.ID, e.codeAt(sec, e.clock.Now())); err == nil {
		t.Fatal("Confirm succeeded with failing inserts")
	}
	if on, _ := e.svc.TOTP.Enabled(ctx, u.ID); on {
		t.Fatal("TOTP enabled without recovery codes")
	}
	if n, _ := e.st.Q().CountUnusedRecoveryCodes(ctx, u.ID); n != 0 {
		t.Fatalf("partial recovery codes = %d", n)
	}
	restore()
	e.clock.Advance(totpPeriod * time.Second)
	if codes, err := e.svc.TOTP.Confirm(ctx, u.ID, e.codeAt(sec, e.clock.Now())); err != nil || len(codes) != RecoveryCodeCount {
		t.Fatalf("Confirm after restore = %d, %v", len(codes), err)
	}
}

func TestRegenerateIsAtomic(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	_, codes := e.enroll(t, u.ID)
	restore := e.failRecoveryInserts(t)
	if _, err := e.svc.TOTP.Regenerate(ctx, u.ID, "password-123456"); err == nil {
		t.Fatal("Regenerate succeeded with failing inserts")
	}
	restore()
	if n, _ := e.st.Q().CountUnusedRecoveryCodes(ctx, u.ID); n != RecoveryCodeCount {
		t.Fatalf("recovery codes after failed Regenerate = %d, want %d", n, RecoveryCodeCount)
	}
	if err := e.svc.TOTP.UseRecovery(ctx, u.ID, codes[0]); err != nil {
		t.Fatalf("old code after failed Regenerate: %v", err)
	}
}

func TestDisableRevokesOtherSessions(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	sec, _ := e.enroll(t, u.ID)
	cur, _ := e.mkSession(t, u.ID)
	other, _ := e.mkSession(t, u.ID)
	curSess, _, err := e.svc.Sessions.Lookup(ctx, cur)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.svc.TOTP.Disable(ctx, u.ID, curSess.ID, "password-123456", e.codeAt(sec, e.clock.Now())); err != nil {
		t.Fatalf("Disable: %v", err)
	}
	if _, _, err := e.svc.Sessions.Lookup(ctx, cur); err != nil {
		t.Fatalf("current session revoked: %v", err)
	}
	if _, _, err := e.svc.Sessions.Lookup(ctx, other); !errors.Is(err, ErrNoSession) {
		t.Fatalf("other session err = %v, want ErrNoSession", err)
	}
}

func TestLoginEventPendingThenOK(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, plainHasher{})
	u := e.mkUser(t, "a@example.com", "password-123456")
	sec, _ := e.enroll(t, u.ID)
	results := func() []string {
		evs, err := e.svc.Events.ListForUser(ctx, u.ID, 10)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, ev := range evs {
			out = append(out, ev.Result)
		}
		return out
	}
	res, err := e.svc.Login(ctx, u.Email, "password-123456", "1.2.3.4", "ua")
	if err != nil {
		t.Fatal(err)
	}
	if got := results(); len(got) != 1 || got[0] != ResultMFAPending {
		t.Fatalf("after Login events = %v, want [mfa_pending]", got)
	}
	if _, _, err := e.svc.CompleteMFA(ctx, res.Cookie, e.codeAt(sec, e.clock.Now())); err != nil {
		t.Fatal(err)
	}
	if got := results(); len(got) != 2 || got[0] != ResultOK {
		t.Fatalf("after CompleteMFA events = %v, want ok first", got)
	}
}
