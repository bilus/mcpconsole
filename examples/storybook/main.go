// This "storybook" exercises every input schema shape, with each tool
// simply echoing its arguments back.
//
//	go run ./storybook
//	open http://localhost:8082/ui/
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/bilus/mcpconsole"
)

// RecordFn observes the arguments each tool call received.
type RecordFn func(tool string, args map[string]any)

type story struct {
	name        string
	description string
	schema      *jsonschema.Schema
}

func ptr[T any](v T) *T { return &v }

// Renderable stories for every widget + unsupported constructs (JSON editor).
var stories = []story{
	{
		name:        "text",
		description: "String inputs: plain, format-typed (email/uri/date), and textarea.",
		schema: &jsonschema.Schema{
			Type:     "object",
			Required: []string{"title"},
			Properties: map[string]*jsonschema.Schema{
				"title":    {Type: "string", Description: "a plain string"},
				"email":    {Type: "string", Format: "email", Description: "renders as an email input"},
				"homepage": {Type: "string", Format: "uri"},
				"born":     {Type: "string", Format: "date"},
				"note":     {Type: "string", MaxLength: ptr(400), Description: "long strings render as a textarea"},
			},
		},
	},
	{
		name:        "numbers",
		description: "Numbers and integers with bounds and defaults.",
		schema: &jsonschema.Schema{
			Type:     "object",
			Required: []string{"count"},
			Properties: map[string]*jsonschema.Schema{
				"count":     {Type: "integer", Minimum: ptr(0.0), Maximum: ptr(100.0), Description: "an integer between 0 and 100"},
				"ratio":     {Type: "number", Default: json.RawMessage("0.5")},
				"threshold": {Type: "number", Minimum: ptr(-1.0), Maximum: ptr(1.0)},
			},
		},
	},
	{
		name:        "toggles",
		description: "Booleans render as switches and are always sent explicitly.",
		schema: &jsonschema.Schema{
			Type:     "object",
			Required: []string{"verbose"},
			Properties: map[string]*jsonschema.Schema{
				"verbose": {Type: "boolean", Default: json.RawMessage("true")},
				"dryRun":  {Type: "boolean", Description: "no writes when on"},
			},
		},
	},
	{
		name:        "choices",
		description: "Enums and consts render as selects.",
		schema: &jsonschema.Schema{
			Type:     "object",
			Required: []string{"level"},
			Properties: map[string]*jsonschema.Schema{
				"level": {Type: "string", Enum: []any{"debug", "info", "warn", "error"}, Description: "required, no default"},
				"fruit": {Type: "string", Enum: []any{"apple", "banana", "cherry"}, Default: json.RawMessage(`"banana"`)},
				"maybe": {Type: "string", Enum: []any{"a", "b", "c"}, Description: "optional, gets an empty choice"},
				"kind":  {Const: ptr[any]("fixed"), Description: "a single-value const"},
			},
		},
	},
	{
		name:        "lists",
		description: "Arrays of primitives render as repeatable rows.",
		schema: &jsonschema.Schema{
			Type:     "object",
			Required: []string{"tags"},
			Properties: map[string]*jsonschema.Schema{
				"tags":  {Type: "array", Items: &jsonschema.Schema{Type: "string"}, MinItems: ptr(1), MaxItems: ptr(5)},
				"ports": {Type: "array", Items: &jsonschema.Schema{Type: "integer"}, Default: json.RawMessage("[80, 443]")},
				"flags": {Type: "array", Items: &jsonschema.Schema{Type: "string", Enum: []any{"on", "off", "auto"}}},
			},
		},
	},
	{
		name:        "nested",
		description: "Nested objects render as grouped fieldsets.",
		schema: &jsonschema.Schema{
			Type:     "object",
			Required: []string{"profile"},
			Properties: map[string]*jsonschema.Schema{
				"profile": {
					Type:     "object",
					Required: []string{"name"},
					Properties: map[string]*jsonschema.Schema{
						"name": {Type: "string"},
						"contact": {
							Type: "object",
							Properties: map[string]*jsonschema.Schema{
								"email": {Type: "string", Format: "email"},
								"phone": {Type: "string"},
							},
						},
					},
				},
				"options": {
					Type:        "object",
					Required:    []string{"key"},
					Description: "optional group; leaving it empty omits it entirely",
					Properties: map[string]*jsonschema.Schema{
						"key":     {Type: "string"},
						"comment": {Type: "string"},
					},
				},
			},
		},
	},
	{
		name:        "union",
		description: "oneOf forces the raw-JSON editor.",
		schema: &jsonschema.Schema{
			Type:     "object",
			Required: []string{"payload"},
			Properties: map[string]*jsonschema.Schema{
				"payload": {
					OneOf:       []*jsonschema.Schema{{Type: "string"}, {Type: "number"}},
					Description: "a string or a number",
				},
			},
		},
	},
	{
		name:        "variants",
		description: "anyOf and allOf force the raw-JSON editor.",
		schema: &jsonschema.Schema{
			Type: "object",
			Properties: map[string]*jsonschema.Schema{
				"shape": {
					AnyOf: []*jsonschema.Schema{
						{
							Type: "object",
							Properties: map[string]*jsonschema.Schema{
								"kind": {Const: ptr[any]("circle")},
								"r":    {Type: "number"},
							},
						},
						{
							Type: "object",
							Properties: map[string]*jsonschema.Schema{
								"kind": {Const: ptr[any]("rect")},
								"w":    {Type: "number"},
								"h":    {Type: "number"},
							},
						},
					},
				},
				"strict": {AllOf: []*jsonschema.Schema{{Type: "string"}, {MinLength: ptr(3)}}},
			},
		},
	},
	{
		name:        "linked",
		description: "$ref/$defs force the raw-JSON editor.",
		schema: &jsonschema.Schema{
			Type: "object",
			Defs: map[string]*jsonschema.Schema{
				"address": {
					Type: "object",
					Properties: map[string]*jsonschema.Schema{
						"street": {Type: "string"},
						"city":   {Type: "string"},
					},
				},
			},
			Properties: map[string]*jsonschema.Schema{
				"home": {Ref: "#/$defs/address"},
				"work": {Ref: "#/$defs/address"},
			},
		},
	},
	{
		name:        "dictionary",
		description: "Map-style objects (additionalProperties) force the raw-JSON editor.",
		schema: &jsonschema.Schema{
			Type: "object",
			Properties: map[string]*jsonschema.Schema{
				"attributes": {Type: "object", AdditionalProperties: &jsonschema.Schema{Type: "string"}},
			},
		},
	},
	{
		name:        "table",
		description: "Arrays of objects force the raw-JSON editor.",
		schema: &jsonschema.Schema{
			Type: "object",
			Properties: map[string]*jsonschema.Schema{
				"rows": {
					Type: "array",
					Items: &jsonschema.Schema{
						Type: "object",
						Properties: map[string]*jsonschema.Schema{
							"x": {Type: "number"},
							"y": {Type: "number"},
						},
					},
				},
			},
		},
	},
	{
		name:        "anything",
		description: "Untyped values and union types force the raw-JSON editor.",
		schema: &jsonschema.Schema{
			Type: "object",
			Properties: map[string]*jsonschema.Schema{
				"freeform": {Description: "no type at all"},
				"nickname": {Types: []string{"string", "null"}},
			},
		},
	},
}

// echoHandlerFn returns a raw tool handler that records the received
// arguments and echoes them back as both text and structured content.
func echoHandlerFn(name string, record RecordFn) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := map[string]any{}
		if len(req.Params.Arguments) > 0 {
			if err := json.Unmarshal(req.Params.Arguments, &args); err != nil {
				return nil, fmt.Errorf("unmarshaling arguments: %w", err)
			}
		}
		if record != nil {
			record(name, args)
		}
		echoed, err := json.Marshal(args)
		if err != nil {
			return nil, fmt.Errorf("marshaling echo: %w", err)
		}
		return &mcp.CallToolResult{
			Content:           []mcp.Content{&mcp.TextContent{Text: string(echoed)}},
			StructuredContent: args,
		}, nil
	}
}

// NewServer returns the storybook MCP server.
func NewServer(record RecordFn) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "storybook", Version: "0.1.0"}, nil)
	for _, s := range stories {
		server.AddTool(&mcp.Tool{
			Name:        s.name,
			Description: s.description,
			InputSchema: s.schema,
		}, echoHandlerFn(s.name, record))
	}
	return server
}

// NewMux creates routing for the storybook server.
func NewMux(record RecordFn) *http.ServeMux {
	server := NewServer(record)
	mux := http.NewServeMux()
	mux.Handle("/mcp", mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil))
	mux.Handle("/ui/", mcpconsole.Handler("/mcp", mcpconsole.WithTitle("Storybook - MCP Console")))
	return mux
}

func main() {
	mux := NewMux(nil)
	log.Println("storybook example: UI on http://localhost:8082/ui/ (MCP endpoint on /mcp)")
	log.Fatal(http.ListenAndServe("localhost:8082", mux))
}
