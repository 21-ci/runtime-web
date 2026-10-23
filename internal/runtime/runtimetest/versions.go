package runtimetest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/21cloud/runtime-web/internal/runtime"
)

const maxSourceBytes = 64 << 20

// version keeps the uploaded bytes exactly as sent, with their content type.
type version struct {
	num        int
	body       []byte
	ctype      string
	digest     string
	lockDigest *string
	state      string // pending | building | ready | failed
	failure    *runtime.VersionFailure
	createdAt  int64
}

func (v *version) view() runtime.Version {
	return runtime.Version{
		Version: v.num, SourceDigest: v.digest, LockDigest: v.lockDigest,
		BuildState: v.state, Failure: v.failure, CreatedAt: v.createdAt,
	}
}

func (v *version) markReady() {
	v.state = "ready"
	d := v.digest
	v.lockDigest = &d
}

func (s *service) markFailed(v *version, diagnostics json.RawMessage) {
	v.state = "failed"
	v.failure = &runtime.VersionFailure{Reason: "syntax", Message: "build failed", Diagnostics: diagnostics}
}

// settle finishes a version left "building" by a rebuild: it fails when the
// service is armed, otherwise it becomes ready. Other states are untouched.
func (s *service) settle(v *version) {
	if v.state != "building" {
		return
	}
	if s.failArmed {
		s.failArmed = false
		s.markFailed(v, s.failDiag)
		return
	}
	v.markReady()
}

// makeLive points the service at version n and records a deploy.
func (s *service) makeLive(n int) {
	s.liveVersion = &n
	s.etag++
	s.addEvent("deploy", map[string]any{"version": n})
}

// FailBuild fails every pending or building version of svc with diagnostics
// (raw JSON, as in a version's failure.diagnostics) and arms the service so
// the next upload fails too. An unknown service is ignored.
func (f *Fake) FailBuild(svc string, diagnostics json.RawMessage) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.services[svc]
	if s == nil {
		return
	}
	s.failArmed = true
	s.failDiag = diagnostics
	for _, v := range s.versions {
		if v.state == "pending" || v.state == "building" {
			s.markFailed(v, diagnostics)
		}
	}
}

// CompleteBuild marks version v of svc ready, as a finished lazy build would.
// Versions that are not pending or building are left alone; an unknown service
// or version is ignored.
func (f *Fake) CompleteBuild(svc string, v int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.services[svc]
	if s == nil || v < 1 || v > len(s.versions) {
		return
	}
	if ver := s.versions[v-1]; ver.state == "pending" || ver.state == "building" {
		ver.markReady()
	}
}

func (f *Fake) versionRoutes(mux *http.ServeMux) {
	f.route(mux, "POST /v1/services/{s}/versions", "deploy", f.uploadVersion)
	f.route(mux, "GET /v1/services/{s}/versions", "services:read", f.listVersions)
	f.route(mux, "GET /v1/services/{s}/versions/{v}", "services:read", f.getVersion)
	f.route(mux, "GET /v1/services/{s}/versions/{v}/source", "services:read", f.versionSource)
	f.route(mux, "GET /v1/services/{s}/versions/{v}/build/logs", "logs:read", f.buildLogs)
	f.route(mux, "POST /v1/services/{s}/versions/{v}/rebuild", "deploy", f.rebuildVersion)
	f.route(mux, "PUT /v1/services/{s}/live", "deploy", f.setLive)
}

// findVersion resolves version number n of s.
func findVersion(s *service, n int) (*version, *apiError) {
	if n < 1 || n > len(s.versions) {
		return nil, notFound()
	}
	return s.versions[n-1], nil
}

func pathVersion(r *http.Request) (int, *apiError) {
	n, err := strconv.Atoi(r.PathValue("v"))
	if err != nil {
		return 0, invalid("version must be an integer")
	}
	return n, nil
}

// uploadVersion stores the source. Lazy uploads stay pending until built; eager
// uploads are built at once. An armed service fails the upload and disarms.
func (f *Fake) uploadVersion(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	q := r.URL.Query()
	eager := false
	switch q.Get("compile") {
	case "", "lazy":
	case "eager":
		eager = true
	default:
		return invalid("compile must be lazy or eager")
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxSourceBytes+1))
	if err != nil {
		return invalid("read body: %v", err)
	}
	if len(body) > maxSourceBytes {
		return &apiError{status: http.StatusRequestEntityTooLarge, code: "too_large", msg: "source exceeds 64 MB"}
	}
	sum := sha256.Sum256(body)
	v := &version{
		num: len(s.versions) + 1, body: body, ctype: r.Header.Get("Content-Type"),
		digest: "sha256:" + hex.EncodeToString(sum[:]), state: "pending", createdAt: nowMS(),
	}
	switch {
	case s.failArmed:
		s.failArmed = false
		s.markFailed(v, s.failDiag)
	case eager:
		v.markReady()
	}
	s.versions = append(s.versions, v)
	if truthy(q.Get("activate")) && v.state != "failed" {
		s.makeLive(v.num)
	}
	status := http.StatusCreated
	if eager {
		status = http.StatusAccepted
	}
	writeJSON(w, status, v.view())
	return nil
}

func (f *Fake) listVersions(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	items := []runtime.Version{}
	for _, v := range s.versions {
		s.settle(v)
		items = append(items, v.view())
	}
	writeJSON(w, http.StatusOK, items)
	return nil
}

func (f *Fake) getVersion(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	n, e := pathVersion(r)
	if e != nil {
		return e
	}
	v, e := findVersion(s, n)
	if e != nil {
		return e
	}
	s.settle(v)
	writeJSON(w, http.StatusOK, v.view())
	return nil
}

func (f *Fake) versionSource(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	n, e := pathVersion(r)
	if e != nil {
		return e
	}
	v, e := findVersion(s, n)
	if e != nil {
		return e
	}
	if v.ctype != "" {
		w.Header().Set("Content-Type", v.ctype)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(v.body)
	return nil
}

// buildLogs replays a short build log as SSE and ends the stream.
func (f *Fake) buildLogs(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	n, e := pathVersion(r)
	if e != nil {
		return e
	}
	v, e := findVersion(s, n)
	if e != nil {
		return e
	}
	s.settle(v)
	lines := []string{"resolving dependencies", "compiling version " + strconv.Itoa(v.num), "build " + v.state}
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	for i, line := range lines {
		data, _ := json.Marshal(map[string]any{"seq": i + 1, "level": "info", "msg": line})
		_, _ = fmt.Fprintf(w, "id: %d\nevent: log\ndata: %s\n\n", i+1, data)
	}
	return nil
}

// rebuildVersion clears a failed build; the new build settles on the next read.
func (f *Fake) rebuildVersion(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	n, e := pathVersion(r)
	if e != nil {
		return e
	}
	v, e := findVersion(s, n)
	if e != nil {
		return e
	}
	if v.state == "failed" {
		v.state = "building"
		v.failure = nil
	}
	writeJSON(w, http.StatusAccepted, v.view())
	return nil
}

// setLive points the service at a version; a failed build cannot go live.
func (f *Fake) setLive(p principal, w http.ResponseWriter, r *http.Request) *apiError {
	s, e := f.serviceFor(p, r.PathValue("s"))
	if e != nil {
		return e
	}
	if e := s.checkIfMatch(r); e != nil {
		return e
	}
	var in runtime.SetLiveBody
	if e := decode(r, &in); e != nil {
		return e
	}
	v, e := findVersion(s, in.Version)
	if e != nil {
		return e
	}
	s.settle(v)
	if v.state == "failed" {
		return conflict("version_not_ready", "version failed to build")
	}
	s.makeLive(v.num)
	writeService(w, http.StatusOK, s)
	return nil
}
