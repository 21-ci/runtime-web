// Package apperr holds the domain errors shared by services and the HTTP layer.
// Services return these; internal/api maps them to HTTP responses.
package apperr

import (
	"errors"
	"fmt"
)

var (
	ErrNotFound             = errors.New("apperr: not found")
	ErrForbidden            = errors.New("apperr: forbidden")
	ErrInvalid              = errors.New("apperr: invalid")
	ErrRateLimited          = errors.New("apperr: rate limited")
	ErrPreconditionRequired = errors.New("apperr: precondition required")
)

// Conflict is a state conflict identified by a snake_case code, such as
// last_owner, last_admin, host_taken, slug_taken, org_not_empty,
// already_set_up or stale.
type Conflict struct {
	Code string
}

func (c Conflict) Error() string {
	return fmt.Sprintf("apperr: conflict: %s", c.Code)
}

// Forbidden is a 403 with a specific snake_case code, such as
// setup_token_invalid. It matches ErrForbidden with errors.Is.
type Forbidden struct {
	Code string
}

func (f Forbidden) Error() string {
	return fmt.Sprintf("apperr: forbidden: %s", f.Code)
}

// Is reports whether target is ErrForbidden.
func (f Forbidden) Is(target error) bool {
	return target == ErrForbidden
}

// ForbiddenCode returns the code if err wraps a Forbidden.
func ForbiddenCode(err error) (string, bool) {
	var f Forbidden
	if errors.As(err, &f) {
		return f.Code, true
	}
	return "", false
}

// ConflictCode returns the conflict code if err wraps a Conflict.
func ConflictCode(err error) (string, bool) {
	var c Conflict
	if errors.As(err, &c) {
		return c.Code, true
	}
	return "", false
}
