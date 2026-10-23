package apps

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
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
	case json.Valid(b) && bytes.HasPrefix(bytes.TrimSpace(b), []byte("{")):
		return "json"
	}
	return "ts"
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

// checkPath rejects absolute paths, backslashes, and any path that escapes the bundle root.
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
	var total uint64
	for _, zf := range zr.File {
		if zf.FileInfo().IsDir() {
			continue
		}
		if err := checkPath(zf.Name); err != nil {
			return Files{}, err
		}
		total += zf.UncompressedSize64
		if total > maxBundleBytes {
			return Files{}, fmt.Errorf("apps: archive exceeds %d bytes: %w", maxBundleBytes, apperr.ErrInvalid)
		}
		rc, err := zf.Open()
		if err != nil {
			return Files{}, fmt.Errorf("apps: zip open %s: %w", zf.Name, apperr.ErrInvalid)
		}
		b, err := io.ReadAll(io.LimitReader(rc, maxBundleBytes+1))
		_ = rc.Close()
		if err != nil {
			return Files{}, fmt.Errorf("apps: zip read %s: %w", zf.Name, apperr.ErrInvalid)
		}
		files[zf.Name] = string(b)
	}
	return archiveFiles(files)
}

func unpackTar(body []byte) (Files, error) {
	tr := tar.NewReader(bytes.NewReader(body))
	files := map[string]string{}
	var total int64
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
		total += hdr.Size
		if total > maxBundleBytes {
			return Files{}, fmt.Errorf("apps: archive exceeds %d bytes: %w", maxBundleBytes, apperr.ErrInvalid)
		}
		b, err := io.ReadAll(io.LimitReader(tr, maxBundleBytes+1))
		if err != nil {
			return Files{}, fmt.Errorf("apps: tar read %s: %w", hdr.Name, apperr.ErrInvalid)
		}
		files[hdr.Name] = string(b)
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
