package mcpconsole_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/bilus/mcpconsole"
)

func get(t *testing.T, h http.Handler, prefix, path string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle(prefix, h)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func body(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	b, err := io.ReadAll(rec.Result().Body)
	if err != nil {
		t.Fatalf("read recorded body: %v", err)
	}
	return string(b)
}

func TestServesIndexAtAnyPrefix(t *testing.T) {
	h := mcpconsole.Handler("/mcp")
	for _, tc := range []struct{ prefix, path string }{
		{"/ui/", "/ui/"},
		{"/console/x/", "/console/x/"},
		{"/", "/"}, // e.g. mounted behind StripPrefix
		{"/ui/", "/ui/index.html"},
		{"/ui/", "/ui/some/deep/extensionless-path"},
	} {
		rec := get(t, h, tc.prefix, tc.path)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s (mounted at %s): status %d, want 200", tc.path, tc.prefix, rec.Code)
			continue
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Errorf("GET %s: Content-Type %q, want text/html", tc.path, ct)
		}
		if !strings.Contains(body(t, rec), `id="mcpconsole-config"`) {
			t.Errorf("GET %s: index does not embed the console config block", tc.path)
		}
	}
}

func TestConfigInjection(t *testing.T) {
	rec := get(t, mcpconsole.Handler("/mcp"), "/ui/", "/ui/")
	html := body(t, rec)
	if !strings.Contains(html, `"endpoint":"/mcp"`) {
		t.Errorf("config JSON lacks endpoint, got page:\n%s", html)
	}
	if !strings.Contains(html, `"title":"MCP Console"`) {
		t.Error("config JSON lacks default title \"MCP Console\"")
	}
	if !strings.Contains(html, "<title>MCP Console</title>") {
		t.Error("page <title> not set to default title")
	}

	rec = get(t, mcpconsole.Handler("/api/mcp", mcpconsole.WithTitle("Adder Dev UI")), "/ui/", "/ui/")
	html = body(t, rec)
	if !strings.Contains(html, `"endpoint":"/api/mcp"`) {
		t.Error("config JSON lacks custom endpoint")
	}
	if !strings.Contains(html, `"title":"Adder Dev UI"`) {
		t.Error("config JSON lacks custom title")
	}
	if !strings.Contains(html, "<title>Adder Dev UI</title>") {
		t.Error("page <title> not set to custom title")
	}
}

func TestConfigEscaping(t *testing.T) {
	h := mcpconsole.Handler("</script><script>alert(1)</script>",
		mcpconsole.WithTitle("</title><script>alert(2)</script>"))
	html := body(t, get(t, h, "/ui/", "/ui/"))
	if strings.Contains(html, "<script>alert(") {
		t.Error("unescaped script breakout in served HTML")
	}
	if strings.Contains(html, "</title><script>") {
		t.Error("unescaped title breakout in served HTML")
	}
}

func TestServesAssetsUnderAnyPrefix(t *testing.T) {
	h := mcpconsole.Handler("/mcp")
	for _, tc := range []struct{ name, wantType string }{
		{"app.css", "text/css"},
		{"mcp.js", "text/javascript"},
		{"schema.js", "text/javascript"},
		{"form.js", "text/javascript"},
		{"app.js", "text/javascript"},
		{"hyperapp.js", "text/javascript"},
	} {
		for _, prefix := range []string{"/ui/", "/console/x/"} {
			rec := get(t, h, prefix, prefix+tc.name)
			if rec.Code != http.StatusOK {
				t.Errorf("GET %s%s: status %d, want 200", prefix, tc.name, rec.Code)
				continue
			}
			if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, tc.wantType) {
				t.Errorf("GET %s%s: Content-Type %q, want %s", prefix, tc.name, ct, tc.wantType)
			}
			if len(body(t, rec)) == 0 {
				t.Errorf("GET %s%s: empty body", prefix, tc.name)
			}
		}
	}
}

func TestUnknownAssetWithExtensionIs404(t *testing.T) {
	rec := get(t, mcpconsole.Handler("/mcp"), "/ui/", "/ui/nope.png")
	if rec.Code != http.StatusNotFound {
		t.Errorf("GET /ui/nope.png: status %d, want 404", rec.Code)
	}
}

func TestNonGetRejected(t *testing.T) {
	mux := http.NewServeMux()
	mux.Handle("/ui/", mcpconsole.Handler("/mcp"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/ui/", strings.NewReader("x")))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /ui/: status %d, want 405", rec.Code)
	}
}

func TestAssetURLsAreRelative(t *testing.T) {
	html := body(t, get(t, mcpconsole.Handler("/mcp"), "/ui/", "/ui/"))
	re := regexp.MustCompile(`(?:src|href)\s*=\s*"([^"]*)"`)
	matches := re.FindAllStringSubmatch(html, -1)
	if len(matches) == 0 {
		t.Fatal("index.html references no assets at all; expected relative script/style links")
	}
	for _, m := range matches {
		url := m[1]
		if strings.HasPrefix(url, "/") || strings.Contains(url, "://") {
			t.Errorf("index.html references non-relative URL %q", url)
		}
	}
}
