package authz

import (
	"slices"
	"testing"
)

const slug = "web"

// Subjects in matrix column order.
var (
	owner      = Subject{UserID: "u1", OrgRole: "owner"}
	admin      = Subject{UserID: "u2", OrgRole: "admin"}
	memAdmin   = Subject{UserID: "u3", OrgRole: "member", ProjectRoles: map[string]string{slug: "admin"}}
	memDev     = Subject{UserID: "u4", OrgRole: "member", ProjectRoles: map[string]string{slug: "developer"}}
	memViewer  = Subject{UserID: "u5", OrgRole: "member", ProjectRoles: map[string]string{slug: "viewer"}}
	memNone    = Subject{UserID: "u6", OrgRole: "member"}
	nonMember  = Subject{UserID: "u7"}
	instAdmin  = Subject{UserID: "u8", InstanceAdmin: true}
	allColumns = []Subject{owner, admin, memAdmin, memDev, memViewer, memNone, nonMember, instAdmin}
	colNames   = []string{"owner", "admin", "member+admin", "member+developer", "member+viewer", "member no grant", "non-member", "instance admin"}
)

func TestCanMatrix(t *testing.T) {
	const T, F = true, false
	tests := []struct {
		action Action
		want   [8]bool // owner, admin, m+admin, m+dev, m+viewer, m-none, non-member, instance admin
	}{
		{OrgRead, [8]bool{T, T, T, T, T, T, F, T}},
		{OrgUpdate, [8]bool{T, T, F, F, F, F, F, T}},
		{OrgDelete, [8]bool{T, F, F, F, F, F, F, T}},
		{OrgAuditRead, [8]bool{T, T, F, F, F, F, F, T}},
		{OrgUsageRead, [8]bool{T, T, F, F, F, F, F, T}},
		{MembersManage, [8]bool{T, T, F, F, F, F, F, T}},
		{MembersOwners, [8]bool{T, F, F, F, F, F, F, T}},
		{InvitesManage, [8]bool{T, T, F, F, F, F, F, T}},
		{TokensManage, [8]bool{T, T, F, F, F, F, F, T}},
		{DefaultKeyRotate, [8]bool{T, T, F, F, F, F, F, T}},
		{ProjectCreate, [8]bool{T, T, F, F, F, F, F, T}},
		{ProjectRead, [8]bool{T, T, T, T, T, F, F, T}},
		{ProjectUpdate, [8]bool{T, T, T, F, F, F, F, T}},
		{ProjectDelete, [8]bool{T, T, F, F, F, F, F, T}},
		{GrantsManage, [8]bool{T, T, T, F, F, F, F, T}},
		{DomainsManage, [8]bool{T, T, T, F, F, F, F, T}},
		{AppRead, [8]bool{T, T, T, T, T, F, F, T}},
		{AppCreate, [8]bool{T, T, T, T, F, F, F, T}},
		{AppUpdate, [8]bool{T, T, T, T, F, F, F, T}},
		{AppDelete, [8]bool{T, T, T, T, F, F, F, T}},
		{AppDeploy, [8]bool{T, T, T, T, F, F, F, T}},
		{AppEnvWrite, [8]bool{T, T, T, T, F, F, F, T}},
		{AppSecretsWrite, [8]bool{T, T, T, F, F, F, F, T}},
		{AppSchedulesWrite, [8]bool{T, T, T, T, F, F, F, T}},
		{AppQueueWrite, [8]bool{T, T, T, T, F, F, F, T}},
		{AppLogsRead, [8]bool{T, T, T, T, T, F, F, T}},
		{AppDataExport, [8]bool{T, T, T, F, F, F, F, T}},
		{InstanceAdmin, [8]bool{F, F, F, F, F, F, F, T}},
	}
	if len(tests) != len(Actions) {
		t.Fatalf("matrix has %d rows, Actions has %d", len(tests), len(Actions))
	}
	for _, tt := range tests {
		t.Run(string(tt.action), func(t *testing.T) {
			for i, s := range allColumns {
				if got := Can(s, tt.action, slug); got != tt.want[i] {
					t.Errorf("Can(%s, %s) = %v, want %v", colNames[i], tt.action, got, tt.want[i])
				}
			}
		})
	}
}

func TestCanUnknownAction(t *testing.T) {
	for i, s := range allColumns {
		if Can(s, Action("app.nuke"), slug) {
			t.Errorf("Can(%s, unknown) = true", colNames[i])
		}
	}
}

func TestCrossOrgIsolation(t *testing.T) {
	// A non-member carrying stale grants must still get nothing.
	stale := Subject{UserID: "u9", ProjectRoles: map[string]string{slug: "admin"}}
	for _, a := range Actions {
		if Can(nonMember, a, slug) {
			t.Errorf("non-member Can(%s) = true", a)
		}
		if Can(stale, a, slug) {
			t.Errorf("non-member with grant Can(%s) = true", a)
		}
	}
	for _, a := range []Action{ProjectRead, AppRead, AppDeploy, AppSecretsWrite, GrantsManage, DomainsManage} {
		if !Can(memAdmin, a, "web") {
			t.Errorf("grant on web: Can(%s, web) = false", a)
		}
		if Can(memAdmin, a, "api") {
			t.Errorf("grant on web leaked to api: Can(%s, api) = true", a)
		}
		if Can(memAdmin, a, "") {
			t.Errorf("grant on web leaked to empty slug: Can(%s) = true", a)
		}
	}
}

func TestDefaultKeyScopes(t *testing.T) {
	want := []string{"services:read", "logs:read", "services:write", "deploy", "env:write", "queue:write", "invoke", "secrets:write", "data:admin", "sockets:write"}
	if got := DefaultKeyScopes(); !slices.Equal(got, want) {
		t.Errorf("DefaultKeyScopes() = %v, want %v", got, want)
	}
}

func TestScopesFor(t *testing.T) {
	tests := []struct {
		role string
		want []string
	}{
		{"viewer", []string{"services:read", "logs:read"}},
		{"developer", []string{"services:read", "logs:read", "services:write", "deploy", "env:write", "queue:write", "invoke"}},
		{"admin", []string{"services:read", "logs:read", "services:write", "deploy", "env:write", "queue:write", "invoke", "secrets:write", "data:admin", "sockets:write", "keys:write"}},
		{"owner", []string{"services:read", "logs:read", "services:write", "deploy", "env:write", "queue:write", "invoke", "secrets:write", "data:admin", "sockets:write", "keys:write"}},
		{"member", nil},
		{"", nil},
	}
	for _, tt := range tests {
		t.Run(tt.role, func(t *testing.T) {
			got := ScopesFor(tt.role)
			if !slices.Equal(got, tt.want) {
				t.Errorf("ScopesFor(%q) = %v, want %v", tt.role, got, tt.want)
			}
		})
	}
	// Callers must not be able to mutate the shared table.
	ScopesFor("viewer")[0] = "x"
	if ScopesFor("viewer")[0] != "services:read" {
		t.Error("ScopesFor returned shared slice")
	}
}
