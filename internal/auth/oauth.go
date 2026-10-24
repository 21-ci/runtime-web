package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/21cloud/runtime-web/internal/netx"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/seal"
	"github.com/21cloud/runtime-web/internal/store"
	"github.com/21cloud/runtime-web/internal/store/db"
)

// Provider IDs (reference/api.md §4).
const (
	ProviderGitHub = "github"
	ProviderGoogle = "google"
	ProviderOIDC   = "oidc"
)

// Callback error codes, sent to the login page as /login?error=<code>.
const (
	OAuthErrStateInvalid    = "oauth_state_invalid"
	OAuthErrEmailUnverified = "email_unverified"
	OAuthErrNoAccount       = "no_account"
	OAuthErrAccountDisabled = "account_disabled"
	OAuthErrFailed          = "oauth_failed"
)

const (
	oauthStateTTL     = 10 * time.Minute
	oauthCookieName   = "__Host-rtw_oauth"
	oauthCookieDev    = "rtw_oauth"
	oauthHTTPTimeout  = 15 * time.Second
	oauthSecretPrefix = "oauth."
	discoveryTTL      = 10 * time.Minute
	// discoveryMax bounds the shared discovery cache.
	discoveryMax = 64
)

// discoveryCache holds OIDC endpoints per issuer, shared by all OAuth values
// (the api layer builds one per request).
var (
	discoveryMu    sync.Mutex
	discoveryCache = map[string]cachedEndpoints{}
)

type cachedEndpoints struct {
	ep endpoints
	at time.Time
}

// ProviderConfig is one login provider as stored in settings. ClientSecret
// is write-only: it is sealed at rest and only SetProvider accepts it.
type ProviderConfig struct {
	ID           string
	Enabled      bool
	ClientID     string
	ClientSecret string
	// Issuer is the OIDC issuer URL (oidc only).
	Issuer string
	// Name is the display name (oidc only).
	Name string
}

// ProviderInfo is a provider offered on the login page.
type ProviderInfo struct {
	ID   string
	Name string
}

// OAuth runs the authorization-code + PKCE login flow for GitHub, Google
// and generic OIDC. It only links existing users by verified email; it
// never creates one.
type OAuth struct {
	Service   *Service
	Sealer    *seal.Sealer
	PublicURL string
	HTTP      *http.Client
	Now       func() time.Time
	// Endpoints for GitHub and Google; tests point them at a fake server.
	GitHubWeb    string
	GitHubAPI    string
	GoogleIssuer string
	// Dev drops the __Host- prefix and Secure on the state cookie.
	Dev bool
}

// NewOAuth returns an OAuth bound to svc. publicURL is RTWEB_PUBLIC_URL,
// the origin the callback URL is built from.
func NewOAuth(svc *Service, publicURL string) *OAuth {
	return &OAuth{
		Service:      svc,
		Sealer:       svc.TOTP.Sealer,
		PublicURL:    strings.TrimRight(publicURL, "/"),
		HTTP:         &http.Client{Timeout: oauthHTTPTimeout},
		GitHubWeb:    "https://github.com",
		GitHubAPI:    "https://api.github.com",
		GoogleIssuer: "https://accounts.google.com",
		Dev:          svc.Sessions.Dev,
	}
}

func (o *OAuth) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

func (o *OAuth) stateCookieName() string {
	if o.Dev {
		return oauthCookieDev
	}
	return oauthCookieName
}

// settingKey and secretKey name the settings rows of one provider.
func settingKey(id string) string       { return oauthSecretPrefix + id }
func secretSettingKey(id string) string { return oauthSecretPrefix + id + ".client_secret" }

// storedProvider is the non-secret part of a provider, as JSON in settings.
type storedProvider struct {
	Enabled  bool   `json:"enabled"`
	ClientID string `json:"client_id"`
	Issuer   string `json:"issuer,omitempty"`
	Name     string `json:"name,omitempty"`
}

func knownProvider(id string) bool {
	return id == ProviderGitHub || id == ProviderGoogle || id == ProviderOIDC
}

// SetProvider stores a provider. An empty ClientSecret keeps the stored one.
func (o *OAuth) SetProvider(ctx context.Context, p ProviderConfig) error {
	pp, err := o.prepareProvider(p)
	if err != nil {
		return err
	}
	return pp.write(ctx, o.Service.Store.Q())
}

// Provider loads an enabled, fully configured provider with its secret.
// Unknown, disabled or unconfigured providers are apperr.ErrNotFound.
func (o *OAuth) Provider(ctx context.Context, id string) (ProviderConfig, error) {
	notFound := fmt.Errorf("auth: oauth provider %s: %w", id, apperr.ErrNotFound)
	if !knownProvider(id) {
		return ProviderConfig{}, notFound
	}
	q := o.Service.Store.Q()
	row, err := q.GetSetting(ctx, settingKey(id))
	if errors.Is(err, sql.ErrNoRows) {
		return ProviderConfig{}, notFound
	}
	if err != nil {
		return ProviderConfig{}, fmt.Errorf("auth: oauth get %s: %w", id, err)
	}
	var sp storedProvider
	if err := json.Unmarshal(row.Value, &sp); err != nil {
		return ProviderConfig{}, fmt.Errorf("auth: oauth decode %s: %w", id, err)
	}
	if !sp.Enabled {
		return ProviderConfig{}, notFound
	}
	sec, err := q.GetSetting(ctx, secretSettingKey(id))
	if errors.Is(err, sql.ErrNoRows) {
		return ProviderConfig{}, notFound
	}
	if err != nil {
		return ProviderConfig{}, fmt.Errorf("auth: oauth get secret %s: %w", id, err)
	}
	if o.Sealer == nil {
		return ProviderConfig{}, fmt.Errorf("auth: oauth open secret: no sealer")
	}
	plain, err := o.Sealer.Open(sec.Value)
	if err != nil {
		return ProviderConfig{}, fmt.Errorf("auth: oauth open secret %s: %w", id, err)
	}
	return ProviderConfig{
		ID: id, Enabled: true, ClientID: sp.ClientID, ClientSecret: string(plain),
		Issuer: sp.Issuer, Name: sp.Name,
	}, nil
}

// Providers lists the enabled, configured providers in a fixed order.
func (o *OAuth) Providers(ctx context.Context) ([]ProviderInfo, error) {
	out := []ProviderInfo{}
	for _, id := range []string{ProviderGitHub, ProviderGoogle, ProviderOIDC} {
		cfg, err := o.Provider(ctx, id)
		if errors.Is(err, apperr.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		name := map[string]string{ProviderGitHub: "GitHub", ProviderGoogle: "Google"}[id]
		if id == ProviderOIDC {
			name = cfg.Name
			if name == "" {
				name = "SSO"
			}
		}
		out = append(out, ProviderInfo{ID: id, Name: name})
	}
	return out, nil
}

// oauthState is the state+PKCE cookie payload.
type oauthState struct {
	State    string `json:"s"`
	Verifier string `json:"v"`
	Provider string `json:"p"`
	Next     string `json:"n"`
}

func oauthRandom(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("auth: oauth random: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// safeNext keeps only same-origin absolute paths, defaulting to "/".
func safeNext(p string) string {
	if !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.Contains(p, `\`) {
		return "/"
	}
	return p
}

// endpoints are the provider URLs used by the flow.
type endpoints struct {
	auth, token, userinfo string
}

func (o *OAuth) endpointsFor(ctx context.Context, cfg ProviderConfig) (endpoints, error) {
	switch cfg.ID {
	case ProviderGitHub:
		return endpoints{
			auth:     o.GitHubWeb + "/login/oauth/authorize",
			token:    o.GitHubWeb + "/login/oauth/access_token",
			userinfo: o.GitHubAPI + "/user",
		}, nil
	case ProviderGoogle:
		return o.discover(ctx, o.GoogleIssuer)
	default:
		return o.discover(ctx, cfg.Issuer)
	}
}

// requireURL accepts an absolute https URL; plain http only in Dev.
func (o *OAuth) requireURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return fmt.Errorf("auth: url %q: %w", raw, apperr.ErrInvalid)
	}
	if u.Scheme == "https" || (o.Dev && u.Scheme == "http") {
		return nil
	}
	return fmt.Errorf("auth: url %q must be https: %w", raw, apperr.ErrInvalid)
}

// discover reads the OIDC discovery document of issuer. The document's
// issuer must equal issuer and every endpoint must be https (http in Dev).
// Successful lookups are cached for discoveryTTL per issuer.
func (o *OAuth) discover(ctx context.Context, issuer string) (endpoints, error) {
	issuer = strings.TrimRight(issuer, "/")
	if err := o.requireURL(issuer); err != nil {
		return endpoints{}, err
	}
	now := o.now()
	discoveryMu.Lock()
	c, ok := discoveryCache[issuer]
	discoveryMu.Unlock()
	if ok && now.Sub(c.at) < discoveryTTL {
		return c.ep, nil
	}
	if err := o.requirePublicHost(ctx, issuer); err != nil {
		return endpoints{}, err
	}

	var doc struct {
		Issuer   string `json:"issuer"`
		Auth     string `json:"authorization_endpoint"`
		Token    string `json:"token_endpoint"`
		UserInfo string `json:"userinfo_endpoint"`
	}
	if err := o.getJSON(ctx, issuer+"/.well-known/openid-configuration", "", &doc); err != nil {
		return endpoints{}, fmt.Errorf("auth: oidc discovery: %w", err)
	}
	if strings.TrimRight(doc.Issuer, "/") != issuer {
		return endpoints{}, fmt.Errorf("auth: oidc discovery: issuer mismatch: %w", apperr.ErrInvalid)
	}
	if doc.Auth == "" || doc.Token == "" || doc.UserInfo == "" {
		return endpoints{}, fmt.Errorf("auth: oidc discovery: incomplete document")
	}
	ep := endpoints{auth: doc.Auth, token: doc.Token, userinfo: doc.UserInfo}
	for _, u := range []string{ep.auth, ep.token, ep.userinfo} {
		if err := o.requireURL(u); err != nil {
			return endpoints{}, fmt.Errorf("auth: oidc discovery endpoint: %w", err)
		}
	}
	cacheDiscovery(issuer, ep, now)
	return ep, nil
}

// cacheDiscovery stores ep for issuer, evicting expired entries and then the
// oldest one so the cache never exceeds discoveryMax.
func cacheDiscovery(issuer string, ep endpoints, now time.Time) {
	discoveryMu.Lock()
	defer discoveryMu.Unlock()
	if _, ok := discoveryCache[issuer]; !ok && len(discoveryCache) >= discoveryMax {
		oldest := ""
		for k, c := range discoveryCache {
			if now.Sub(c.at) >= discoveryTTL {
				delete(discoveryCache, k)
				continue
			}
			if oldest == "" || c.at.Before(discoveryCache[oldest].at) {
				oldest = k
			}
		}
		if len(discoveryCache) >= discoveryMax {
			delete(discoveryCache, oldest)
		}
	}
	discoveryCache[issuer] = cachedEndpoints{ep: ep, at: now}
}

// requirePublicHost rejects an issuer whose host is or resolves to a
// loopback, private, link-local or unspecified address (skipped in Dev).
func (o *OAuth) requirePublicHost(ctx context.Context, issuer string) error {
	if o.Dev {
		return nil
	}
	u, err := url.Parse(issuer)
	if err != nil {
		return fmt.Errorf("auth: issuer %q: %w", issuer, apperr.ErrInvalid)
	}
	host := u.Hostname()
	var addrs []netip.Addr
	if a, err := netip.ParseAddr(host); err == nil {
		addrs = []netip.Addr{a}
	} else {
		addrs, err = net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return fmt.Errorf("auth: issuer %q: resolve: %w", issuer, err)
		}
	}
	for _, a := range addrs {
		a = a.Unmap()
		if a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() || a.IsUnspecified() || a.IsMulticast() {
			return fmt.Errorf("auth: issuer %q resolves to non-public %s: %w", issuer, a, apperr.ErrInvalid)
		}
	}
	return nil
}

func (o *OAuth) redirectURI(id string) string {
	return o.PublicURL + "/api/auth/oauth/" + id + "/callback"
}

// Start builds the provider authorization URL and writes the state+PKCE
// cookie. Unconfigured providers are apperr.ErrNotFound.
func (o *OAuth) Start(ctx context.Context, w http.ResponseWriter, providerID, next string) (string, error) {
	cfg, err := o.Provider(ctx, providerID)
	if err != nil {
		return "", err
	}
	ep, err := o.endpointsFor(ctx, cfg)
	if err != nil {
		return "", err
	}
	st, err := oauthRandom(32)
	if err != nil {
		return "", err
	}
	verifier, err := oauthRandom(32)
	if err != nil {
		return "", err
	}
	raw, err := json.Marshal(oauthState{State: st, Verifier: verifier, Provider: providerID, Next: safeNext(next)})
	if err != nil {
		return "", fmt.Errorf("auth: oauth encode state: %w", err)
	}
	http.SetCookie(w, o.stateCookie(base64.RawURLEncoding.EncodeToString(raw), int(oauthStateTTL/time.Second)))

	challenge := sha256.Sum256([]byte(verifier))
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {cfg.ClientID},
		"redirect_uri":          {o.redirectURI(providerID)},
		"state":                 {st},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(challenge[:])},
		"code_challenge_method": {"S256"},
	}
	if providerID == ProviderGitHub {
		q.Set("scope", "read:user user:email")
	} else {
		q.Set("scope", "openid email")
	}
	return ep.auth + "?" + q.Encode(), nil
}

func (o *OAuth) stateCookie(value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     o.stateCookieName(),
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   !o.Dev,
		SameSite: http.SameSiteLaxMode,
	}
}

// loginError is the redirect target for a failed callback.
func loginError(code string) string {
	return "/login?error=" + code
}

// Finish handles the provider callback. It returns the path to redirect to:
// the next path (full session), /login/mfa (MFA pending), or
// /login?error=<code>. Only store failures are returned as errors.
func (o *OAuth) Finish(ctx context.Context, w http.ResponseWriter, r *http.Request, providerID string) (string, error) {
	// The state cookie is single use, whatever the outcome.
	http.SetCookie(w, o.stateCookie("", -1))

	c, err := r.Cookie(o.stateCookieName())
	if err != nil {
		return loginError(OAuthErrStateInvalid), nil
	}
	st, ok := decodeState(c.Value)
	q := r.URL.Query()
	if !ok || st.Provider != providerID ||
		subtle.ConstantTimeCompare([]byte(st.State), []byte(q.Get("state"))) != 1 {
		return loginError(OAuthErrStateInvalid), nil
	}
	if q.Get("error") != "" || q.Get("code") == "" {
		return loginError(OAuthErrFailed), nil
	}

	cfg, err := o.Provider(ctx, providerID)
	if err != nil {
		return loginError(OAuthErrFailed), nil
	}
	ident, code := o.identify(ctx, cfg, q.Get("code"), st.Verifier)
	if code != "" {
		return loginError(code), nil
	}
	userID, code, err := o.link(ctx, providerID, ident)
	if err != nil {
		return "", err
	}
	if code != "" {
		return loginError(code), nil
	}

	res, err := o.Service.LoginUser(ctx, userID, MethodOAuth, netx.ClientIP(r, o.Service.TrustedProxies), r.UserAgent())
	if errors.Is(err, ErrInvalidCredentials) {
		return loginError(OAuthErrAccountDisabled), nil
	}
	if err != nil {
		return "", err
	}
	o.Service.Sessions.SetCookie(w, res.Cookie)
	if res.MFARequired {
		return "/login/mfa", nil
	}
	return st.Next, nil
}

func decodeState(v string) (oauthState, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(v)
	if err != nil {
		return oauthState{}, false
	}
	var st oauthState
	if err := json.Unmarshal(raw, &st); err != nil || st.State == "" || st.Verifier == "" {
		return oauthState{}, false
	}
	st.Next = safeNext(st.Next)
	return st, true
}

// oauthIdentity is the verified identity a provider vouched for.
type oauthIdentity struct {
	Subject string
	Email   string
}

// identify exchanges code and reads the user's verified identity. A
// non-empty code is the login error to show; provider faults are oauth_failed.
//
// id_token and nonce are intentionally not used: the identity comes from the
// userinfo endpoint over TLS, with a confidential client (client_secret) and
// PKCE binding the code to this browser.
func (o *OAuth) identify(ctx context.Context, cfg ProviderConfig, code, verifier string) (oauthIdentity, string) {
	ep, err := o.endpointsFor(ctx, cfg)
	if err != nil {
		return oauthIdentity{}, OAuthErrFailed
	}
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {o.redirectURI(cfg.ID)},
		"client_id":     {cfg.ClientID},
		"client_secret": {cfg.ClientSecret},
		"code_verifier": {verifier},
	}
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if err := o.postForm(ctx, ep.token, form, &tok); err != nil || tok.AccessToken == "" {
		return oauthIdentity{}, OAuthErrFailed
	}

	if cfg.ID == ProviderGitHub {
		return o.githubIdentity(ctx, ep, tok.AccessToken)
	}
	var info struct {
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified any    `json:"email_verified"`
	}
	if err := o.getJSON(ctx, ep.userinfo, tok.AccessToken, &info); err != nil || info.Sub == "" {
		return oauthIdentity{}, OAuthErrFailed
	}
	if info.Email == "" || !verifiedFlag(info.EmailVerified) {
		return oauthIdentity{}, OAuthErrEmailUnverified
	}
	return oauthIdentity{Subject: info.Sub, Email: normalizeEmail(info.Email)}, ""
}

// verifiedFlag accepts the JSON bool true or the string "true".
func verifiedFlag(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return x == "true"
	}
	return false
}

// githubIdentity uses the primary verified address from /user/emails.
func (o *OAuth) githubIdentity(ctx context.Context, ep endpoints, token string) (oauthIdentity, string) {
	var user struct {
		ID int64 `json:"id"`
	}
	if err := o.getJSON(ctx, ep.userinfo, token, &user); err != nil || user.ID == 0 {
		return oauthIdentity{}, OAuthErrFailed
	}
	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if err := o.getJSON(ctx, o.GitHubAPI+"/user/emails", token, &emails); err != nil {
		return oauthIdentity{}, OAuthErrFailed
	}
	for _, e := range emails {
		if e.Primary && e.Verified && e.Email != "" {
			return oauthIdentity{Subject: strconv.FormatInt(user.ID, 10), Email: normalizeEmail(e.Email)}, ""
		}
	}
	return oauthIdentity{}, OAuthErrEmailUnverified
}

// link returns the user for ident: the linked user if the identity is known,
// otherwise the existing user with that verified email (an identities row
// is inserted). It never creates a user.
func (o *OAuth) link(ctx context.Context, providerID string, ident oauthIdentity) (string, string, error) {
	q := o.Service.Store.Q()
	idn, err := q.GetIdentity(ctx, db.GetIdentityParams{Provider: providerID, Subject: ident.Subject})
	if err == nil {
		return idn.UserID, "", nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", "", fmt.Errorf("auth: oauth get identity: %w", err)
	}
	u, err := q.GetUserByEmail(ctx, ident.Email)
	if errors.Is(err, sql.ErrNoRows) {
		return "", OAuthErrNoAccount, nil
	}
	if err != nil {
		return "", "", fmt.Errorf("auth: oauth get user: %w", err)
	}
	if u.Disabled != 0 {
		return "", OAuthErrAccountDisabled, nil
	}
	err = q.CreateIdentity(ctx, db.CreateIdentityParams{
		ID: store.NewID("idn_"), UserID: u.ID, Provider: providerID, Subject: ident.Subject, Email: ident.Email,
	})
	if err != nil {
		return "", "", fmt.Errorf("auth: oauth link identity: %w", err)
	}
	return u.ID, "", nil
}

func (o *OAuth) getJSON(ctx context.Context, target, bearer string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return fmt.Errorf("auth: oauth request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	return o.do(req, out)
}

func (o *OAuth) postForm(ctx context.Context, target string, form url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, strings.NewReader(form.Encode()))
	if err != nil {
		return fmt.Errorf("auth: oauth request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	return o.do(req, out)
}

func (o *OAuth) do(req *http.Request, out any) error {
	client := o.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("auth: oauth call: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("auth: oauth call %s: status %d", req.URL.Host, resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out); err != nil {
		return fmt.Errorf("auth: oauth decode: %w", err)
	}
	return nil
}
