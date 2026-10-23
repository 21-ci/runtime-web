package authz

var (
	viewerScopes    = []string{"services:read", "logs:read"}
	developerScopes = append(append([]string{}, viewerScopes...), "services:write", "deploy", "env:write", "queue:write", "invoke")
	adminScopes     = append(append([]string{}, developerScopes...), "secrets:write", "data:admin", "keys:write")
)

// ScopesFor returns the runtime key scopes for a project role (viewer, developer, admin), or nil for an
// unknown role. The result is a fresh slice.
func ScopesFor(projectRole string) []string {
	var s []string
	switch projectRole {
	case RoleViewer:
		s = viewerScopes
	case RoleDeveloper:
		s = developerScopes
	case RoleAdmin:
		s = adminScopes
	default:
		return nil
	}
	return append([]string(nil), s...)
}
