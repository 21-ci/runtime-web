package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/apps"
	"github.com/21cloud/runtime-web/internal/auth"
	"github.com/21cloud/runtime-web/internal/runtime"
)

// fieldErrors maps request field paths to messages (422 invalid, details.fields).
type fieldErrors map[string]string

// validationError is a web-side input error. It matches apperr.ErrInvalid.
type validationError struct {
	message string
	fields  fieldErrors
}

func (e *validationError) Error() string { return "api: invalid request: " + e.message }

// Is reports whether target is apperr.ErrInvalid.
func (e *validationError) Is(target error) bool { return target == apperr.ErrInvalid }

// invalid returns a 422 invalid error carrying per-field messages.
func invalid(fields fieldErrors) error {
	return &validationError{message: "some fields are invalid", fields: fields}
}

// apiError is a fully resolved HTTP error.
type apiError struct {
	status     int
	code       string
	message    string
	details    any
	retryAfter time.Duration
}

// errorBody is the error envelope of api-web.md §1.4.
type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details,omitempty"`
}

// writeAPIError writes e as the JSON error envelope, with Retry-After when set.
func writeAPIError(w http.ResponseWriter, e apiError) {
	if secs := retrySeconds(e.retryAfter); secs > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(secs))
	}
	writeJSON(w, e.status, map[string]errorBody{
		"error": {Code: e.code, Message: e.message, Details: e.details},
	})
}

// writeErr maps err with mapError, logs internal failures, and writes the envelope.
func (s *Server) writeErr(w http.ResponseWriter, r *http.Request, err error) {
	e := mapError(err)
	if e.status == http.StatusInternalServerError {
		s.deps.Logger.Error("api: request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	}
	writeAPIError(w, e)
}

func retrySeconds(d time.Duration) int {
	return int(d / time.Second)
}

// mapError turns a service error into its HTTP status, code and details
// (api-web.md §1.5). The order matters: the most specific wrapper wins.
func mapError(err error) apiError {
	var ve *validationError
	var inv apps.Invalid
	var rerr *runtime.Error
	var conflict apperr.Conflict

	switch {
	case errors.As(err, &ve):
		fields := ve.fields
		if fields == nil {
			fields = fieldErrors{}
		}
		return apiError{status: http.StatusUnprocessableEntity, code: "invalid",
			message: ve.message, details: map[string]any{"fields": fields}}
	case errors.As(err, &inv) && inv.Err != nil:
		return mapRuntime(inv.Err)
	case errors.As(err, &rerr):
		return mapRuntime(rerr)
	case errors.Is(err, runtime.ErrUnavailable):
		return apiError{status: http.StatusBadGateway, code: "runtime_unavailable", message: "runtime unavailable"}
	case errors.As(err, &conflict):
		if conflict.Code == "sso_not_configured" {
			return apiError{status: http.StatusUnprocessableEntity, code: "invalid",
				message: "password login cannot be disabled without an SSO provider",
				details: map[string]any{"fields": fieldErrors{"password_login_disabled": "requires a configured SSO provider"}}}
		}
		msg := humanize(conflict.Code)
		if conflict.Public && conflict.Message != "" {
			msg = conflict.Message
		}
		return apiError{status: http.StatusConflict, code: conflict.Code, message: msg}
	}

	if code, ok := apperr.ForbiddenCode(err); ok {
		return apiError{status: http.StatusForbidden, code: code, message: humanize(code)}
	}
	if code, ok := apperr.NotFoundCode(err); ok {
		return apiError{status: http.StatusNotFound, code: code, message: humanize(code)}
	}

	switch {
	case errors.Is(err, apperr.ErrForbidden):
		return apiError{status: http.StatusForbidden, code: "forbidden", message: "you do not have access to this"}
	case errors.Is(err, apperr.ErrNotFound):
		return apiError{status: http.StatusNotFound, code: "not_found", message: "not found"}
	case errors.Is(err, apperr.ErrPreconditionRequired):
		return apiError{status: http.StatusPreconditionRequired, code: "precondition_required",
			message: "If-Match header required"}
	case errors.Is(err, apperr.ErrRateLimited):
		return apiError{status: http.StatusTooManyRequests, code: "rate_limited", message: "too many requests, try later"}
	case errors.Is(err, apperr.ErrInvalid):
		return apiError{status: http.StatusUnprocessableEntity, code: "invalid", message: "invalid input",
			details: map[string]any{"fields": fieldErrors{}}}
	case errors.Is(err, auth.ErrInvalidCredentials):
		return apiError{status: http.StatusUnauthorized, code: "invalid_credentials", message: "invalid email or password"}
	case errors.Is(err, auth.ErrNoSession):
		return apiError{status: http.StatusUnauthorized, code: "unauthenticated", message: "sign in required"}
	case errors.Is(err, auth.ErrInvalidCode):
		return apiError{status: http.StatusUnprocessableEntity, code: "invalid_code", message: "invalid code"}
	}
	return apiError{status: http.StatusInternalServerError, code: "internal", message: "internal error"}
}

// mapRuntime maps a runtime control API error, keeping its code and details
// for 422 and retry hints for busy and throttled responses.
func mapRuntime(e *runtime.Error) apiError {
	switch {
	case runtime.IsBusy(e):
		return apiError{status: http.StatusServiceUnavailable, code: "busy", message: "runtime is busy, retry shortly",
			details: retryDetails(e.RetryAfter), retryAfter: e.RetryAfter}
	case runtime.IsThrottled(e):
		return apiError{status: http.StatusTooManyRequests, code: e.Code, message: "runtime limit reached, retry shortly",
			details: retryDetails(e.RetryAfter), retryAfter: e.RetryAfter}
	case runtime.IsDisabled(e):
		return apiError{status: http.StatusBadGateway, code: "runtime_unavailable", message: "runtime unavailable"}
	case e.Status == http.StatusNotFound:
		return apiError{status: http.StatusNotFound, code: "not_found", message: "not found"}
	case e.Status == http.StatusPreconditionFailed:
		return apiError{status: http.StatusConflict, code: "stale", message: "changed elsewhere, reload and try again"}
	case e.Status == http.StatusUnprocessableEntity:
		return apiError{status: http.StatusUnprocessableEntity, code: e.Code, message: e.Message,
			details: rawDetails(e.Details)}
	}
	return apiError{status: http.StatusInternalServerError, code: "internal", message: "internal error"}
}

func retryDetails(d time.Duration) map[string]any {
	return map[string]any{"retry_after": retrySeconds(d)}
}

// rawDetails passes a runtime details object through unchanged; nil when absent.
func rawDetails(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	return raw
}

// passwordReason returns the policy reason of a ValidatePassword error,
// without the package prefix and the sentinel suffix.
func passwordReason(err error) string {
	s := strings.TrimPrefix(err.Error(), "auth: ")
	return strings.TrimSuffix(s, ": "+apperr.ErrInvalid.Error())
}

// humanize turns a snake_case code into a readable message.
func humanize(code string) string {
	return strings.ReplaceAll(code, "_", " ")
}

// writeJSON writes v as a JSON response with the given status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Default().Error("api: encode response", "err", err)
	}
}

// decodeJSON reads a JSON request body of at most 1 MiB into v.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return &validationError{message: "request body must be a JSON object"}
	}
	return nil
}
