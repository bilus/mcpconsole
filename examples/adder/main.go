// Command adder runs the example MCP server (one "add" tool) with the
// mcpconsole UI mounted next to it:
//
//	go run ./adder
//	open http://localhost:8080/ui/
package main

import (
	"context"
	"log"
	"net/http"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/bilus/mcpconsole"
)

type addInput struct {
	A float64 `json:"a" jsonschema:"first addend"`
	B float64 `json:"b" jsonschema:"second addend"`
}

type addOutput struct {
	Sum float64 `json:"sum" jsonschema:"sum of the two addends"`
}

// NewServer returns an MCP server named "adder" with one "add" tool.
func NewServer() *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "adder", Version: "0.1.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "add",
		Description: "Add two numbers and return their sum.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, in addInput) (*mcp.CallToolResult, addOutput, error) {
		return nil, addOutput{Sum: in.A + in.B}, nil
	})
	return server
}

func NewMux() *http.ServeMux {
	server := NewServer()
	mux := http.NewServeMux()
	mux.Handle("/mcp", mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil))
	mux.Handle("/ui/", mcpconsole.Handler("/mcp"))
	return mux
}

func main() {
	mux := NewMux()
	log.Println("adder example: UI on http://localhost:8080/ui/ (MCP endpoint on /mcp)")
	log.Fatal(http.ListenAndServe("localhost:8080", mux))
}
