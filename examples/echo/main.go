// Command echo runs the second example MCP server (string/enum "echo" tool,
// plain-JSON response mode) with the same mcpconsole UI mounted next to it:
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"unicode"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/bilus/mcpconsole"
)

type echoInput struct {
	Text   string `json:"text"`
	Mode   string `json:"mode"`
	Repeat int    `json:"repeat,omitempty"`
}

type echoOutput struct {
	Echo string `json:"echo" jsonschema:"the transformed, repeated text"`
}

func one() *float64 {
	v := 1.0
	return &v
}

// NewServer returns an MCP server named "echo" with one "echo" tool.
func NewServer() *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "echo", Version: "0.1.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "echo",
		Description: "Echo text back, transformed and optionally repeated.",
		InputSchema: &jsonschema.Schema{
			Type:     "object",
			Required: []string{"text", "mode"},
			Properties: map[string]*jsonschema.Schema{
				"text": {Type: "string", Description: "text to echo back"},
				"mode": {
					Type:        "string",
					Description: "case transformation to apply",
					Enum:        []any{"upper", "lower", "title"},
				},
				"repeat": {
					Type:        "integer",
					Description: "how many times to repeat the text",
					Default:     json.RawMessage("1"),
					Minimum:     one(),
				},
			},
		},
	}, func(ctx context.Context, req *mcp.CallToolRequest, in echoInput) (*mcp.CallToolResult, echoOutput, error) {
		out, err := transform(in.Text, in.Mode)
		if err != nil {
			return nil, echoOutput{}, err
		}
		parts := make([]string, max(in.Repeat, 1))
		for i := range parts {
			parts[i] = out
		}
		return nil, echoOutput{Echo: strings.Join(parts, " ")}, nil
	})
	return server
}

func transform(text, mode string) (string, error) {
	switch mode {
	case "upper":
		return strings.ToUpper(text), nil
	case "lower":
		return strings.ToLower(text), nil
	case "title":
		return titleCase(text), nil
	default:
		return "", fmt.Errorf("unknown mode %q", mode)
	}
}

func titleCase(s string) string {
	words := strings.Fields(strings.ToLower(s))
	for i, w := range words {
		r := []rune(w)
		words[i] = string(unicode.ToUpper(r[0])) + string(r[1:])
	}
	return strings.Join(words, " ")
}

func NewMux() *http.ServeMux {
	server := NewServer()
	mux := http.NewServeMux()
	mux.Handle("/mcp", mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return server },
		&mcp.StreamableHTTPOptions{JSONResponse: true},
	))
	mux.Handle("/ui/", mcpconsole.Handler("/mcp", mcpconsole.WithTitle("Echo - MCP Console")))
	return mux
}

func main() {
	mux := NewMux()
	log.Println("echo example: UI on http://localhost:8081/ui/ (MCP endpoint on /mcp)")
	log.Fatal(http.ListenAndServe("localhost:8081", mux))
}
