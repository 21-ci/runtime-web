package api

import (
	"embed"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// dist is the console build. The placeholder index.html keeps the build
// working before web/ is built; the web build copies web/dist here.
//
//go:embed all:dist
var embeddedDist embed.FS

// embeddedSPA returns the embedded console build.
func embeddedSPA() fs.FS {
	sub, err := fs.Sub(embeddedDist, "dist")
	if err != nil {
		panic(fmt.Sprintf("api: spa: %v", err))
	}
	return sub
}

// spaHandler serves console files, and index.html for every other GET.
type spaHandler struct {
	fsys  fs.FS
	index []byte
}

func newSPAHandler(fsys fs.FS) http.Handler {
	index, err := fs.ReadFile(fsys, "index.html")
	if err != nil {
		panic(fmt.Sprintf("api: spa: index.html: %v", err))
	}
	return &spaHandler{fsys: fsys, index: index}
}

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeAPIError(w, apiError{status: http.StatusNotFound, code: "not_found", message: "not found"})
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name != "" && name != "index.html" {
		if info, err := fs.Stat(h.fsys, name); err == nil && !info.IsDir() {
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			http.ServeFileFS(w, r, h.fsys, name)
			return
		}
	}
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_, _ = w.Write(h.index)
	}
}
