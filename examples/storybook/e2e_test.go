//go:build e2e

package main_test

// Storybook browser round-trip suite: for every schema shape the console
// supports (native widgets and raw-JSON fallbacks alike), drive the real UI
// in Chrome, submit the tool, and assert that the go-sdk server received
// exactly the arguments the form was supposed to build.
//
//	go test -tags e2e -run TestStorybookRoundTrips ./...

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/chromedp/chromedp"

	storybook "github.com/bilus/mcpconsole/examples/storybook"
)

func chromeAvailable() bool {
	for _, name := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser"} {
		if _, err := exec.LookPath(name); err == nil {
			return true
		}
	}
	for _, path := range []string{
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	} {
		if _, err := os.Stat(path); err == nil {
			return true
		}
	}
	return false
}

// recorder captures the arguments each tool call received server-side.
type recorder struct {
	mu  sync.Mutex
	got map[string][]map[string]any
}

func newRecorder() *recorder {
	return &recorder{got: map[string][]map[string]any{}}
}

func (r *recorder) record(tool string, args map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.got[tool] = append(r.got[tool], args)
}

// wait blocks until the tool has received exactly one call, and returns it.
func (r *recorder) wait(t *testing.T, tool string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		calls := r.got[tool]
		r.mu.Unlock()
		if len(calls) > 1 {
			t.Fatalf("tool %s was called %d times, want exactly 1", tool, len(calls))
		}
		if len(calls) == 1 {
			return calls[0]
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("tool %s was never called", tool)
	return nil
}

//
// Interactions are driven with JS (set value + dispatch the event the
// component listens for) so the suite is deterministic across engines. The
// dispatched events go through the same listeners real typing does.

func setInput(sel, val string) chromedp.Action {
	return chromedp.Evaluate(fmt.Sprintf(
		`(() => { const el = document.querySelector(%q); el.value = %q; el.dispatchEvent(new Event("input")); })()`,
		sel, val), nil)
}

func setSelect(sel, val string) chromedp.Action {
	return chromedp.Evaluate(fmt.Sprintf(
		`(() => { const el = document.querySelector(%q); el.value = %q; el.dispatchEvent(new Event("change")); })()`,
		sel, val), nil)
}

func clickEl(sel string) chromedp.Action {
	return chromedp.Evaluate(fmt.Sprintf(`document.querySelector(%q).click()`, sel), nil)
}

func clickAt(sel string, index int) chromedp.Action {
	return chromedp.Evaluate(fmt.Sprintf(`document.querySelectorAll(%q)[%d].click()`, sel, index), nil)
}

func setInputAt(sel string, index int, val string) chromedp.Action {
	return chromedp.Evaluate(fmt.Sprintf(
		`(() => { const el = document.querySelectorAll(%q)[%d]; el.value = %q; el.dispatchEvent(new Event("input")); })()`,
		sel, index, val), nil)
}

func waitCount(sel string, n int) chromedp.Action {
	var ok bool
	return chromedp.Poll(fmt.Sprintf(`document.querySelectorAll(%q).length === %d`, sel, n), &ok,
		chromedp.WithPollingTimeout(10*time.Second))
}

func waitToolOpen(name string) chromedp.Action {
	var ok bool
	return chromedp.Poll(fmt.Sprintf(
		`(() => { const el = document.querySelector("#tool-title"); return el !== null && el.textContent === %q; })()`,
		name), &ok, chromedp.WithPollingTimeout(10*time.Second))
}

// setJSONEditor asserts the tool is in forced-JSON mode, then replaces the
// editor content.
func setJSONEditor(t *testing.T, body string) chromedp.Action {
	return chromedp.Tasks{
		chromedp.ActionFunc(func(ctx context.Context) error {
			var forced bool
			err := chromedp.Evaluate(
				`(() => { const t = document.getElementById("json-mode"); return t.checked && t.disabled; })()`,
				&forced).Do(ctx)
			if err != nil {
				return err
			}
			if !forced {
				t.Error("expected the JSON editor to be forced (toggle checked and disabled)")
			}
			return nil
		}),
		setInput(".json-textarea", body),
	}
}

func TestStorybookRoundTrips(t *testing.T) {
	if !chromeAvailable() {
		t.Skip("no Chrome/Chromium installation found; skipping browser e2e suite")
	}

	rec := newRecorder()
	srv := httptest.NewServer(storybook.NewMux(rec.record))
	defer srv.Close()

	allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(),
		chromedp.DefaultExecAllocatorOptions[:]...)
	defer cancelAlloc()
	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	defer cancelBrowser()
	ctx, cancelTimeout := context.WithTimeout(browserCtx, 180*time.Second)
	defer cancelTimeout()

	if err := chromedp.Run(ctx,
		chromedp.Navigate(srv.URL+"/ui/"),
		chromedp.WaitVisible(`.tool-item`, chromedp.ByQuery),
	); err != nil {
		t.Fatalf("loading the console: %v", err)
	}

	cases := []struct {
		tool  string
		steps []chromedp.Action // native-widget interactions
		json  string            // non-empty: forced-JSON story, editor content
		want  string            // expected recorded arguments, as JSON
	}{
		{
			tool: "text",
			steps: []chromedp.Action{
				setInput(`[id="mc-title"]`, "Hello"),
				setInput(`[id="mc-email"]`, "ada@example.org"),
				setInput(`[id="mc-note"]`, "a long note"),
			},
			want: `{"title": "Hello", "email": "ada@example.org", "note": "a long note"}`,
		},
		{
			tool: "numbers",
			steps: []chromedp.Action{
				setInput(`[id="mc-count"]`, "42"),
				setInput(`[id="mc-threshold"]`, "-0.25"),
			},
			// ratio keeps its schema default of 0.5.
			want: `{"count": 42, "ratio": 0.5, "threshold": -0.25}`,
		},
		{
			tool: "toggles",
			steps: []chromedp.Action{
				clickEl(`[id="mc-dryRun"]`),
			},
			// verbose defaults to on; booleans are always sent.
			want: `{"verbose": true, "dryRun": true}`,
		},
		{
			tool: "choices",
			steps: []chromedp.Action{
				setSelect(`[id="mc-level"]`, "2"), // warn
				setSelect(`[id="mc-kind"]`, "0"),  // the const value
			},
			// fruit keeps its default; maybe stays unchosen and is omitted.
			want: `{"level": "warn", "fruit": "banana", "kind": "fixed"}`,
		},
		{
			tool: "lists",
			steps: []chromedp.Action{
				clickEl(`[data-path="tags"] .text-btn`),
				waitCount(`[data-path="tags"] .array-rows input`, 1),
				setInputAt(`[data-path="tags"] .array-rows input`, 0, "go"),
				clickEl(`[data-path="tags"] .text-btn`),
				waitCount(`[data-path="tags"] .array-rows input`, 2),
				setInputAt(`[data-path="tags"] .array-rows input`, 1, "mcp"),
			},
			// ports keeps its default rows; flags has no rows and is omitted.
			want: `{"tags": ["go", "mcp"], "ports": [80, 443]}`,
		},
		{
			tool: "nested",
			steps: []chromedp.Action{
				setInput(`[id="mc-profile.name"]`, "Ada"),
				setInput(`[id="mc-profile.contact.email"]`, "ada@x.io"),
			},
			// options is left empty and must be omitted even though its child
			// key is required within the group.
			want: `{"profile": {"name": "Ada", "contact": {"email": "ada@x.io"}}}`,
		},
		{
			tool: "union",
			json: `{"payload": 42}`,
			want: `{"payload": 42}`,
		},
		{
			tool: "variants",
			json: `{"shape": {"kind": "circle", "r": 2}, "strict": "abc"}`,
			want: `{"shape": {"kind": "circle", "r": 2}, "strict": "abc"}`,
		},
		{
			tool: "linked",
			json: `{"home": {"street": "Main St", "city": "Springfield"}}`,
			want: `{"home": {"street": "Main St", "city": "Springfield"}}`,
		},
		{
			tool: "dictionary",
			json: `{"attributes": {"env": "prod", "tier": "gold"}}`,
			want: `{"attributes": {"env": "prod", "tier": "gold"}}`,
		},
		{
			tool: "table",
			json: `{"rows": [{"x": 1, "y": 2}, {"x": 3, "y": 4}]}`,
			want: `{"rows": [{"x": 1, "y": 2}, {"x": 3, "y": 4}]}`,
		},
		{
			tool: "anything",
			json: `{"freeform": {"deep": [1, "two", null]}, "nickname": null}`,
			want: `{"freeform": {"deep": [1, "two", null]}, "nickname": null}`,
		},
	}

	okCards := 0
	for _, tc := range cases {
		t.Run(tc.tool, func(t *testing.T) {
			actions := chromedp.Tasks{
				clickEl(fmt.Sprintf(`.tool-item[data-name=%q]`, tc.tool)),
				waitToolOpen(tc.tool),
			}
			if tc.json != "" {
				actions = append(actions, setJSONEditor(t, tc.json))
			} else {
				actions = append(actions, tc.steps...)
			}
			actions = append(actions, clickEl("#run-btn"))
			if err := chromedp.Run(ctx, actions); err != nil {
				t.Fatalf("driving story %s: %v", tc.tool, err)
			}

			got := rec.wait(t, tc.tool)
			var want map[string]any
			if err := json.Unmarshal([]byte(tc.want), &want); err != nil {
				t.Fatalf("bad want JSON: %v", err)
			}
			if !reflect.DeepEqual(got, want) {
				gotJSON, _ := json.Marshal(got)
				t.Errorf("server received %s\nwant           %s", gotJSON, tc.want)
			}

			// The feed must show one more OK card and no error cards.
			okCards++
			if err := chromedp.Run(ctx,
				waitCount(".result-card .badge-ok", okCards),
				waitCount(".result-card.is-error", 0),
			); err != nil {
				t.Fatalf("story %s: result card never appeared cleanly: %v", tc.tool, err)
			}
		})
	}

	// Visible round-trip spot check: the newest card belongs to the last
	// story and must show its structured content.
	var structured string
	if err := chromedp.Run(ctx,
		chromedp.Text(`.result-card .json-block`, &structured, chromedp.ByQuery),
	); err != nil {
		t.Fatalf("reading structured content: %v", err)
	}
	if !strings.Contains(structured, `"freeform"`) || !strings.Contains(structured, `"two"`) {
		t.Errorf("newest structuredContent %q does not show the echoed arguments", structured)
	}
}
