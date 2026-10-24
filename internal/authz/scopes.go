package authz

var (
	viewerScopes    = []string{"services:read", "logs:read"}
	developerScopes = append(append([]string{}, viewerScopes...), "services:write", "deploy", "env:write", "queue:write", "invoke")
	adminScopes     = append(append([]string{}, developerScopes...), "secrets:write", "data:admin", "sockets:write", "keys:write")
)

// DefaultKeyScopes returns the scopes of an org's default runtime key: every tenant scope except
// keys:write (D4). The result is a fresh slice.
func DefaultKeyScopes() []string {
	var s []string
	for _, sc := range adminScopes {
		if sc != "keys:write" {
			s = append(s, sc)
		}
	}
	return s
}

// ScopesFor returns the runtime key scopes for a role (viewer, developer, admin, owner; owner gets the
// admin set), or nil for an unknown role. The result is a fresh slice.
func ScopesFor(projectRole string) []string {
	var s []string
	switch projectRole {
	case RoleViewer:
		s = viewerScopes
	case RoleDeveloper:
		s = developerScopes
	case RoleAdmin, RoleOwner:
		s = adminScopes
	default:
		return nil
	}
	return append([]string(nil), s...)
}
