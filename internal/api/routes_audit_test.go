package api

import (
	"fmt"
	"net/http"
	"testing"
)

func TestAuditPagination(t *testing.T) {
	e := newTestEnv(t)
	aliceID := e.mkUser("alice@example.com", testPassword)
	e.mkOrg("acme", aliceID)
	aliceCookie, aliceCSRF := e.session("alice@example.com")
	for i := 0; i < 3; i++ {
		rec := e.send(http.MethodPost, "/api/orgs/acme/invites", map[string]string{"email": fmt.Sprintf("u%d@example.com", i)},
			withCookie(aliceCookie), withCSRF(aliceCSRF))
		expectStatus(t, rec, http.StatusCreated)
	}

	seen := map[string]bool{}
	cursor := ""
	pages := 0
	for {
		target := "/api/orgs/acme/audit?limit=2"
		if cursor != "" {
			target += "&cursor=" + cursor
		}
		rec := e.send(http.MethodGet, target, nil, withCookie(aliceCookie))
		expectStatus(t, rec, http.StatusOK)
		pages++
		if pages > 10 {
			t.Fatalf("pagination did not end")
		}
		body := decode(t, rec)
		items, _ := body["items"].([]any)
		if len(items) > 2 {
			t.Fatalf("page has %d items, limit 2", len(items))
		}
		for _, raw := range items {
			id, _ := raw.(map[string]any)["id"].(string)
			if seen[id] {
				t.Fatalf("entry %s repeated across pages", id)
			}
			seen[id] = true
		}
		next, _ := body["next_cursor"].(string)
		if next == "" {
			break
		}
		cursor = next
	}
	if len(seen) < 3 {
		t.Fatalf("audit entries = %d, want at least the 3 invite creations", len(seen))
	}

	rec := e.send(http.MethodGet, "/api/orgs/acme/audit?limit=500", nil, withCookie(aliceCookie))
	expectStatus(t, rec, http.StatusUnprocessableEntity)
}

func TestOrgAuditScoped(t *testing.T) {
	e := newTestEnv(t)
	aliceID := e.mkUser("alice@example.com", testPassword)
	memberID := e.mkUser("mia@example.com", testPassword)
	carolID := e.mkUser("carol@example.com", testPassword)
	org := e.mkOrg("acme", aliceID)
	e.addMember(org.ID, memberID, "member")
	e.mkOrg("globex", carolID)
	aliceCookie, _ := e.session("alice@example.com")
	miaCookie, _ := e.session("mia@example.com")
	carolCookie, _ := e.session("carol@example.com")

	rec := e.send(http.MethodGet, "/api/orgs/acme/audit", nil, withCookie(aliceCookie))
	expectStatus(t, rec, http.StatusOK)
	rec = e.send(http.MethodGet, "/api/orgs/acme/audit", nil, withCookie(miaCookie))
	expectStatus(t, rec, http.StatusForbidden)
	rec = e.send(http.MethodGet, "/api/orgs/acme/audit", nil, withCookie(carolCookie))
	expectStatus(t, rec, http.StatusNotFound)
}

func TestAdminAuditInstanceAdminOnly(t *testing.T) {
	e := newTestEnv(t)
	e.mkAdmin("admin@example.com")
	aliceID := e.mkUser("alice@example.com", testPassword)
	e.mkOrg("acme", aliceID)
	adminCookie, _ := e.session("admin@example.com")
	aliceCookie, _ := e.session("alice@example.com")

	rec := e.send(http.MethodGet, "/api/admin/audit", nil, withCookie(aliceCookie))
	expectStatus(t, rec, http.StatusForbidden)
	rec = e.send(http.MethodGet, "/api/admin/audit", nil, withCookie(adminCookie))
	expectStatus(t, rec, http.StatusOK)
}
