package runtime

import "net/http"

// Credential authenticates a request to the runtime control API.
type Credential interface {
	apply(r *http.Request)
}

// RootCred is the operator root token. Tenant, when set, is sent as
// x-rt-tenant so the operator acts on that tenant.
type RootCred struct {
	Token  string
	Tenant string
}

func (c RootCred) apply(r *http.Request) {
	r.Header.Set("Authorization", "Bearer "+c.Token)
	if c.Tenant != "" {
		r.Header.Set("x-rt-tenant", c.Tenant)
	}
}

// TenantKeyCred is a tenant key (`rtk_<id>_<secret>`).
type TenantKeyCred struct {
	Secret string
}

func (c TenantKeyCred) apply(r *http.Request) {
	r.Header.Set("Authorization", "Bearer "+c.Secret)
}
