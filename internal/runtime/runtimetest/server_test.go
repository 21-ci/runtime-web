package runtimetest_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"testing"

	"github.com/21cloud/runtime-web/internal/runtime"
	"github.com/21cloud/runtime-web/internal/runtime/runtimetest"
)

var allScopes = []string{"services:read", "services:write", "deploy", "invoke", "logs:read", "env:write", "secrets:write", "queue:write", "data:admin", "keys:write"}

func TestFakeCascadeRevoke(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	op := operator(f)
	ten := newTenant(t, op, "acme", "free")

	parent := newKey(t, op, ten.ID, "keys:write", "services:read")
	child := mintKey(t, f, parent.Secret, runtime.KeyCreate{Scopes: []string{"keys:write", "services:read"}})
	grand := mintKey(t, f, child.Secret, runtime.KeyCreate{Scopes: []string{"services:read"}})
	sibling := newKey(t, op, ten.ID, "services:read")

	for _, k := range []runtime.KeyCreated{parent, child, grand, sibling} {
		if _, err := withKey(f, k.Secret).Me(ctx); err != nil {
			t.Fatalf("key %s rejected before revoke: %v", k.ID, err)
		}
	}

	if err := op.RevokeTenantKey(ctx, ten.ID, parent.ID); err != nil {
		t.Fatalf("revoke parent: %v", err)
	}
	for _, k := range []runtime.KeyCreated{parent, child, grand} {
		_, err := withKey(f, k.Secret).Me(ctx)
		wantAPIErr(t, err, 401, "unauthorized")
	}
	if _, err := withKey(f, sibling.Secret).Me(ctx); err != nil {
		t.Fatalf("unrelated sibling key revoked by cascade: %v", err)
	}
	wantAPIErr(t, op.RevokeTenantKey(ctx, ten.ID, parent.ID), 404, "not_found")
}

func TestFakeTenantIsolation(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	op := operator(f)
	a := newTenant(t, op, "a", "free")
	b := newTenant(t, op, "b", "free")
	keyA := newKey(t, op, a.ID, allScopes...)
	keyB := newKey(t, op, b.ID, allScopes...)
	svc, err := asTenant(f, a.ID).CreateService(ctx, runtime.ServiceCreate{Slug: "shop", Runtime: "deno"})
	must(t, err)
	ownA := withKey(f, keyA.Secret)
	ownB := withKey(f, keyB.Secret)

	if _, _, err := ownA.GetService(ctx, svc.ID); err != nil {
		t.Fatalf("tenant A reads its own service: %v", err)
	}
	if page, err := ownB.ListServices(ctx, runtime.ServiceFilter{Slug: "shop"}); err != nil || len(page.Items) != 0 {
		t.Fatalf("tenant B lists A's slug: items=%d err=%v", len(page.Items), err)
	}

	name := "renamed"
	tests := []struct {
		name   string
		call   func() error
		status int
		code   string
	}{
		{"tenant B gets A service", func() error { _, _, err := ownB.GetService(ctx, svc.ID); return err }, 404, "not_found"},
		{"operator acting as B gets A service", func() error { _, _, err := asTenant(f, b.ID).GetService(ctx, svc.ID); return err }, 404, "not_found"},
		{"tenant B patches A service", func() error {
			_, err := ownB.PatchService(ctx, svc.ID, runtime.ServicePatch{Name: &name}, "")
			return err
		}, 404, "not_found"},
		{"tenant B deletes A service", func() error { return ownB.DeleteService(ctx, svc.ID, false) }, 404, "not_found"},
		{"tenant B reads A usage", func() error { _, err := ownB.TenantUsage(ctx, a.ID); return err }, 404, "not_found"},
		{"tenant A reads B usage", func() error { _, err := ownA.TenantUsage(ctx, b.ID); return err }, 404, "not_found"},
		{"operator revokes B key under A", func() error { return op.RevokeTenantKey(ctx, a.ID, keyB.ID) }, 404, "not_found"},
		{"tenant A revokes B key", func() error { return ownA.RevokeTenantKey(ctx, b.ID, keyB.ID) }, 403, "insufficient_scope"},
		{"tenant B mints key in A", func() error {
			_, err := ownB.CreateTenantKey(ctx, a.ID, runtime.KeyCreate{Scopes: []string{"services:read"}})
			return err
		}, 403, "insufficient_scope"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			wantAPIErr(t, tt.call(), tt.status, tt.code)
		})
	}

	if _, _, err := ownA.GetService(ctx, svc.ID); err != nil {
		t.Fatalf("A's service changed by B's attempts: %v", err)
	}
}

func TestFakeScopesEnforced(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	op := operator(f)
	ten := newTenant(t, op, "acme", "free")
	svc, err := asTenant(f, ten.ID).CreateService(ctx, runtime.ServiceCreate{Slug: "api", Runtime: "deno"})
	must(t, err)

	readerKey := newKey(t, op, ten.ID, "services:read")
	reader := withKey(f, readerKey.Secret)
	adminKey := newKey(t, op, ten.ID, "services:read", "services:write", "keys:write")
	admin := withKey(f, adminKey.Secret)
	name := "renamed"

	tests := []struct {
		name   string
		call   func() error
		status int // 0 = must succeed
		code   string
	}{
		{"read key reads service", func() error { _, _, err := reader.GetService(ctx, svc.ID); return err }, 0, ""},
		{"read key lists services", func() error { _, err := reader.ListServices(ctx, runtime.ServiceFilter{}); return err }, 0, ""},
		{"read key reads self", func() error { _, err := reader.Me(ctx); return err }, 0, ""},
		{"read key creates service", func() error {
			_, err := reader.CreateService(ctx, runtime.ServiceCreate{Slug: "api2", Runtime: "deno"})
			return err
		}, 403, "insufficient_scope"},
		{"read key patches service", func() error {
			_, err := reader.PatchService(ctx, svc.ID, runtime.ServicePatch{Name: &name}, "")
			return err
		}, 403, "insufficient_scope"},
		{"read key deletes service", func() error { return reader.DeleteService(ctx, svc.ID, false) }, 403, "insufficient_scope"},
		{"read key creates tenant", func() error {
			_, err := reader.CreateTenant(ctx, runtime.TenantCreate{Name: "x", Plan: "free"})
			return err
		}, 403, "insufficient_scope"},
		{"write key creates service", func() error {
			_, err := admin.CreateService(ctx, runtime.ServiceCreate{Slug: "api2", Runtime: "deno"})
			return err
		}, 0, ""},
		{"write key creates tenant", func() error {
			_, err := admin.CreateTenant(ctx, runtime.TenantCreate{Name: "x", Plan: "free"})
			return err
		}, 403, "insufficient_scope"},
		{"no credential", func() error { _, err := runtime.New(f.URL, nil).With(nil).Me(ctx); return err }, 401, "unauthorized"},
		{"unknown key", func() error { _, err := withKey(f, "rtk_key_nope_bad").Me(ctx); return err }, 401, "unauthorized"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.call()
			if tt.status == 0 {
				if err != nil {
					t.Fatalf("want success, got %v", err)
				}
				return
			}
			wantAPIErr(t, err, tt.status, tt.code)
		})
	}

	t.Run("read key mints key", func(t *testing.T) {
		status, body := postKeys(t, f, readerKey.Secret, runtime.KeyCreate{Scopes: []string{"services:read"}})
		if status != http.StatusForbidden {
			t.Fatalf("status %d, want 403: %s", status, body)
		}
	})
	t.Run("key cannot escalate scopes", func(t *testing.T) {
		status, body := postKeys(t, f, adminKey.Secret, runtime.KeyCreate{Scopes: []string{"deploy"}})
		if status != http.StatusForbidden {
			t.Fatalf("status %d, want 403: %s", status, body)
		}
		var env struct {
			Error struct {
				Code    string `json:"code"`
				Details struct {
					Reason string `json:"reason"`
				} `json:"details"`
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &env); err != nil {
			t.Fatal(err)
		}
		if env.Error.Code != "insufficient_scope" || env.Error.Details.Reason != "escalation" {
			t.Fatalf("error %+v, want insufficient_scope with reason escalation", env.Error)
		}
	})
	t.Run("key mints narrower child", func(t *testing.T) {
		status, body := postKeys(t, f, adminKey.Secret, runtime.KeyCreate{Scopes: []string{"services:read"}})
		if status != http.StatusCreated {
			t.Fatalf("status %d, want 201: %s", status, body)
		}
	})
}

func TestFakePlanEnforced(t *testing.T) {
	f := runtimetest.NewServer(t)
	ctx := context.Background()
	op := operator(f)

	f.SetPlan("tiny", runtimetest.FakePlan{MaxServices: 1, Triggers: []string{"http", "interval"}})
	tiny := newTenant(t, op, "tiny", "tiny")
	tinyCl := asTenant(f, tiny.ID)
	_, err := tinyCl.CreateService(ctx, runtime.ServiceCreate{Slug: "one", Runtime: "deno"})
	must(t, err)
	_, err = tinyCl.CreateService(ctx, runtime.ServiceCreate{Slug: "two", Runtime: "deno"})
	wantAPIErr(t, err, 403, "quota_exceeded")

	f.SetPlan("tiny", runtimetest.FakePlan{MaxServices: 2, Triggers: []string{"http", "interval"}})
	_, err = tinyCl.CreateService(ctx, runtime.ServiceCreate{Slug: "two", Runtime: "deno"})
	must(t, err) // raising the plan limit applies to existing tenants

	free := newTenant(t, op, "free", "free")
	freeCl := asTenant(f, free.ID)
	_, err = freeCl.CreateService(ctx, runtime.ServiceCreate{Slug: "cron", Runtime: "deno", Triggers: json.RawMessage(`{"cron":true}`)})
	wantAPIErr(t, err, 403, "trigger_not_allowed")

	off, err := freeCl.CreateService(ctx, runtime.ServiceCreate{Slug: "cronoff", Runtime: "deno", Triggers: json.RawMessage(`{"cron":false}`)})
	must(t, err)
	_, err = freeCl.PatchService(ctx, off.ID, runtime.ServicePatch{Triggers: json.RawMessage(`{"cron":true}`)}, "")
	wantAPIErr(t, err, 403, "trigger_not_allowed")
}

// operator returns a client acting with the root token and no tenant.
func operator(f *runtimetest.Fake) *runtime.Scoped {
	return runtime.New(f.URL, nil).With(runtime.RootCred{Token: f.RootToken})
}

// asTenant returns an operator client acting on tenantID (x-rt-tenant).
func asTenant(f *runtimetest.Fake, tenantID string) *runtime.Scoped {
	return runtime.New(f.URL, nil).With(runtime.RootCred{Token: f.RootToken, Tenant: tenantID})
}

// withKey returns a client authenticated with a tenant key secret.
func withKey(f *runtimetest.Fake, secret string) *runtime.Scoped {
	return runtime.New(f.URL, nil).With(runtime.TenantKeyCred{Secret: secret})
}

func newTenant(t *testing.T, op *runtime.Scoped, name, plan string) runtime.Tenant {
	t.Helper()
	ten, err := op.CreateTenant(context.Background(), runtime.TenantCreate{Name: name, Plan: plan})
	must(t, err)
	return ten
}

func newKey(t *testing.T, op *runtime.Scoped, tenantID string, scopes ...string) runtime.KeyCreated {
	t.Helper()
	k, err := op.CreateTenantKey(context.Background(), tenantID, runtime.KeyCreate{Scopes: scopes})
	must(t, err)
	return k
}

// mintKey creates a child key through POST /v1/keys. The client has no
// self-service key method, so this goes over raw HTTP.
func mintKey(t *testing.T, f *runtimetest.Fake, secret string, in runtime.KeyCreate) runtime.KeyCreated {
	t.Helper()
	status, body := postKeys(t, f, secret, in)
	if status != http.StatusCreated {
		t.Fatalf("mint key: status %d: %s", status, body)
	}
	var out runtime.KeyCreated
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// postKeys calls POST /v1/keys with secret and returns the status and body.
func postKeys(t *testing.T, f *runtimetest.Fake, secret string, in runtime.KeyCreate) (int, []byte) {
	t.Helper()
	b, err := json.Marshal(in)
	must(t, err)
	req, err := http.NewRequest(http.MethodPost, f.URL+"/v1/keys", bytes.NewReader(b))
	must(t, err)
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	must(t, err)
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	must(t, err)
	return resp.StatusCode, body
}

// wantAPIErr fails unless err is a runtime API error with the given status and code.
func wantAPIErr(t *testing.T, err error, status int, code string) {
	t.Helper()
	var e *runtime.Error
	if !errors.As(err, &e) {
		t.Fatalf("want runtime error %d %s, got %v", status, code, err)
	}
	if e.Status != status || e.Code != code {
		t.Fatalf("want %d %s, got %d %s (%s)", status, code, e.Status, e.Code, e.Message)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
