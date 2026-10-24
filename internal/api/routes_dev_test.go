package api

import (
	"context"
	"net/http"
	"testing"

	"github.com/21cloud/runtime-web/internal/domains"
)

func TestDevDNSOverrideRoute(t *testing.T) {
	dev := domains.NewDevResolver(nil)
	e := newTestEnvWith(t, func(d *Deps) { d.DevDNS = dev })
	e.mkAdmin("admin@example.com")
	cookie, csrf := e.session("admin@example.com")

	body := map[string]any{"name": "_rtweb.Docs.Custom.Test.", "values": []string{"tok"}}
	rec := e.send(http.MethodPut, "/api/admin/dev/dns-override", body, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusNoContent)
	got, err := dev.LookupTXT(context.Background(), "_rtweb.docs.custom.test")
	if err != nil || len(got) != 1 || got[0] != "tok" {
		t.Fatalf("LookupTXT = %v, %v", got, err)
	}

	// Non-admins are refused.
	e.mkUser("user@example.com", "user-passphrase-123")
	uc, ucsrf := e.login("user@example.com", "user-passphrase-123")
	rec = e.send(http.MethodPut, "/api/admin/dev/dns-override", body, withCookie(uc), withCSRF(ucsrf))
	if rec.Code != http.StatusForbidden && rec.Code != http.StatusNotFound {
		t.Fatalf("non-admin status = %d, want 403/404", rec.Code)
	}
}

func TestDevDNSOverrideRouteAbsentOutsideDev(t *testing.T) {
	e := newTestEnv(t)
	e.mkAdmin("admin@example.com")
	cookie, csrf := e.session("admin@example.com")
	rec := e.send(http.MethodPut, "/api/admin/dev/dns-override",
		map[string]any{"name": "_rtweb.x.test", "values": []string{"t"}}, withCookie(cookie), withCSRF(csrf))
	expectStatus(t, rec, http.StatusNotFound)
}
