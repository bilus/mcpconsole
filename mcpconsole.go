// Package mcpconsole serves an embeddable, schema-driven web console for MCP
// servers.
package mcpconsole

import (
	"embed"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"path"
	"strings"
)

//go:embed assets
var assetsFS embed.FS

var contentTypes = map[string]string{
	".html": "text/html; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".svg":  "image/svg+xml",
}

const defaultTitle = "MCP Console"

// Handler returns an http.Handler serving the console UI generated based
// on the provided MCP endpoint (e.g. "/mcp").
func Handler(mcpEndpoint string) http.Handler {
	files := map[string][]byte{}
	entries, err := assetsFS.ReadDir("assets")
	if err != nil {
		// Unreachable: the assets directory is embedded at compile time.
		panic(fmt.Sprintf("mcpconsole: reading embedded assets: %v", err))
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		data, err := assetsFS.ReadFile("assets/" + entry.Name())
		if err != nil {
			panic(fmt.Sprintf("mcpconsole: reading embedded asset %s: %v", entry.Name(), err))
		}
		files[entry.Name()] = data
	}

	// encoding/json escapes <, > and & by default, so the config JSON cannot
	// break out of its <script type="application/json"> block.
	configJSON, err := json.Marshal(map[string]string{
		"endpoint": mcpEndpoint,
		"title":    defaultTitle,
	})
	if err != nil {
		panic(fmt.Sprintf("mcpconsole: marshaling config: %v", err))
	}
	indexPage := []byte(strings.NewReplacer(
		"__MCPCONSOLE_TITLE__", html.EscapeString(defaultTitle),
		"__MCPCONSOLE_CONFIG__", string(configJSON),
	).Replace(string(files["index.html"])))
	delete(files, "index.html")

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		data, contentType, ok := route(r.URL.Path, files, indexPage)
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Method == http.MethodHead {
			return
		}
		if _, err := w.Write(data); err != nil {
			return
		}
	})
}

// route resolves a request path to an asset by its final segment alone, which
// makes the handler work unchanged under any mount prefix.
func route(urlPath string, files map[string][]byte, indexPage []byte) (data []byte, contentType string, ok bool) {
	if strings.HasSuffix(urlPath, "/") {
		return indexPage, contentTypes[".html"], true
	}
	base := path.Base(urlPath)
	if base == "index.html" {
		return indexPage, contentTypes[".html"], true
	}
	if data, ok := files[base]; ok {
		contentType := contentTypes[path.Ext(base)]
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		return data, contentType, true
	}
	if !strings.Contains(base, ".") {
		// Extension-less deep link: serve the app shell.
		return indexPage, contentTypes[".html"], true
	}
	return nil, "", false
}
