package main

// bootstrap is server/scripts/install.mjs for the container, run on every start against the local node: the
// same steps, names and idempotency (it never rotates RTWEB_SEAL_KEY, never reissues RTWEB_SETUP_TOKEN, and only
// uploads a version when the bundle digest changed). Keep the two in step.
//
// The image's build stage already ran gen-assets, so the share directory holds server/src (with src/gen),
// server/rt.json, server/sdk/rtctl/mod.ts and blobs.json (paths relative to the share directory).

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

type api struct {
	ctx   context.Context
	token string
	hc    *http.Client
}

func (a *api) do(method, p string, body any, tenant string, okCodes ...int) (int, []byte, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(a.ctx, method, "http://"+rtControl+p, rd)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	if tenant != "" {
		req.Header.Set("x-rt-tenant", tenant)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := a.hc.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if res.StatusCode >= 300 && !slices.Contains(okCodes, res.StatusCode) {
		return res.StatusCode, data, fmt.Errorf("%s %s -> %d %s", method, p, res.StatusCode, trunc(data, 500))
	}
	return res.StatusCode, data, nil
}

func (a *api) get(p, tenant string, out any) error {
	_, data, err := a.do("GET", p, nil, tenant)
	if err != nil {
		return err
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}

func trunc(b []byte, n int) string {
	if len(b) > n {
		b = b[:n]
	}
	return string(b)
}

func step(n int, f string, a ...any) { log.Printf("[%d] %s", n, fmt.Sprintf(f, a...)) }

func bootstrap(ctx context.Context, c *config, s *secrets) error {
	a := &api{ctx: ctx, token: s.rootToken, hc: &http.Client{Timeout: 120 * time.Second}}

	// 1. node config: plan + bindings (the generated rt.toml carries both).
	var plans []struct {
		Name     string `json:"name"`
		Settings struct {
			AllowedTriggers []string `json:"allowed_triggers"`
		} `json:"settings"`
	}
	if err := a.get("/v1/plans", "", &plans); err != nil {
		return err
	}
	plan, cron := "", false
	for _, p := range plans {
		if p.Name == c.plan {
			plan, cron = p.Name, slices.Contains(p.Settings.AllowedTriggers, "cron")
		}
	}
	if plan == "" {
		return fmt.Errorf("node has no plan %q: the generated rt.toml was not loaded", c.plan)
	}
	step(1, "node config ok (plan %s)", plan)

	tenant, err := ensureTenant(a, c.tenant, plan)
	if err != nil {
		return err
	}
	if err := ensureSdk(a, c, tenant); err != nil {
		return err
	}
	svcID, assetToken, err := ensureService(a, c, s, tenant, cron)
	if err != nil {
		return err
	}
	oldEnv, err := setEnv(a, c, tenant, svcID, nil)
	if err != nil {
		return err
	}
	digest, err := deployBundle(a, c, tenant, svcID, oldEnv)
	if err != nil {
		return err
	}
	if _, err := setEnv(a, c, tenant, svcID, map[string]string{"RTWEB_BUNDLE": digest}); err != nil {
		return err
	}
	upErr := uploadBlobs(ctx, c, assetToken)
	// The upload token must not outlive this run: whoever holds it could replace console assets.
	if _, _, err := a.do("DELETE", "/v1/services/"+svcID+"/secrets/RTWEB_ASSET_TOKEN", nil, tenant, 404); err != nil {
		return err
	}
	step(6, "deleted secret RTWEB_ASSET_TOKEN")
	if upErr != nil {
		return upErr
	}
	host := hostOnly(c.consoleURL.Host)
	if _, _, err := a.do("PUT", "/v1/services/"+svcID+"/hosts/"+url.PathEscape(host), nil, tenant); err != nil {
		return err
	}
	step(7, "mapped host %s -> %s", host, c.slug)
	return smoke(ctx, c)
}

func ensureTenant(a *api, name, plan string) (string, error) {
	cursor := ""
	for {
		var page struct {
			Items []struct {
				ID, Name, Plan string
			} `json:"items"`
			Next string `json:"next_cursor"`
		}
		q := "/v1/tenants?limit=100"
		if cursor != "" {
			q += "&cursor=" + url.QueryEscape(cursor)
		}
		if err := a.get(q, "", &page); err != nil {
			return "", err
		}
		for _, t := range page.Items {
			if t.Name == name {
				step(3, "tenant %s exists (%s, plan %s)", name, t.ID, t.Plan)
				if t.Plan != plan {
					if _, _, err := a.do("PATCH", "/v1/tenants/"+t.ID, map[string]string{"plan": plan}, ""); err != nil {
						return "", err
					}
					step(3, "tenant %s moved to plan %s", t.ID, plan)
				}
				return t.ID, nil
			}
		}
		if page.Next == "" {
			break
		}
		cursor = page.Next
	}
	_, data, err := a.do("POST", "/v1/tenants", map[string]string{"name": name, "plan": plan}, "")
	if err != nil {
		return "", err
	}
	var t struct{ ID string }
	if err := json.Unmarshal(data, &t); err != nil {
		return "", err
	}
	step(3, "created tenant %s (%s)", name, t.ID)
	return t.ID, nil
}

func ensureSdk(a *api, c *config, tenant string) error {
	src, err := os.ReadFile(filepath.Join(c.shareDir, "server", "sdk", "rtctl", "mod.ts"))
	if err != nil {
		return err
	}
	// Bake the caller tenant into the SDK: only tenant runtime-web may call it (mod.ts BAKED_TENANT).
	baked := strings.ReplaceAll(string(src), "__RTWEB_TENANT_ID__", tenant)
	code, _, err := a.do("POST", "/v1/sdks", map[string]string{
		"name": "rtctl", "version": c.sdkVersion, "source": base64.StdEncoding.EncodeToString([]byte(baked)), "description": "Runtime Web control API",
	}, "", 409)
	if err != nil {
		return err
	}
	if code == 409 {
		step(4, "sdk rtctl %s already published", c.sdkVersion)
	} else {
		step(4, "published sdk rtctl %s", c.sdkVersion)
	}
	if _, _, err := a.do("PUT", "/v1/sdks/rtctl/channels/stable", map[string]string{"version": c.sdkVersion}, ""); err != nil {
		return err
	}
	if _, _, err := a.do("PUT", "/v1/sdk-grants", map[string]string{"scope": "tenant:" + tenant, "sdk": "rtctl", "effect": "allow"}, ""); err != nil {
		return err
	}
	if _, _, err := a.do("PUT", "/v1/sdk-grants", map[string]string{"scope": "node", "sdk": "rtctl"}, "", 204); err != nil {
		return err
	}
	step(4, "sdk grants: allow tenant:%s only", tenant)
	return nil
}

func ensureService(a *api, c *config, s *secrets, tenant string, cron bool) (string, string, error) {
	var page struct {
		Items []struct{ ID string } `json:"items"`
	}
	if err := a.get("/v1/services?slug="+url.QueryEscape(c.slug), tenant, &page); err != nil {
		return "", "", err
	}
	var id string
	if len(page.Items) > 0 {
		id = page.Items[0].ID
		step(5, "service %s exists (%s)", c.slug, id)
	} else {
		triggers := map[string]bool{"http": true, "cron": cron, "interval": false, "queue": false, "call": false, "websocket": false}
		_, data, err := a.do("POST", "/v1/services", map[string]any{"slug": c.slug, "runtime": "deno", "name": "Runtime Web", "triggers": triggers}, tenant)
		if err != nil {
			return "", "", err
		}
		var svc struct{ ID string }
		if err := json.Unmarshal(data, &svc); err != nil {
			return "", "", err
		}
		id = svc.ID
		step(5, "created service %s (%s)", c.slug, id)
	}
	if !cron {
		log.Printf("plan lacks the cron trigger: the housekeeping schedule is not created")
	} else {
		var raw json.RawMessage
		if err := a.get("/v1/services/"+id+"/schedules", tenant, &raw); err != nil {
			return "", "", err
		}
		type sched struct {
			Kind    string `json:"kind"`
			Payload struct {
				Job string `json:"job"`
			} `json:"payload"`
		}
		var list []sched
		if json.Unmarshal(raw, &list) != nil {
			var wrapped struct{ Items []sched }
			_ = json.Unmarshal(raw, &wrapped)
			list = wrapped.Items
		}
		if !slices.ContainsFunc(list, func(x sched) bool { return x.Kind == "cron" && x.Payload.Job == "housekeeping" }) {
			if _, _, err := a.do("POST", "/v1/services/"+id+"/schedules", map[string]any{
				"kind": "cron", "cron": "*/5 * * * *", "timezone": "UTC", "payload": map[string]string{"job": "housekeeping"},
			}, tenant); err != nil {
				return "", "", err
			}
			step(5, "created schedule housekeeping (*/5 * * * *)")
		}
	}
	var have []struct{ Name string }
	if err := a.get("/v1/services/"+id+"/secrets", tenant, &have); err != nil {
		return "", "", err
	}
	has := func(n string) bool {
		return slices.ContainsFunc(have, func(x struct{ Name string }) bool { return x.Name == n })
	}
	put := func(n, v string) error {
		_, _, err := a.do("PUT", "/v1/services/"+id+"/secrets/"+n, map[string]string{"value": v}, tenant)
		return err
	}
	if !has("RTWEB_SEAL_KEY") {
		k := make([]byte, 32)
		_, _ = rand.Read(k)
		if err := put("RTWEB_SEAL_KEY", base64.StdEncoding.EncodeToString(k)); err != nil {
			return "", "", err
		}
		step(5, "set secret RTWEB_SEAL_KEY (new random key)")
	}
	tokenFile := filepath.Join(c.dataDir, "rtweb", "secrets", "setup-token")
	if setupDone(a, c, id, tenant) {
		// The admin exists: the token has done its job. Drop it so it is never reissued or reused.
		if has("RTWEB_SETUP_TOKEN") {
			if _, _, err := a.do("DELETE", "/v1/services/"+id+"/secrets/RTWEB_SETUP_TOKEN", nil, tenant, 404); err != nil {
				return "", "", err
			}
			step(5, "setup is done: deleted secret RTWEB_SETUP_TOKEN")
		}
		_ = os.Remove(tokenFile)
	} else if !has("RTWEB_SETUP_TOKEN") {
		tok := s.setupToken
		if tok == "" {
			tok = randB64URL(24)
		}
		if err := put("RTWEB_SETUP_TOKEN", tok); err != nil {
			return "", "", err
		}
		if s.setupToken == "" {
			if err := os.WriteFile(tokenFile, []byte(tok+"\n"), 0o600); err != nil {
				return "", "", err
			}
			log.Printf("First-run setup: open %s/setup", c.consoleURL)
			log.Printf("Setup token (shown once; also in %s until setup is done): %s", tokenFile, tok)
		}
		step(5, "set secret RTWEB_SETUP_TOKEN (new)")
	}
	assetToken := randB64URL(24)
	if err := put("RTWEB_ASSET_TOKEN", assetToken); err != nil {
		return "", "", err
	}
	return id, assetToken, nil
}

// setupDone is true once a live console says no first-run setup is needed (GET /api/setup -> needed:false).
func setupDone(a *api, c *config, svcID, tenant string) bool {
	var svc struct {
		Live any `json:"live_version"`
	}
	if a.get("/v1/services/"+svcID, tenant, &svc) != nil || svc.Live == nil {
		return false
	}
	req, _ := http.NewRequestWithContext(a.ctx, "GET", "http://"+rtInvoke+"/s/"+c.slug+"/api/setup", nil)
	res, err := a.hc.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var st struct {
		Needed *bool `json:"needed"`
	}
	if res.StatusCode != 200 || json.NewDecoder(res.Body).Decode(&st) != nil || st.Needed == nil {
		return false
	}
	return !*st.Needed
}

func setEnv(a *api, c *config, tenant, svcID string, extra map[string]string) (map[string]string, error) {
	cur := map[string]string{}
	if err := a.get("/v1/services/"+svcID+"/env", tenant, &cur); err != nil {
		return nil, err
	}
	next := map[string]string{}
	for k, v := range cur {
		next[k] = v
	}
	next["RTWEB_ORIGIN"] = c.consoleURL.String()
	next["RTWEB_RUNTIME_PUBLIC_URL"] = c.appsURL.String()
	if c.consoleURL.Scheme == "http" {
		// Plain-http origin (local trial only): cookies cannot carry __Host- / Secure.
		next["RTWEB_INSECURE_COOKIES"] = "1"
	} else {
		delete(next, "RTWEB_INSECURE_COOKIES")
	}
	if c.defaultPlan != "" {
		next["RTWEB_DEFAULT_PLAN"] = c.defaultPlan
	}
	if c.version != "" {
		next["RTWEB_VERSION"] = c.version
	}
	for k, v := range extra {
		next[k] = v
	}
	if !mapsEqual(cur, next) {
		if _, _, err := a.do("PUT", "/v1/services/"+svcID+"/env", next, tenant); err != nil {
			return nil, err
		}
		keys := make([]string, 0, len(next))
		for k := range next {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		step(5, "env set (%s)", strings.Join(keys, ", "))
	}
	return cur, nil
}

func mapsEqual(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if bv, ok := b[k]; !ok || bv != v {
			return false
		}
	}
	return true
}

// collect mirrors install.mjs: every .ts/.js under server/src except .d.ts, keyed by the path relative to server/.
func collect(root string) (map[string]string, error) {
	files := map[string]string{}
	err := filepath.WalkDir(filepath.Join(root, "src"), func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		n := d.Name()
		if (strings.HasSuffix(n, ".ts") || strings.HasSuffix(n, ".js")) && !strings.HasSuffix(n, ".d.ts") {
			b, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel(root, p)
			files[filepath.ToSlash(rel)] = string(b)
		}
		return nil
	})
	return files, err
}

func deployBundle(a *api, c *config, tenant, svcID string, oldEnv map[string]string) (string, error) {
	root := filepath.Join(c.shareDir, "server")
	var rt struct {
		Entry   string            `json:"entry"`
		Imports map[string]string `json:"imports"`
	}
	b, err := os.ReadFile(filepath.Join(root, "rt.json"))
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal(b, &rt); err != nil {
		return "", err
	}
	files, err := collect(root)
	if err != nil {
		return "", err
	}
	keys := make([]string, 0, len(files))
	for k := range files {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	h := sha256.New()
	for _, k := range keys {
		h.Write([]byte(k + "\x00" + files[k] + "\x00"))
	}
	digest := hex.EncodeToString(h.Sum(nil))[:16]
	var svc struct {
		Live any `json:"live_version"`
	}
	if err := a.get("/v1/services/"+svcID, tenant, &svc); err != nil {
		return "", err
	}
	if svc.Live != nil && oldEnv["RTWEB_BUNDLE"] == digest {
		step(6, "bundle %s already live (version %v)", digest, svc.Live)
		return digest, nil
	}
	body := map[string]any{"entry": rt.Entry, "files": files}
	if len(rt.Imports) > 0 {
		body["imports"] = rt.Imports
	}
	_, data, err := a.do("POST", "/v1/services/"+svcID+"/versions?activate=1&compile=eager", body, tenant)
	if err != nil {
		return "", err
	}
	var v map[string]any
	if err := json.Unmarshal(data, &v); err != nil {
		return "", err
	}
	num := v["version"]
	if num == nil {
		num = v["version_no"]
	}
	if num == nil {
		num = v["id"]
	}
	step(6, "uploaded version %v (%d files, bundle %s)", num, len(files), digest)
	for i := 0; ; i++ {
		var st struct {
			BuildState string          `json:"build_state"`
			Failure    json.RawMessage `json:"failure"`
		}
		if err := a.get(fmt.Sprintf("/v1/services/%s/versions/%v", svcID, num), tenant, &st); err != nil {
			return "", err
		}
		if st.BuildState == "ready" {
			break
		}
		if st.BuildState == "failed" {
			return "", fmt.Errorf("build failed: %s", st.Failure)
		}
		if i > 240 {
			return "", errors.New("build did not finish in 120 s")
		}
		time.Sleep(500 * time.Millisecond)
	}
	step(6, "version %v ready and live", num)
	return digest, nil
}

func uploadBlobs(ctx context.Context, c *config, assetToken string) error {
	var blobs []struct {
		Path      string   `json:"path"`
		File      string   `json:"file"`
		Etag      string   `json:"etag"`
		Size      int64    `json:"size"`
		Parts     int      `json:"parts"`
		PartBytes int64    `json:"partBytes"`
		Sha256    []string `json:"sha256"`
	}
	b, err := os.ReadFile(filepath.Join(c.shareDir, "blobs.json"))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, &blobs); err != nil {
		return err
	}
	hc := &http.Client{Timeout: 60 * time.Second}
	for _, bl := range blobs {
		data, err := os.ReadFile(filepath.Join(c.shareDir, bl.File))
		if err != nil {
			return err
		}
		id := strings.ReplaceAll(bl.Etag, `"`, "")
		for i := 0; i < bl.Parts; i++ {
			end := min(int64(i+1)*bl.PartBytes, bl.Size)
			part := data[int64(i)*bl.PartBytes : end]
			sum := sha256.Sum256(part)
			hexSum := hex.EncodeToString(sum[:])
			if i >= len(bl.Sha256) || hexSum != bl.Sha256[i] {
				return fmt.Errorf("asset %s part %d does not match its manifest sha256", bl.Path, i)
			}
			req, _ := http.NewRequestWithContext(ctx, "PUT", fmt.Sprintf("http://%s/s/%s/api/internal/assets/%s/%d", rtInvoke, c.slug, id, i), bytes.NewReader(part))
			req.Header.Set("x-rtweb-asset-token", assetToken)
			req.Header.Set("content-type", "application/octet-stream")
			req.Header.Set("x-rtweb-part-sha256", hexSum)
			res, err := hc.Do(req)
			if err != nil {
				return err
			}
			msg, _ := io.ReadAll(io.LimitReader(res.Body, 300))
			res.Body.Close()
			if res.StatusCode != http.StatusNoContent {
				return fmt.Errorf("asset %s part %d -> %d %s", bl.Path, i, res.StatusCode, msg)
			}
		}
		step(6, "uploaded %s to std:blob (%d parts, %d B)", bl.Path, bl.Parts, bl.Size)
	}
	return nil
}

func smoke(ctx context.Context, c *config) error {
	hc := &http.Client{Timeout: 30 * time.Second}
	get := func(p string) (int, string, error) {
		req, _ := http.NewRequestWithContext(ctx, "GET", "http://"+rtInvoke+"/s/"+c.slug+p, nil)
		res, err := hc.Do(req)
		if err != nil {
			return 0, "", err
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		return res.StatusCode, string(b), nil
	}
	for _, p := range []string{"/api/healthz", "/"} {
		code, body, err := get(p)
		if err != nil {
			return err
		}
		if code != 200 || (p == "/" && !strings.Contains(body, "<base href=")) {
			return fmt.Errorf("smoke GET %s -> %d %s", p, code, trunc([]byte(body), 120))
		}
		step(8, "GET /s/%s%s -> %d ok", c.slug, p, code)
	}
	return nil
}
