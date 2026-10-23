package api

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/21cloud/runtime-web/internal/admin"
	"github.com/21cloud/runtime-web/internal/apps"
	"github.com/21cloud/runtime-web/internal/audit"
	"github.com/21cloud/runtime-web/internal/auth"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/domains"
	"github.com/21cloud/runtime-web/internal/keys"
	"github.com/21cloud/runtime-web/internal/orgs"
	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/runtime/runtimetest"
	"github.com/21cloud/runtime-web/internal/seal"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
	"github.com/21cloud/runtime-web/internal/users"
)

const (
	testPlan       = "standard"
	testPublicURL  = "https://console.example.test"
	testRuntimeURL = "https://runtime.example.test"
	testSetupToken = "setup-token-for-tests"
	testPassword   = "correct horse battery"
)

// testHasher is a fast, insecure Hasher for tests only.
type testHasher struct{}

func (testHasher) Hash(p string) (string, error) { return "plain$" + p, nil }
func (testHasher) Verify(hash, p string) bool    { return hash == "plain$"+p }

type testEnv struct {
	t       *testing.T
	st      *store.Store
	auth    *auth.Service
	srv     *Server
	fake    *runtimetest.Fake
	orgs    *orgs.Service
	appSvc  *apps.Service
	domains *domains.Service
	logs    *apps.LogHub
}

// testRouterSecret is the ROUTER_SHARED_SECRET of the test server.
const testRouterSecret = "test-router-secret"

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	var key [32]byte
	for i := range key {
		key[i] = byte(i)
	}
	sealer := seal.New(key)
	authSvc := auth.NewService(st, testHasher{}, sealer, testSetupToken, true)
	authSvc.SSOConfigured = func(ctx context.Context) bool {
		ps, err := auth.NewOAuth(authSvc, testPublicURL).Providers(ctx)
		return err == nil && len(ps) > 0
	}
	fake := runtimetest.NewServer(t)
	fake.SetPlan(testPlan, runtimetest.FakePlan{MaxServices: 10, MaxSchedules: 3, Triggers: []string{"http"}})
	rt := runtime.New(fake.URL, http.DefaultClient)
	root := runtime.RootCred{Token: fake.RootToken}
	orgSvc := orgs.New(st, rt, root, sealer, testPlan)
	appSvc := apps.New(rt, orgSvc, st)
	spa := fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html><title>app</title>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
	}
	logs := apps.NewLogHub(appSvc)
	t.Cleanup(logs.Close)
	domainSvc := domains.New(st, rt, root, appSvc, domains.Options{
		BaseDomain: "apps.test", ConsoleHost: "console.test", RuntimeHost: "runtime.test", CNAMETarget: "console.test",
	})
	srv := New(Deps{
		Logs:             logs,
		Domains:          domainSvc,
		RouterSecret:     testRouterSecret,
		Auth:             authSvc,
		Orgs:             orgSvc,
		Users:            users.New(st, testHasher{}),
		Admin:            admin.New(st, rt, root, orgSvc),
		Keys:             keys.New(st, rt, root, sealer, orgSvc, appSvc),
		Apps:             appSvc,
		WebVersion:       "test-web",
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		PublicURL:        testPublicURL,
		RuntimePublicURL: testRuntimeURL,
		SPA:              spa,
	})
	return &testEnv{t: t, st: st, auth: authSvc, srv: srv, fake: fake, orgs: orgSvc, appSvc: appSvc, domains: domainSvc, logs: logs}
}

// send issues a request with a JSON body (nil body for none) and the console
// Origin unless a mod removes it.
func (e *testEnv) send(method, target string, body any, mods ...func(*http.Request)) *httptest.ResponseRecorder {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			e.t.Fatalf("marshal: %v", err)
		}
		rd = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, target, rd)
	req.Header.Set("Origin", testPublicURL)
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "192.0.2.10:4000"
	for _, m := range mods {
		m(req)
	}
	rec := httptest.NewRecorder()
	e.srv.ServeHTTP(rec, req)
	return rec
}

func withCookie(value string) func(*http.Request) {
	return func(r *http.Request) {
		r.AddCookie(&http.Cookie{Name: "rtw_session", Value: value})
	}
}

func withCSRF(token string) func(*http.Request) {
	return func(r *http.Request) { r.Header.Set("X-CSRF-Token", token) }
}

func noOrigin(r *http.Request) { r.Header.Del("Origin") }

func withOrigin(origin string) func(*http.Request) {
	return func(r *http.Request) { r.Header.Set("Origin", origin) }
}

// decode reads a JSON body into a generic map.
func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return out
}

// errCode returns error.code from an error envelope.
func errCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	env := decode(t, rec)
	e, ok := env["error"].(map[string]any)
	if !ok {
		t.Fatalf("no error envelope in %q", rec.Body.String())
	}
	code, _ := e["code"].(string)
	return code
}

func expectStatus(t *testing.T, rec *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("status = %d, want %d; body %s", rec.Code, want, rec.Body.String())
	}
}

// cookieFrom returns the value of the session cookie set by rec, or "".
func (e *testEnv) cookieFrom(rec *httptest.ResponseRecorder) string {
	for _, c := range rec.Result().Cookies() {
		if c.Name == e.auth.Sessions.CookieName() {
			return c.Value
		}
	}
	return ""
}

func (e *testEnv) mkUser(email, password string) string {
	e.t.Helper()
	hash, err := testHasher{}.Hash(password)
	if err != nil {
		e.t.Fatal(err)
	}
	id := store.NewID("usr_")
	err = e.st.Q().CreateUser(context.Background(), db.CreateUserParams{
		ID: id, Email: email, Name: "Test User", PasswordHash: hash, CreatedAt: 1, UpdatedAt: 1,
	})
	if err != nil {
		e.t.Fatalf("CreateUser: %v", err)
	}
	return id
}

// login signs in with password and returns the full session cookie and CSRF token.
func (e *testEnv) login(email, password string) (string, string) {
	e.t.Helper()
	rec := e.send(http.MethodPost, "/api/auth/login", map[string]string{"email": email, "password": password})
	expectStatus(e.t, rec, http.StatusOK)
	body := decode(e.t, rec)
	csrf, _ := body["csrf"].(string)
	return e.cookieFrom(rec), csrf
}

// totpAt computes the RFC 6238 code for secret (base32 as in the otpauth URL) at at.
func totpAt(t *testing.T, otpauth string, at time.Time) string {
	t.Helper()
	u, err := url.Parse(otpauth)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(u.Query().Get("secret")))
	if err != nil {
		t.Fatal(err)
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(at.Unix()/30))
	m := hmac.New(sha1.New, secret)
	m.Write(msg[:])
	sum := m.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	v := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", v%1_000_000)
}

// mkAdmin creates an enabled instance admin and returns the user id.
func (e *testEnv) mkAdmin(email string) string {
	e.t.Helper()
	hash, err := testHasher{}.Hash(testPassword)
	if err != nil {
		e.t.Fatal(err)
	}
	id := store.NewID("usr_")
	err = e.st.Q().CreateUser(context.Background(), db.CreateUserParams{
		ID: id, Email: email, Name: "Admin", PasswordHash: hash, IsInstanceAdmin: 1, CreatedAt: 1, UpdatedAt: 1,
	})
	if err != nil {
		e.t.Fatalf("CreateUser: %v", err)
	}
	return id
}

// mkOrg creates an org owned by ownerID through the service and returns it.
func (e *testEnv) mkOrg(slug, ownerID string) orgs.Org {
	e.t.Helper()
	org, err := e.orgs.Create(context.Background(), audit.Actor{UserID: "cli"}, slug, "Org "+slug, ownerID)
	if err != nil {
		e.t.Fatalf("orgs.Create(%s): %v", slug, err)
	}
	return org
}

// addMember adds userID to orgID with role through the service.
func (e *testEnv) addMember(orgID, userID, role string) {
	e.t.Helper()
	sub := authz.Subject{InstanceAdmin: true}
	if err := e.orgs.AddMember(context.Background(), audit.Actor{UserID: "cli"}, sub, orgID, userID, role); err != nil {
		e.t.Fatalf("AddMember: %v", err)
	}
}

// session signs in and returns the session cookie and CSRF token for email.
func (e *testEnv) session(email string) (string, string) {
	e.t.Helper()
	return e.login(email, testPassword)
}
