package runtime

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// ErrUnavailable wraps transport errors (runtime unreachable).
var ErrUnavailable = errors.New("runtime: unavailable")

// Error is a non-2xx response from the runtime control API.
type Error struct {
	Status     int
	Code       string
	Message    string
	RetryAfter time.Duration
	Details    json.RawMessage
}

func (e *Error) Error() string {
	return fmt.Sprintf("runtime: %d %s: %s", e.Status, e.Code, e.Message)
}

// maxErrorBody bounds how much of an error response is read.
const maxErrorBody = 1 << 20

func decodeError(resp *http.Response) *Error {
	e := &Error{Status: resp.StatusCode}
	var env struct {
		Error struct {
			Code    string          `json:"code"`
			Message string          `json:"message"`
			Details json.RawMessage `json:"details"`
		} `json:"error"`
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
	if json.Unmarshal(b, &env) == nil && env.Error.Code != "" {
		e.Code, e.Message, e.Details = env.Error.Code, env.Error.Message, env.Error.Details
	} else {
		e.Code = "http_" + strconv.Itoa(resp.StatusCode)
		e.Message = http.StatusText(resp.StatusCode)
	}
	if ra := resp.Header.Get("Retry-After"); ra != "" {
		if n, err := strconv.Atoi(ra); err == nil && n >= 0 {
			e.RetryAfter = time.Duration(n) * time.Second
		}
	}
	return e
}

func asError(err error) (*Error, bool) {
	var e *Error
	ok := errors.As(err, &e)
	return e, ok
}

// IsNotFound reports a 404 from the runtime.
func IsNotFound(err error) bool {
	e, ok := asError(err)
	return ok && e.Status == http.StatusNotFound
}

// IsBusy reports 503 queue_timeout or overloaded.
func IsBusy(err error) bool {
	e, ok := asError(err)
	return ok && e.Status == http.StatusServiceUnavailable &&
		(e.Code == "queue_timeout" || e.Code == "overloaded")
}

// IsThrottled reports 429 rate_limited, build_quota or queue_full.
func IsThrottled(err error) bool {
	e, ok := asError(err)
	if !ok || e.Status != http.StatusTooManyRequests {
		return false
	}
	switch e.Code {
	case "rate_limited", "build_quota", "queue_full":
		return true
	}
	return false
}

// IsDisabled reports 503 control_disabled.
func IsDisabled(err error) bool {
	e, ok := asError(err)
	return ok && e.Status == http.StatusServiceUnavailable && e.Code == "control_disabled"
}
