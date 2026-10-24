package apps

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/21cloud/runtime-web/internal/apperr"
	"github.com/21cloud/runtime-web/internal/authz"
	"github.com/21cloud/runtime-web/internal/runtime"
)

// buildTimeout bounds how long Save waits for an eager build; pollInterval paces the checks. Vars so
// tests can shorten them.
var (
	buildTimeout = 60 * time.Second
	pollInterval = 200 * time.Millisecond
)

// LogLine is one runtime log record as the web API sends it (build logs and the live log stream;
// the runtime service_id is dropped).
type LogLine struct {
	Seq       int     `json:"seq"`
	TS        int64   `json:"ts"`
	Level     string  `json:"level"`
	Version   *int64  `json:"version"`
	TaskID    *string `json:"task_id"`
	Trigger   *string `json:"trigger"`
	Kind      string  `json:"kind"`
	Msg       string  `json:"msg"`
	Truncated bool    `json:"truncated"`
	// Fields are the structured fields of a std:log record; absent on plain records.
	Fields json.RawMessage `json:"fields,omitempty"`
}

// Files returns the source of version (0 = live). Wasm comes back read-only with no files.
func (s *Service) Files(ctx context.Context, sub authz.Subject, orgID, slug string, version int) (Files, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppRead)
	if err != nil {
		return Files{}, err
	}
	if version == 0 {
		svc, _, err := cli.GetService(ctx, app.SvcID)
		if err != nil {
			return Files{}, mapErr("get app "+slug, err)
		}
		if svc.LiveVersion == nil {
			return Files{}, fmt.Errorf("apps: %s has no live version: %w", slug, apperr.ErrNotFound)
		}
		version = *svc.LiveVersion
	}
	body, ctype, err := cli.VersionSource(ctx, app.SvcID, version)
	if err != nil {
		return Files{}, mapErr(fmt.Sprintf("source of %s v%d", slug, version), err)
	}
	return Unpack(body, ctype)
}

// Save uploads files as a new version, built eagerly and not activated. It waits for the build,
// records the saving user, then sets the version live under etag. A failed build is never
// activated: it returns ErrInvalid carrying build_failed details.
func (s *Service) Save(ctx context.Context, sub authz.Subject, orgID, slug string, files Files, etag string) (Version, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppDeploy)
	if err != nil {
		return Version{}, err
	}
	if etag == "" {
		return Version{}, fmt.Errorf("apps: save %s: %w", slug, apperr.ErrPreconditionRequired)
	}
	if files.ReadOnly || files.Kind == "wasm" {
		return Version{}, fmt.Errorf("apps: save %s: wasm source is read-only: %w", slug, apperr.ErrInvalid)
	}
	if files, err = checkBundle(files); err != nil {
		return Version{}, err
	}
	body, err := json.Marshal(bundleBody{Entry: files.Entry, Files: files.Files})
	if err != nil {
		return Version{}, fmt.Errorf("apps: marshal source of %s: %w", slug, err)
	}
	up, err := cli.UploadVersion(ctx, app.SvcID, bytes.NewReader(body), "application/json", runtime.UploadOpts{Compile: "eager"})
	if err != nil {
		return Version{}, mapErr("save "+slug, err)
	}
	up, err = s.awaitBuild(ctx, cli, app.SvcID, up)
	if err != nil {
		return Version{}, err
	}
	if up.BuildState == "failed" {
		return Version{}, buildFailed(up)
	}
	if err := s.recordAuthor(ctx, orgID, app.SvcID, up.Version, sub.UserID); err != nil {
		return Version{}, err
	}
	svc, err := cli.SetLive(ctx, app.SvcID, up.Version, etag)
	if err != nil {
		return Version{}, mapErr("set live "+slug, err)
	}
	v := viewVersion(up, up.Version, nil)
	v.ETag = svc.ETag
	return v, nil
}

// Promote makes version v live under etag. Only ready versions can go live (version_not_ready).
func (s *Service) Promote(ctx context.Context, sub authz.Subject, orgID, slug string, v int, etag string) (Version, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppDeploy)
	if err != nil {
		return Version{}, err
	}
	if etag == "" {
		return Version{}, fmt.Errorf("apps: promote %s: %w", slug, apperr.ErrPreconditionRequired)
	}
	svc, err := cli.SetLive(ctx, app.SvcID, v, etag)
	if err != nil {
		return Version{}, mapErr(fmt.Sprintf("promote %s v%d", slug, v), err)
	}
	return Version{Version: v, BuildState: "ready", Live: true, ETag: svc.ETag}, nil
}

// Rebuild starts a new build of version v (app.deploy). The result is in state building.
func (s *Service) Rebuild(ctx context.Context, sub authz.Subject, orgID, slug string, v int) (Version, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppDeploy)
	if err != nil {
		return Version{}, err
	}
	rv, err := cli.Rebuild(ctx, app.SvcID, v)
	if err != nil {
		return Version{}, mapErr(fmt.Sprintf("rebuild %s v%d", slug, v), err)
	}
	return viewVersion(rv, 0, nil), nil
}

// BuildLogs collects the build log of version v. The stream ends when the build settles.
func (s *Service) BuildLogs(ctx context.Context, sub authz.Subject, orgID, slug string, v int) ([]LogLine, error) {
	app, cli, err := s.app(ctx, sub, orgID, slug, authz.AppRead)
	if err != nil {
		return nil, err
	}
	rc, err := cli.BuildLogs(ctx, app.SvcID, v)
	if err != nil {
		return nil, mapErr(fmt.Sprintf("build logs %s v%d", slug, v), err)
	}
	defer rc.Close()
	return parseLogs(rc)
}

// awaitBuild polls a pending or building version until it is ready or failed.
func (s *Service) awaitBuild(ctx context.Context, cli *runtime.Scoped, svcID string, v runtime.Version) (runtime.Version, error) {
	if v.BuildState != "pending" && v.BuildState != "building" {
		return v, nil
	}
	timeout := time.NewTimer(buildTimeout)
	defer timeout.Stop()
	tick := time.NewTicker(pollInterval)
	defer tick.Stop()
	for v.BuildState == "pending" || v.BuildState == "building" {
		select {
		case <-ctx.Done():
			return v, ctx.Err()
		case <-timeout.C:
			// 409: the build is still running, so the caller retries later.
			return v, fmt.Errorf("apps: build of v%d did not finish: %w", v.Version, apperr.Conflict{Code: "build_timeout"})
		case <-tick.C:
		}
		next, err := cli.GetVersion(ctx, svcID, v.Version)
		if err != nil {
			return v, mapErr(fmt.Sprintf("get v%d", v.Version), err)
		}
		v = next
	}
	return v, nil
}

// buildFailed is ErrInvalid with details {version, diagnostics} for the editor.
func buildFailed(v runtime.Version) error {
	msg := "build failed"
	var diag json.RawMessage
	if v.Failure != nil {
		if v.Failure.Message != "" {
			msg = v.Failure.Message
		}
		diag = v.Failure.Diagnostics
	}
	details, err := json.Marshal(struct {
		Version     int             `json:"version"`
		Diagnostics json.RawMessage `json:"diagnostics,omitempty"`
	}{v.Version, diag})
	if err != nil {
		return fmt.Errorf("apps: marshal build details: %w", err)
	}
	return fmt.Errorf("apps: build of v%d failed: %w", v.Version, Invalid{Err: &runtime.Error{
		Status: 422, Code: "build_failed", Message: msg, Details: details,
	}})
}

// parseLogs reads SSE "data:" lines as LogLine JSON.
func parseLogs(r io.Reader) ([]LogLine, error) {
	out := []LogLine{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		data, ok := strings.CutPrefix(sc.Text(), "data:")
		if !ok {
			continue
		}
		var l LogLine
		if err := json.Unmarshal([]byte(strings.TrimSpace(data)), &l); err != nil {
			return nil, fmt.Errorf("apps: build log line: %w", err)
		}
		out = append(out, l)
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("apps: read build logs: %w", err)
	}
	return out, nil
}
