package apps

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/21cloud/runtime-web/internal/apperr"
)

// maxBundleBytes bounds an app's source: the upload body and the unpacked total.
const maxBundleBytes = 10 << 20

// Files is an app's source as the editor sees it. Kind is "ts" | "js" | "bundle" | "wasm".
// Wasm is read-only and carries no files.
type Files struct {
	Entry    string            `json:"entry"`
	Files    map[string]string `json:"files"`
	ReadOnly bool              `json:"read_only"`
	Kind     string            `json:"kind"`
}

// bundleBody is the runtime's application/json upload format.
type bundleBody struct {
	Entry string            `json:"entry"`
	Files map[string]string `json:"files"`
}

// Unpack turns uploaded source bytes into Files. The content type is trusted first; magic bytes
// decide when it is generic or missing. Bundles (json, zip, tar) are checked for traversal and
// size.
func Unpack(body []byte, contentType string) (Files, error) {
	if len(body) > maxBundleBytes {
		return Files{}, fmt.Errorf("apps: source exceeds %d bytes: %w", maxBundleBytes, apperr.ErrInvalid)
	}
	kind := kindOf(contentType)
	if kind == "" {
		kind = sniff(body)
	}
	switch kind {
	case "wasm":
		return Files{Kind: "wasm", ReadOnly: true, Files: map[string]string{}}, nil
	case "ts", "js":
		name := "main." + kind
		return Files{Entry: name, Files: map[string]string{name: string(body)}, Kind: kind}, nil
	case "json":
		var b bundleBody
		if err := json.Unmarshal(body, &b); err != nil {
			return Files{}, fmt.Errorf("apps: source json: %w", apperr.ErrInvalid)
		}
		return checkBundle(Files{Entry: b.Entry, Files: b.Files, Kind: "bundle"})
	case "zip":
		return unpackZip(body)
	case "tar":
		return unpackTar(body)
	}
	return Files{}, fmt.Errorf("apps: unknown source format: %w", apperr.ErrInvalid)
}

// kindOf maps a Content-Type to a source kind, or "" when it is not one we know.
func kindOf(contentType string) string {
	mt, _, _ := mime.ParseMediaType(contentType)
	switch mt {
	case "application/typescript", "text/typescript", "text/x-typescript":
		return "ts"
	case "text/javascript", "application/javascript":
		return "js"
	case "application/json":
		return "json"
	case "application/zip":
		return "zip"
	case "application/x-tar":
		return "tar"
	case "application/wasm":
		return "wasm"
	}
	return ""
}

// sniff guesses the kind from magic bytes. Plain text is TypeScript, which also accepts JavaScript.
func sniff(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte("PK\x03\x04")):
		return "zip"
	case bytes.HasPrefix(b, []byte("\x00asm")):
		return "wasm"
	case len(b) >= 262 && string(b[257:262]) == "ustar":
		return "tar"
	case isBundleJSON(b):
		return "json"
	}
	return "ts"
}

// isBundleJSON reports whether b is a JSON object with an "entry" key, the runtime's bundle shape.
func isBundleJSON(b []byte) bool {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		return false
	}
	_, ok := m["entry"]
	return ok
}

// checkBundle validates a json/zip/tar bundle: an entry in files, safe paths, UTF-8 sources.
func checkBundle(f Files) (Files, error) {
	if f.Files == nil {
		f.Files = map[string]string{}
	}
	total := 0
	for name, src := range f.Files {
		if err := checkPath(name); err != nil {
			return Files{}, err
		}
		if !utf8.ValidString(src) {
			return Files{}, fmt.Errorf("apps: file %s is not UTF-8: %w", name, apperr.ErrInvalid)
		}
		total += len(src)
	}
	if total > maxBundleBytes {
		return Files{}, fmt.Errorf("apps: source exceeds %d bytes: %w", maxBundleBytes, apperr.ErrInvalid)
	}
	if _, ok := f.Files[f.Entry]; !ok || f.Entry == "" {
		return Files{}, fmt.Errorf("apps: entry %q is not a file: %w", f.Entry, apperr.ErrInvalid)
	}
	return f, nil
}

// checkPath accepts only clean relative paths. It rejects absolute paths, backslashes, any path that
// escapes the bundle root, and ./-prefixed names (archives must use names like main.ts).
func checkPath(name string) error {
	clean := path.Clean(name)
	if name == "" || path.IsAbs(name) || strings.Contains(name, "\\") ||
		clean == ".." || strings.HasPrefix(clean, "../") || clean != name {
		return fmt.Errorf("apps: file path %q: %w", name, apperr.ErrInvalid)
	}
	return nil
}

// pickEntry chooses the entry of an archive: main.ts or main.js, else the only ts/js file.
func pickEntry(files map[string]string) (string, error) {
	for _, n := range []string{"main.ts", "main.js"} {
		if _, ok := files[n]; ok {
			return n, nil
		}
	}
	return "", fmt.Errorf("apps: archive has no main.ts or main.js: %w", apperr.ErrInvalid)
}

func unpackZip(body []byte) (Files, error) {
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		return Files{}, fmt.Errorf("apps: zip: %w", apperr.ErrInvalid)
	}
	files := map[string]string{}
	var used int64
	for _, zf := range zr.File {
		if zf.FileInfo().IsDir() {
			continue
		}
		if err := checkPath(zf.Name); err != nil {
			return Files{}, err
		}
		if zf.Mode()&fs.ModeType != 0 {
			// Symlinks and devices could point outside the bundle.
			return Files{}, fmt.Errorf("apps: zip entry %q is not a regular file: %w", zf.Name, apperr.ErrInvalid)
		}
		if _, dup := files[zf.Name]; dup {
			return Files{}, fmt.Errorf("apps: zip repeats %q: %w", zf.Name, apperr.ErrInvalid)
		}
		if zf.UncompressedSize64 > maxBundleBytes {
			return Files{}, fmt.Errorf("apps: archive exceeds %d bytes: %w", maxBundleBytes, apperr.ErrInvalid)
		}
		rc, err := zf.Open()
		if err != nil {
			return Files{}, fmt.Errorf("apps: zip open %s: %w", zf.Name, apperr.ErrInvalid)
		}
		src, n, err := readCapped(rc, used, zf.Name)
		_ = rc.Close()
		if err != nil {
			return Files{}, err
		}
		used = n
		files[zf.Name] = src
	}
	return archiveFiles(files)
}

// readCapped reads one archive member and counts its real bytes against the bundle budget. Header
// sizes can lie, so the count comes from what is actually read.
func readCapped(r io.Reader, used int64, name string) (string, int64, error) {
	left := maxBundleBytes - used
	b, err := io.ReadAll(io.LimitReader(r, left+1))
	if err != nil {
		return "", 0, fmt.Errorf("apps: read %s: %w", name, apperr.ErrInvalid)
	}
	if int64(len(b)) > left {
		return "", 0, fmt.Errorf("apps: archive exceeds %d bytes: %w", maxBundleBytes, apperr.ErrInvalid)
	}
	return string(b), used + int64(len(b)), nil
}

func unpackTar(body []byte) (Files, error) {
	tr := tar.NewReader(bytes.NewReader(body))
	files := map[string]string{}
	var used int64
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return Files{}, fmt.Errorf("apps: tar: %w", apperr.ErrInvalid)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			continue
		case tar.TypeReg:
		default:
			// Links and devices could point outside the bundle.
			return Files{}, fmt.Errorf("apps: tar entry %q is not a regular file: %w", hdr.Name, apperr.ErrInvalid)
		}
		if err := checkPath(hdr.Name); err != nil {
			return Files{}, err
		}
		if _, dup := files[hdr.Name]; dup {
			return Files{}, fmt.Errorf("apps: tar repeats %q: %w", hdr.Name, apperr.ErrInvalid)
		}
		if hdr.Size > maxBundleBytes {
			return Files{}, fmt.Errorf("apps: archive exceeds %d bytes: %w", maxBundleBytes, apperr.ErrInvalid)
		}
		src, n, err := readCapped(tr, used, hdr.Name)
		if err != nil {
			return Files{}, err
		}
		used = n
		files[hdr.Name] = src
	}
	return archiveFiles(files)
}

func archiveFiles(files map[string]string) (Files, error) {
	entry, err := pickEntry(files)
	if err != nil {
		return Files{}, err
	}
	return checkBundle(Files{Entry: entry, Files: files, Kind: "bundle"})
}
