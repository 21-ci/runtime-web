package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/apps"
	"github.com/21cloud/runtime-web/internal/auth"
	"github.com/21cloud/runtime-web/internal/runtime"
)

func TestErrorMappingTable(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		status     int
		code       string
		retryAfter string            // expected Retry-After header, "" for none
		fields     map[string]string // expected details.fields keys, nil when none checked
		details    map[string]any    // expected details keys (subset), nil when none checked
	}{
		{name: "invalid credentials", err: auth.ErrInvalidCredentials, status: 401, code: "invalid_credentials"},
		{name: "no session", err: auth.ErrNoSession, status: 401, code: "unauthenticated"},
		{name: "invalid totp code", err: auth.ErrInvalidCode, status: 422, code: "invalid_code"},
		{name: "not found", err: apperr.ErrNotFound, status: 404, code: "not_found"},
		{name: "not found with code", err: apperr.NotFound{Code: "invite_invalid"}, status: 404, code: "invite_invalid"},
		{name: "forbidden", err: apperr.ErrForbidden, status: 403, code: "forbidden"},
		{name: "forbidden with code", err: apperr.Forbidden{Code: "setup_token_invalid"}, status: 403, code: "setup_token_invalid"},
		{name: "conflict", err: apperr.Conflict{Code: "already_set_up"}, status: 409, code: "already_set_up"},
		{
			name:   "sso_not_configured maps to invalid field",
			err:    fmt.Errorf("auth: set policy: %w", apperr.Conflict{Code: "sso_not_configured"}),
			status: 422, code: "invalid", fields: map[string]string{"password_login_disabled": ""},
		},
		{name: "invalid", err: apperr.ErrInvalid, status: 422, code: "invalid", fields: map[string]string{}},
		{
			name:   "validation error with fields",
			err:    invalid(fieldErrors{"ingress.ip_allow[1]": "not a CIDR prefix"}),
			status: 422, code: "invalid", fields: map[string]string{"ingress.ip_allow[1]": ""},
		},
		{
			name: "runtime invalid keeps code and details",
			err: apps.Invalid{Err: &runtime.Error{Status: 422, Code: "validation_failed", Message: "bad",
				Details: json.RawMessage(`{"line":3}`)}},
			status: 422, code: "validation_failed", details: map[string]any{"line": float64(3)},
		},
		{name: "runtime stale etag", err: &runtime.Error{Status: 412, Code: "precondition_failed"}, status: 409, code: "stale"},
		{name: "runtime not found", err: &runtime.Error{Status: 404, Code: "not_found"}, status: 404, code: "not_found"},
		{
			name:   "runtime rate limited",
			err:    &runtime.Error{Status: 429, Code: "rate_limited", RetryAfter: 5 * time.Second},
			status: 429, code: "rate_limited", retryAfter: "5", details: map[string]any{"retry_after": float64(5)},
		},
		{
			name:   "runtime queue full",
			err:    &runtime.Error{Status: 429, Code: "queue_full", RetryAfter: 2 * time.Second},
			status: 429, code: "queue_full", retryAfter: "2",
		},
		{
			name:   "runtime build quota",
			err:    &runtime.Error{Status: 429, Code: "build_quota"},
			status: 429, code: "build_quota",
		},
		{
			name:   "runtime busy",
			err:    &runtime.Error{Status: 503, Code: "queue_timeout", RetryAfter: 3 * time.Second},
			status: 503, code: "busy", retryAfter: "3",
		},
		{
			name:   "runtime overloaded",
			err:    &runtime.Error{Status: 503, Code: "overloaded"},
			status: 503, code: "busy",
		},
		{name: "runtime control disabled", err: &runtime.Error{Status: 503, Code: "control_disabled"}, status: 502, code: "runtime_unavailable"},
		{name: "runtime unreachable", err: fmt.Errorf("api: call: %w", runtime.ErrUnavailable), status: 502, code: "runtime_unavailable"},
		{name: "precondition required", err: apperr.ErrPreconditionRequired, status: 428, code: "precondition_required"},
		{name: "rate limited", err: apperr.ErrRateLimited, status: 429, code: "rate_limited"},
		{name: "unknown error is internal", err: fmt.Errorf("boom"), status: 500, code: "internal"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeAPIError(rec, mapError(tt.err))
			expectStatus(t, rec, tt.status)
			if got := errCode(t, rec); got != tt.code {
				t.Fatalf("code = %q, want %q", got, tt.code)
			}
			if got := rec.Header().Get("Retry-After"); got != tt.retryAfter {
				t.Fatalf("Retry-After = %q, want %q", got, tt.retryAfter)
			}
			env := decode(t, rec)["error"].(map[string]any)
			if tt.fields != nil {
				fields, ok := env["details"].(map[string]any)["fields"].(map[string]any)
				if !ok {
					t.Fatalf("details.fields missing in %v", env)
				}
				for k := range tt.fields {
					if _, ok := fields[k]; !ok {
						t.Fatalf("details.fields has no %q: %v", k, fields)
					}
				}
			}
			for k, want := range tt.details {
				d, _ := env["details"].(map[string]any)
				if d[k] != want {
					t.Fatalf("details[%s] = %v, want %v", k, d[k], want)
				}
			}
			if http.StatusOK == rec.Code {
				t.Fatal("error mapped to 200")
			}
		})
	}
}

func TestBusyRetryAfterHeaderValue(t *testing.T) {
	rec := httptest.NewRecorder()
	writeAPIError(rec, mapError(&runtime.Error{Status: 503, Code: "queue_timeout", RetryAfter: 7 * time.Second}))
	if got := rec.Header().Get("Retry-After"); got != "7" {
		t.Fatalf("Retry-After = %q, want 7", got)
	}
}
