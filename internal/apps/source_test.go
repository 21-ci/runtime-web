package apps

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/flate"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io/fs"
	"reflect"
	"strings"
	"testing"

	"github.com/21cloud/runtime-web/internal/apperr"
)

func zipOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatalf("zip write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func tarOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatalf("tar header %s: %v", name, err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatalf("tar write %s: %v", name, err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	return buf.Bytes()
}

func TestFilesUnpackTS(t *testing.T) {
	got, err := Unpack([]byte("export default {};"), "application/typescript")
	if err != nil {
		t.Fatalf("Unpack: %v", err)
	}
	want := Files{Entry: "main.ts", Files: map[string]string{"main.ts": "export default {};"}, Kind: "ts"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestFilesUnpackJS(t *testing.T) {
	got, err := Unpack([]byte("export default {};"), "text/javascript")
	if err != nil {
		t.Fatalf("Unpack: %v", err)
	}
	if got.Kind != "js" || got.Entry != "main.js" || got.Files["main.js"] != "export default {};" {
		t.Fatalf("got %+v", got)
	}
}

func TestFilesUnpackJSON(t *testing.T) {
	body := `{"entry":"src/app.ts","files":{"src/app.ts":"x","lib/u.ts":"y"}}`
	got, err := Unpack([]byte(body), "application/json")
	if err != nil {
		t.Fatalf("Unpack: %v", err)
	}
	want := Files{Entry: "src/app.ts", Files: map[string]string{"src/app.ts": "x", "lib/u.ts": "y"}, Kind: "bundle"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestFilesUnpackZip(t *testing.T) {
	z := zipOf(t, map[string]string{"main.ts": "a", "lib/u.ts": "b"})
	for _, ctype := range []string{"application/zip", "application/octet-stream", ""} {
		got, err := Unpack(z, ctype)
		if err != nil {
			t.Fatalf("Unpack(%q): %v", ctype, err)
		}
		if got.Kind != "bundle" || got.Entry != "main.ts" || got.Files["lib/u.ts"] != "b" || len(got.Files) != 2 {
			t.Fatalf("ctype %q: got %+v", ctype, got)
		}
	}
}

func TestFilesUnpackTar(t *testing.T) {
	tb := tarOf(t, map[string]string{"main.js": "a", "util.js": "b"})
	got, err := Unpack(tb, "application/x-tar")
	if err != nil {
		t.Fatalf("Unpack: %v", err)
	}
	if got.Kind != "bundle" || got.Entry != "main.js" || got.Files["util.js"] != "b" {
		t.Fatalf("got %+v", got)
	}
}

func TestFilesUnpackRejectsTraversal(t *testing.T) {
	cases := map[string][]byte{
		"zip-dotdot":  zipOf(t, map[string]string{"main.ts": "a", "../evil.ts": "x"}),
		"tar-dotdot":  tarOf(t, map[string]string{"main.ts": "a", "../evil.ts": "x"}),
		"json-dotdot": []byte(`{"entry":"main.ts","files":{"main.ts":"a","../evil.ts":"x"}}`),
		"json-abs":    []byte(`{"entry":"main.ts","files":{"main.ts":"a","/etc/passwd":"x"}}`),
	}
	ctypes := map[string]string{"zip-dotdot": "application/zip", "tar-dotdot": "application/x-tar", "json-dotdot": "application/json", "json-abs": "application/json"}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Unpack(body, ctypes[name])
			if !errors.Is(err, apperr.ErrInvalid) {
				t.Fatalf("err = %v, want ErrInvalid", err)
			}
		})
	}
}

func TestFilesUnpackRejectsMissingEntry(t *testing.T) {
	_, err := Unpack([]byte(`{"entry":"nope.ts","files":{"main.ts":"a"}}`), "application/json")
	if !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
}

func TestFilesUnpackSizeCap(t *testing.T) {
	big := strings.Repeat("a", maxBundleBytes+1)
	_, err := Unpack([]byte(big), "application/typescript")
	if !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
	_, err = Unpack(zipOf(t, map[string]string{"main.ts": big}), "application/zip")
	if !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("zip err = %v, want ErrInvalid", err)
	}
}

func TestFilesWasmReadOnly(t *testing.T) {
	wasm := []byte("\x00asm\x01\x00\x00\x00")
	got, err := Unpack(wasm, "application/wasm")
	if err != nil {
		t.Fatalf("Unpack: %v", err)
	}
	if !got.ReadOnly || got.Kind != "wasm" || len(got.Files) != 0 {
		t.Fatalf("got %+v, want read-only wasm without files", got)
	}
	got, err = Unpack(wasm, "")
	if err != nil || got.Kind != "wasm" {
		t.Fatalf("sniffed wasm: got %+v, err %v", got, err)
	}
}

func TestBundleJSONRoundTrip(t *testing.T) {
	b, err := json.Marshal(bundleBody{Entry: "main.ts", Files: map[string]string{"main.ts": "a"}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got, err := Unpack(b, "application/json")
	if err != nil || got.Entry != "main.ts" {
		t.Fatalf("got %+v, err %v", got, err)
	}
}

// lyingZip stores n deflated copies of payload with headers that claim 1 byte each.
func lyingZip(t *testing.T, n int, payload []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for i := 0; i < n; i++ {
		var comp bytes.Buffer
		fw, err := flate.NewWriter(&comp, flate.BestSpeed)
		if err != nil {
			t.Fatalf("flate: %v", err)
		}
		if _, err := fw.Write(payload); err != nil {
			t.Fatalf("flate write: %v", err)
		}
		if err := fw.Close(); err != nil {
			t.Fatalf("flate close: %v", err)
		}
		name := fmt.Sprintf("f%02d.ts", i)
		if i == 0 {
			name = "main.ts"
		}
		w, err := zw.CreateRaw(&zip.FileHeader{Name: name, Method: zip.Deflate, CompressedSize64: uint64(comp.Len()),
			UncompressedSize64: 1, CRC32: crc32.ChecksumIEEE(payload)})
		if err != nil {
			t.Fatalf("CreateRaw: %v", err)
		}
		if _, err := w.Write(comp.Bytes()); err != nil {
			t.Fatalf("raw write: %v", err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func TestFilesUnpackZipLyingHeadersCapped(t *testing.T) {
	// 12 MB of real data behind headers that claim 12 bytes: the real count must reject it.
	payload := bytes.Repeat([]byte("a"), 1<<20)
	_, err := Unpack(lyingZip(t, 12, payload), "application/zip")
	if !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
}

func TestFilesUnpackZipHonestOverBudget(t *testing.T) {
	payload := bytes.Repeat([]byte("a"), 1<<20)
	z := zipOf(t, map[string]string{"main.ts": string(payload), "b.ts": string(payload), "c.ts": string(payload),
		"d.ts": string(payload), "e.ts": string(payload), "f.ts": string(payload), "g.ts": string(payload),
		"h.ts": string(payload), "i.ts": string(payload), "j.ts": string(payload), "k.ts": string(payload)})
	_, err := Unpack(z, "application/zip")
	if !errors.Is(err, apperr.ErrInvalid) || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("err = %v, want exceeds ErrInvalid", err)
	}
}

func TestFilesUnpackRejectsZipSymlink(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("main.ts")
	_, _ = w.Write([]byte("export {};"))
	fh := &zip.FileHeader{Name: "link.ts", Method: zip.Store}
	fh.SetMode(fs.ModeSymlink | 0o777)
	lw, err := zw.CreateHeader(fh)
	if err != nil {
		t.Fatalf("CreateHeader: %v", err)
	}
	_, _ = lw.Write([]byte("/etc/passwd"))
	if err := zw.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	_, err = Unpack(buf.Bytes(), "application/zip")
	if !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
}

func TestFilesUnpackRejectsDuplicateNames(t *testing.T) {
	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	for _, body := range []string{"one", "two"} {
		w, _ := zw.Create("main.ts")
		_, _ = w.Write([]byte(body))
	}
	_ = zw.Close()
	_, err := Unpack(zb.Bytes(), "application/zip")
	if !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("zip err = %v, want ErrInvalid", err)
	}

	var tb bytes.Buffer
	tw := tar.NewWriter(&tb)
	for _, body := range []string{"one", "two"} {
		_ = tw.WriteHeader(&tar.Header{Name: "main.ts", Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte(body))
	}
	_ = tw.Close()
	_, err = Unpack(tb.Bytes(), "application/x-tar")
	if !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("tar err = %v, want ErrInvalid", err)
	}
}

func TestFilesUnpackRejectsDotSlashNames(t *testing.T) {
	_, err := Unpack(zipOf(t, map[string]string{"./main.ts": "a"}), "application/zip")
	if !errors.Is(err, apperr.ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
}

func TestJSONSniffNeedsEntry(t *testing.T) {
	// No content type and no "entry" key: this is TypeScript source, not a bundle.
	got, err := Unpack([]byte(`{"files":{"main.ts":"x"}}`), "")
	if err != nil {
		t.Fatalf("Unpack: %v", err)
	}
	if got.Kind != "ts" || got.Entry != "main.ts" {
		t.Fatalf("got %+v, want ts", got)
	}
}
