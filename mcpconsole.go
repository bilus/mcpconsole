// Package mcpconsole serves an embeddable, schema-driven web console for MCP
// servers that speak the streamable HTTP transport. Mount it next to any MCP
// handler on the same origin:
//
//	mux := http.NewServeMux()
//	mux.Handle("/mcp", mcpHandler)
//	mux.Handle("/ui/", mcpconsole.Handler("/mcp"))
package mcpconsole

import "net/http"

// Handler returns an http.Handler serving the console UI configured to talk
// to the MCP endpoint at mcpEndpoint. The console itself is not implemented
// yet.
func Handler(mcpEndpoint string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "mcpconsole: not implemented yet", http.StatusNotImplemented)
	})
}
