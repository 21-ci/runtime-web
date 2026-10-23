package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/store/db"
)

const fakeClientSecret = "shh-client-secret"

type ghEmail struct {
	Email    string `json:"email"`
	Primary  bool   `json:"primary"`
	Verified bool   `json:"verified"`
}

// fakeIDP serves OIDC discovery, token, userinfo and the GitHub user APIs.
type fakeIDP struct {
	srv       *httptest.Server
	sub       string
	email     string
	verified  any
	ghUserID  int64
	ghEmails  []ghEmail
	challenge string
	// discoveryIssuer overrides the issuer in the discovery document.
	discoveryIssuer string
}

func newFakeIDP(t *testing.T) *fakeIDP {
	t.Helper()
	f := &fakeIDP{sub: "sub-123", email: "alice@example.com", verified: true, ghUserID: 4242}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		issuer := f.srv.URL
		if f.discoveryIssuer != "" {
			issuer = f.discoveryIssuer
		}
		discoveryHandler(issuer, f.srv.URL+"/token", f.srv.URL+"/authorize", f.srv.URL+"/userinfo")(w, r)
	})
	mux.HandleFunc("/token", f.token)
	mux.HandleFunc("/login/oauth/access_token", f.token)
	mux.HandleFunc("/userinfo", func(w http.ResponseWriter, r *http.Request) {
		if !f.bearerOK(r) {
			http.Error(w, "no token", http.StatusUnauthorized)
			return
		}
		writeTestJSON(w, map[string]any{"sub": f.sub, "email": f.email, "email_verified": f.verified})
	})
	mux.HandleFunc("/user", func(w http.ResponseWriter, r *http.Request) {
		if !f.bearerOK(r) {
			http.Error(w, "no token", http.StatusUnauthorized)
			return
		}
		writeTestJSON(w, map[string]any{"id": f.ghUserID, "login": "alice"})
	})
	mux.HandleFunc("/user/emails", func(w http.ResponseWriter, r *http.Request) {
		if !f.bearerOK(r) {
			http.Error(w, "no token", http.StatusUnauthorized)
			return
		}
		writeTestJSON(w, f.ghEmails)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

// discoveryHandler serves a discovery document for issuer and token endpoint.
func discoveryHandler(issuer, token, auth, userinfo string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeTestJSON(w, map[string]string{
			"issuer":                 issuer,
			"authorization_endpoint": auth,
			"token_endpoint":         token,
			"userinfo_endpoint":      userinfo,
		})
	}
}

func (f *fakeIDP) token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	ok := r.Form.Get("code") == "good-code" &&
		r.Form.Get("client_secret") == fakeClientSecret &&
		challengeOf(r.Form.Get("code_verifier")) == f.challenge
	if !ok {
		http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
		return
	}
	writeTestJSON(w, map[string]string{"access_token": "tok-1", "token_type": "bearer"})
}

func (f *fakeIDP) bearerOK(r *http.Request) bool {
	return r.Header.Get("Authorization") == "Bearer tok-1"
}

func writeTestJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func challengeOf(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// newOAuthTest returns an auth env with a fake IdP and a configured OIDC provider.
func newOAuthTest(t *testing.T) (*env, *OAuth, *fakeIDP) {
	t.Helper()
	e := newEnv(t, plainHasher{})
	f := newFakeIDP(t)
	o := NewOAuth(e.svc, "https://console.example.test")
	o.Dev = true // the fake IdP is plain http
	o.GitHubWeb = f.srv.URL
	o.GitHubAPI = f.srv.URL
	o.GoogleIssuer = f.srv.URL
	err := o.SetProvider(context.Background(), ProviderConfig{
		ID: ProviderOIDC, Enabled: true, ClientID: "cid", ClientSecret: fakeClientSecret,
		Issuer: f.srv.URL, Name: "Acme SSO",
	})
	if err != nil {
		t.Fatalf("SetProvider: %v", err)
	}
	return e, o, f
}

// startFlow runs Start and returns the state and the state cookies.
func startFlow(t *testing.T, o *OAuth, f *fakeIDP, provider, next string) (string, []*http.Cookie) {
	t.Helper()
	rec := httptest.NewRecorder()
	loc, err := o.Start(context.Background(), rec, provider, next)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	u, err := url.Parse(loc)
	if err != nil {
		t.Fatalf("parse redirect: %v", err)
	}
	f.challenge = u.Query().Get("code_challenge")
	if u.Query().Get("code_challenge_method") != "S256" {
		t.Fatalf("code_challenge_method = %q, want S256", u.Query().Get("code_challenge_method"))
	}
	return u.Query().Get("state"), rec.Result().Cookies()
}

// finishFlow calls the callback with state, cookies and code.
func finishFlow(t *testing.T, o *OAuth, provider, state string, cookies []*http.Cookie, code string) (string, *httptest.ResponseRecorder) {
	t.Helper()
	q := url.Values{"code": {code}, "state": {state}}
	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/"+provider+"/callback?"+q.Encode(), nil)
	r.RemoteAddr = "10.0.0.9:5000"
	for _, c := range cookies {
		r.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	dest, err := o.Finish(context.Background(), rec, r, provider)
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	return dest, rec
}

func hasSessionCookie(e *env, rec *httptest.ResponseRecorder) bool {
	for _, c := range rec.Result().Cookies() {
		if c.Name == e.svc.Sessions.CookieName() && c.Value != "" {
			return true
		}
	}
	return false
}

func countUsers(t *testing.T, e *env) int64 {
	t.Helper()
	n, err := e.st.Q().CountUsers(context.Background())
	if err != nil {
		t.Fatalf("CountUsers: %v", err)
	}
	return n
}

func TestOAuthStateMismatch(t *testing.T) {
	tests := []struct {
		name       string
		forgeState bool
		dropCookie bool
	}{
		{name: "forged state", forgeState: true},
		{name: "missing state cookie", dropCookie: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, o, f := newOAuthTest(t)
			e.mkUser(t, "alice@example.com", "pw")
			state, cookies := startFlow(t, o, f, ProviderOIDC, "/")
			if tt.forgeState {
				state = "forged"
			}
			if tt.dropCookie {
				cookies = nil
			}
			dest, rec := finishFlow(t, o, ProviderOIDC, state, cookies, "good-code")
			if dest != "/login?error=oauth_state_invalid" {
				t.Fatalf("dest = %q, want oauth_state_invalid", dest)
			}
			if hasSessionCookie(e, rec) {
				t.Fatal("session cookie set after state mismatch")
			}
		})
	}
}

func TestOAuthUnknownEmailNoUserCreated(t *testing.T) {
	e, o, f := newOAuthTest(t)
	f.email = "nobody@example.com"
	before := countUsers(t, e)
	state, cookies := startFlow(t, o, f, ProviderOIDC, "/")
	dest, rec := finishFlow(t, o, ProviderOIDC, state, cookies, "good-code")
	if dest != "/login?error=no_account" {
		t.Fatalf("dest = %q, want no_account", dest)
	}
	if after := countUsers(t, e); after != before {
		t.Fatalf("users = %d, want %d (no user may be created)", after, before)
	}
	if hasSessionCookie(e, rec) {
		t.Fatal("session cookie set for unknown email")
	}
}

func TestOAuthUnverifiedEmailRejected(t *testing.T) {
	tests := []struct {
		name     string
		verified any
	}{
		{name: "false", verified: false},
		{name: "string false", verified: "false"},
		{name: "absent", verified: nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, o, f := newOAuthTest(t)
			e.mkUser(t, "alice@example.com", "pw")
			f.verified = tt.verified
			state, cookies := startFlow(t, o, f, ProviderOIDC, "/")
			dest, rec := finishFlow(t, o, ProviderOIDC, state, cookies, "good-code")
			if dest != "/login?error=email_unverified" {
				t.Fatalf("dest = %q, want email_unverified", dest)
			}
			if hasSessionCookie(e, rec) {
				t.Fatal("session cookie set for unverified email")
			}
		})
	}
}

func TestGitHubUsesPrimaryVerifiedEmail(t *testing.T) {
	tests := []struct {
		name    string
		emails  []ghEmail
		wantErr string
	}{
		{
			name: "primary and verified links",
			emails: []ghEmail{
				{Email: "other@example.com", Primary: false, Verified: true},
				{Email: "main@example.com", Primary: true, Verified: true},
			},
		},
		{
			name: "primary unverified rejected",
			emails: []ghEmail{
				{Email: "main@example.com", Primary: true, Verified: false},
				{Email: "other@example.com", Primary: false, Verified: true},
			},
			wantErr: "/login?error=email_unverified",
		},
		{
			name:    "no emails rejected",
			emails:  nil,
			wantErr: "/login?error=email_unverified",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, o, f := newOAuthTest(t)
			if err := o.SetProvider(context.Background(), ProviderConfig{
				ID: ProviderGitHub, Enabled: true, ClientID: "gh", ClientSecret: fakeClientSecret,
			}); err != nil {
				t.Fatalf("SetProvider: %v", err)
			}
			u := e.mkUser(t, "main@example.com", "pw")
			e.mkUser(t, "other@example.com", "pw")
			f.ghEmails = tt.emails
			state, cookies := startFlow(t, o, f, ProviderGitHub, "/home")
			dest, rec := finishFlow(t, o, ProviderGitHub, state, cookies, "good-code")
			if tt.wantErr != "" {
				if dest != tt.wantErr {
					t.Fatalf("dest = %q, want %q", dest, tt.wantErr)
				}
				if hasSessionCookie(e, rec) {
					t.Fatal("session cookie set on rejected GitHub email")
				}
				return
			}
			if dest != "/home" {
				t.Fatalf("dest = %q, want /home", dest)
			}
			idn, err := e.st.Q().GetIdentity(context.Background(), db.GetIdentityParams{Provider: ProviderGitHub, Subject: "4242"})
			if err != nil {
				t.Fatalf("GetIdentity: %v", err)
			}
			if idn.UserID != u.ID {
				t.Fatalf("identity user = %q, want %q", idn.UserID, u.ID)
			}
		})
	}
}

func TestOAuthLinksExisting(t *testing.T) {
	e, o, f := newOAuthTest(t)
	u := e.mkUser(t, "alice@example.com", "pw")
	state, cookies := startFlow(t, o, f, ProviderOIDC, "/orgs/acme")
	dest, rec := finishFlow(t, o, ProviderOIDC, state, cookies, "good-code")
	if dest != "/orgs/acme" {
		t.Fatalf("dest = %q, want /orgs/acme", dest)
	}
	if !hasSessionCookie(e, rec) {
		t.Fatal("no session cookie after successful link")
	}
	idn, err := e.st.Q().GetIdentity(context.Background(), db.GetIdentityParams{Provider: ProviderOIDC, Subject: "sub-123"})
	if err != nil {
		t.Fatalf("GetIdentity: %v", err)
	}
	if idn.UserID != u.ID {
		t.Fatalf("identity user = %q, want %q", idn.UserID, u.ID)
	}
}

func TestOAuthDisabledUserRejected(t *testing.T) {
	e, o, f := newOAuthTest(t)
	u := e.mkUser(t, "alice@example.com", "pw")
	if err := e.svc.SetDisabled(context.Background(), u.ID, true); err != nil {
		t.Fatalf("SetDisabled: %v", err)
	}
	state, cookies := startFlow(t, o, f, ProviderOIDC, "/")
	dest, rec := finishFlow(t, o, ProviderOIDC, state, cookies, "good-code")
	if dest != "/login?error=account_disabled" {
		t.Fatalf("dest = %q, want account_disabled", dest)
	}
	if hasSessionCookie(e, rec) {
		t.Fatal("session cookie set for disabled user")
	}
}

func TestOAuthStartUnknownProvider(t *testing.T) {
	_, o, _ := newOAuthTest(t)
	_, err := o.Start(context.Background(), httptest.NewRecorder(), ProviderGoogle, "/")
	if !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestOAuthClientSecretSealed(t *testing.T) {
	e, o, _ := newOAuthTest(t)
	row, err := e.st.Q().GetSetting(context.Background(), "oauth."+ProviderOIDC+".client_secret")
	if err != nil {
		t.Fatalf("GetSetting: %v", err)
	}
	if row.Sealed != 1 {
		t.Fatalf("sealed = %d, want 1", row.Sealed)
	}
	if string(row.Value) == fakeClientSecret {
		t.Fatal("client secret stored in plaintext")
	}
	infos, err := o.Providers(context.Background())
	if err != nil {
		t.Fatalf("Providers: %v", err)
	}
	if len(infos) != 1 || infos[0].ID != ProviderOIDC || infos[0].Name != "Acme SSO" {
		t.Fatalf("providers = %+v", infos)
	}
}

func TestOIDCIssuerRequiresHTTPS(t *testing.T) {
	e := newEnv(t, plainHasher{})
	o := NewOAuth(e.svc, "https://console.example.test")
	o.Dev = false
	err := o.SetProvider(context.Background(), ProviderConfig{
		ID: ProviderOIDC, Enabled: true, ClientID: "cid", ClientSecret: "s", Issuer: "http://idp.example.test",
	})
	if !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid for http issuer", err)
	}
}

func TestOIDCDiscoveryEndpointsRequireHTTPS(t *testing.T) {
	var srv *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		discoveryHandler(srv.URL, "http://idp.example.test/token", srv.URL+"/authorize", srv.URL+"/userinfo")(w, r)
	})
	srv = httptest.NewTLSServer(mux)
	t.Cleanup(srv.Close)

	e := newEnv(t, plainHasher{})
	o := NewOAuth(e.svc, "https://console.example.test")
	o.Dev = false
	o.HTTP = srv.Client()
	if err := o.SetProvider(context.Background(), ProviderConfig{
		ID: ProviderOIDC, Enabled: true, ClientID: "cid", ClientSecret: "s", Issuer: srv.URL,
	}); err != nil {
		t.Fatalf("SetProvider: %v", err)
	}
	if _, err := o.Start(context.Background(), httptest.NewRecorder(), ProviderOIDC, "/"); err == nil {
		t.Fatal("Start accepted an http token_endpoint from discovery")
	}
}

func TestOIDCDiscoveryIssuerMismatch(t *testing.T) {
	e, o, f := newOAuthTest(t)
	_ = e
	f.discoveryIssuer = "https://evil.example.test"
	if _, err := o.Start(context.Background(), httptest.NewRecorder(), ProviderOIDC, "/"); err == nil {
		t.Fatal("Start accepted a discovery document with a different issuer")
	}
}

func TestDiscoveryCached(t *testing.T) {
	var hits atomic.Int32
	var srv *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		discoveryHandler(srv.URL, srv.URL+"/token", srv.URL+"/authorize", srv.URL+"/userinfo")(w, r)
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	e := newEnv(t, plainHasher{})
	o := NewOAuth(e.svc, "https://console.example.test")
	o.Dev = true
	if err := o.SetProvider(context.Background(), ProviderConfig{
		ID: ProviderOIDC, Enabled: true, ClientID: "cid", ClientSecret: "s", Issuer: srv.URL,
	}); err != nil {
		t.Fatalf("SetProvider: %v", err)
	}
	for i := 0; i < 2; i++ {
		if _, err := o.Start(context.Background(), httptest.NewRecorder(), ProviderOIDC, "/"); err != nil {
			t.Fatalf("Start %d: %v", i, err)
		}
	}
	if n := hits.Load(); n != 1 {
		t.Fatalf("discovery hits = %d, want 1 (cached)", n)
	}
}

func TestOAuthLinkedIdentityDisabledUser(t *testing.T) {
	e, o, f := newOAuthTest(t)
	u := e.mkUser(t, "alice@example.com", "pw")
	state, cookies := startFlow(t, o, f, ProviderOIDC, "/")
	if dest, _ := finishFlow(t, o, ProviderOIDC, state, cookies, "good-code"); dest != "/" {
		t.Fatalf("first link dest = %q, want /", dest)
	}
	if err := e.svc.SetDisabled(context.Background(), u.ID, true); err != nil {
		t.Fatalf("SetDisabled: %v", err)
	}
	state, cookies = startFlow(t, o, f, ProviderOIDC, "/")
	dest, rec := finishFlow(t, o, ProviderOIDC, state, cookies, "good-code")
	if dest != "/login?error=account_disabled" {
		t.Fatalf("dest = %q, want account_disabled", dest)
	}
	if hasSessionCookie(e, rec) {
		t.Fatal("session cookie set for linked disabled user")
	}
}

func TestSafeNext(t *testing.T) {
	tests := []struct{ in, want string }{
		{"/orgs/acme", "/orgs/acme"},
		{"//evil.example", "/"},
		{"https://evil.example", "/"},
		{`/\evil.example`, "/"},
		{"", "/"},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := safeNext(tt.in); got != tt.want {
				t.Fatalf("safeNext(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestDiscoveryRejectsPrivateIssuer(t *testing.T) {
	_, o, _ := newOAuthTest(t)
	o.Dev = false
	for _, iss := range []string{"https://127.0.0.1", "https://10.1.2.3:8443", "https://[::1]", "https://169.254.169.254", "https://localhost"} {
		if _, err := o.discover(context.Background(), iss); !errors.Is(err, apperr.ErrInvalid) {
			t.Errorf("%s: err = %v, want ErrInvalid", iss, err)
		}
	}
}

func TestDiscoveryCacheBounded(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < 3*discoveryMax; i++ {
		cacheDiscovery(fmt.Sprintf("https://idp%d.example", i), endpoints{}, now)
	}
	discoveryMu.Lock()
	n := len(discoveryCache)
	discoveryMu.Unlock()
	if n > discoveryMax {
		t.Fatalf("cache size %d > %d", n, discoveryMax)
	}
}
