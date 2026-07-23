# mcpconsole

An embeddable, schema-driven web console for
[MCP](https://modelcontextprotocol.io) servers, in one line of Go:

```go
mux := http.NewServeMux()
mux.Handle("/mcp", mcpHandler)                 // any MCP streamable-HTTP handler
mux.Handle("/ui/", mcpconsole.Handler("/mcp")) // this library
```

## Usage

```go
import "github.com/bilus/mcpconsole"

func main() {
	server := mcp.NewServer(&mcp.Implementation{Name: "adder", Version: "0.1.0"}, nil)
	mcp.AddTool(server, /* … */)

	mux := http.NewServeMux()
	mux.Handle("/mcp", mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return server }, nil))
	mux.Handle("/ui/", mcpconsole.Handler("/mcp", mcpconsole.WithTitle("Adder - MCP Console")))
	log.Fatal(http.ListenAndServe("localhost:8080", mux))
}
```

Run either bundled example and open the console:

```bash
cd examples
go run ./adder   # http://localhost:8080/ui/  (SSE response mode)
go run ./echo    # http://localhost:8081/ui/  (plain-JSON response mode, enum params)
```

### Options

| Option | Effect |
| --- | --- |
| `WithTitle(string)` | Page title. Default `"MCP Console"`. |

## License

MIT, see [LICENSE](LICENSE).
