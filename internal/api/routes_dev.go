package api

import (
	"fmt"
	"net/http"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/authz"
)

// registerDevRoutes adds dev-only routes; they exist only when Deps.DevDNS is set (RTWEB_DEV=1).
func (s *Server) registerDevRoutes() {
	if s.deps.DevDNS == nil {
		return
	}
	s.route(http.MethodPut, "/api/admin/dev/dns-override", authz.InstanceAdmin, s.putDevDNSOverride)
}

type devDNSReq struct {
	Name   string   `json:"name"`
	Values []string `json:"values"`
}

// putDevDNSOverride sets (or, with no values, clears) a TXT override in the dev resolver.
func (s *Server) putDevDNSOverride(w http.ResponseWriter, r *http.Request) error {
	var in devDNSReq
	if err := decodeJSON(w, r, &in); err != nil {
		return err
	}
	if in.Name == "" {
		return fmt.Errorf("api: dev dns override: name required: %w", apperr.ErrInvalid)
	}
	s.deps.DevDNS.Set(in.Name, in.Values)
	w.WriteHeader(http.StatusNoContent)
	return nil
}
