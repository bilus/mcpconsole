//go:build e2e

package main_test

import (
	"context"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	adderserver "github.com/bilus/mcpconsole/examples/adder"
	"github.com/chromedp/chromedp"
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

func TestUIAddSmoke(t *testing.T) {
	if !chromeAvailable() {
		t.Skip("no Chrome/Chromium installation found; skipping browser e2e smoke test")
	}

	srv := httptest.NewServer(adderserver.NewMux())
	defer srv.Close()

	allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(),
		chromedp.DefaultExecAllocatorOptions[:]...)
	defer cancelAlloc()
	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	defer cancelBrowser()
	ctx, cancelTimeout := context.WithTimeout(browserCtx, 60*time.Second)
	defer cancelTimeout()

	var textBlock, structured string
	err := chromedp.Run(
		ctx,
		chromedp.Navigate(srv.URL+"/ui/"),
		chromedp.WaitVisible(`.tool-item`, chromedp.ByQuery),
		chromedp.Click(`.tool-item`, chromedp.ByQuery),
		chromedp.WaitVisible(`.object-fields .field:nth-child(1) input`, chromedp.ByQuery),
		chromedp.SendKeys(`.object-fields .field:nth-child(1) input`, "2", chromedp.ByQuery),
		chromedp.SendKeys(`.object-fields .field:nth-child(2) input`, "3", chromedp.ByQuery),
		chromedp.Click(`#run-btn`, chromedp.ByQuery),
		chromedp.WaitVisible(`.result-card`, chromedp.ByQuery),
		chromedp.Text(`.result-card .text-block`, &textBlock, chromedp.ByQuery),
		chromedp.Text(`.result-card .json-block`, &structured, chromedp.ByQuery),
	)
	if err != nil {
		t.Fatalf("driving the console in Chrome: %v", err)
	}
	if !strings.Contains(textBlock, "5") {
		t.Errorf("result text block %q does not show the sum 5", textBlock)
	}
	if !strings.Contains(structured, `"sum"`) || !strings.Contains(structured, "5") {
		t.Errorf("structuredContent block %q does not show sum 5", structured)
	}
}

func TestUIValidationSmoke(t *testing.T) {
	if !chromeAvailable() {
		t.Skip("no Chrome/Chromium installation found; skipping browser e2e smoke test")
	}

	srv := httptest.NewServer(adderserver.NewMux())
	defer srv.Close()

	allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(),
		chromedp.DefaultExecAllocatorOptions[:]...)
	defer cancelAlloc()
	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	defer cancelBrowser()
	ctx, cancelTimeout := context.WithTimeout(browserCtx, 60*time.Second)
	defer cancelTimeout()

	var fieldErr, formMsg, badNumErr string
	var resultCards int
	err := chromedp.Run(
		ctx,
		chromedp.Navigate(srv.URL+"/ui/"),
		chromedp.WaitVisible(`.tool-item`, chromedp.ByQuery),
		chromedp.Click(`.tool-item`, chromedp.ByQuery),
		chromedp.WaitVisible(`#run-btn`, chromedp.ByQuery),
		// Submit with both required fields empty.
		chromedp.Click(`#run-btn`, chromedp.ByQuery),
		chromedp.WaitVisible(`.field-error`, chromedp.ByQuery),
		chromedp.Text(`.field-error`, &fieldErr, chromedp.ByQuery),
		chromedp.Text(`#form-msg`, &formMsg, chromedp.ByQuery),
		// Type a malformed number and submit again. The UI renders on the next
		// animation frame, so poll until the field error switches away from the
		// previous submit's "Required" instead of reading it immediately.
		chromedp.SendKeys(`.object-fields .field:nth-child(1) input`, "2e", chromedp.ByQuery),
		chromedp.Click(`#run-btn`, chromedp.ByQuery),
		chromedp.Poll(
			`(() => { const t = document.querySelector('.object-fields .field:nth-child(1) .field-error').textContent; return t !== "Required" && t; })()`,
			&badNumErr,
			chromedp.WithPollingTimeout(10*time.Second),
		),
		chromedp.Evaluate(`document.querySelectorAll(".result-card").length`, &resultCards),
	)
	if err != nil {
		t.Fatalf("driving the console in Chrome: %v", err)
	}
	if fieldErr != "Required" {
		t.Errorf("empty required field error = %q, want %q", fieldErr, "Required")
	}
	if !strings.Contains(formMsg, "2 fields need attention") {
		t.Errorf("form summary = %q, want it to report 2 fields needing attention", formMsg)
	}
	if badNumErr != "Not a valid number" {
		t.Errorf("malformed number error = %q, want %q", badNumErr, "Not a valid number")
	}
	if resultCards != 0 {
		t.Errorf("%d result cards rendered; validation failures must not send requests", resultCards)
	}
}
