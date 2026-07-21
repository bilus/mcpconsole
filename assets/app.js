import { app, h, text } from "./hyperapp.js";
import { McpClient, McpError, HttpError } from "./mcp.js";
import { isEmptyObjectSchema, isSchemaObject, jsonSeed } from "./schema.js";

function readConfig() {
  try {
    const parsed = JSON.parse(document.getElementById("mcpconsole-config")?.textContent ?? "");
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // no <script>, use defaults
  }
  return { endpoint: "/mcp", title: "MCP Console" };
}
const cfg = readConfig();

const initialState = {
  status: { kind: "connecting", detail: "", sessionId: null },
  server: null, // {name, version, protocolVersion} from initialize
  connectError: null,
  tools: [],
  toolsSpinning: false,
  selected: null, // the selected tool object from tools/list
  form: null, // see buildForm
  running: false,
  results: [], // newest first: {id, tool, kind, result?, error?, raw?, ms, at}
  nextResultId: 1,
};

// Derive the form state for a tool's input schema. Every tool with arguments
// is edited as raw JSON, pre-filled with a schema-derived skeleton.
function buildForm(schema) {
  return {
    schema,
    empty: isEmptyObjectSchema(schema),
    jsonText: JSON.stringify(jsonSeed(schema), null, 2),
    jsonError: null,
    formMsg: null,
  };
}

const SetStatus = (state, status) => ({ ...state, status });

const ConnectOk = (state, init) => [
  {
    ...state,
    connectError: null,
    server: {
      name: init.serverInfo?.title || init.serverInfo?.name || "unnamed server",
      version: init.serverInfo?.version || "",
      protocolVersion: init.protocolVersion || "",
    },
  },
  refreshToolsFx,
];

const ConnectFailed = (state, message) => ({ ...state, connectError: message });

const Retry = (state) => [
  { ...state, connectError: null, status: { ...state.status, kind: "connecting" } },
  connectFx,
];

const RefreshTools = (state) => [{ ...state, toolsSpinning: true }, refreshToolsFx];

// Reconcile the fresh list with the current selection.
const ToolsOk = (state, tools) => {
  const next = { ...state, tools, toolsSpinning: false, connectError: null };
  if (!state.selected) return next;
  const fresh = tools.find((t) => t.name === state.selected.name);
  if (!fresh) return { ...next, selected: null, form: null };
  if (JSON.stringify(fresh.inputSchema) !== JSON.stringify(state.selected.inputSchema)) {
    return { ...next, selected: fresh, form: buildForm(fresh.inputSchema) };
  }
  return { ...next, selected: fresh };
};

const ToolsFailed = (state, message) => ({ ...state, toolsSpinning: false, connectError: message });

const GotNotification = (state, msg) =>
  msg.method === "notifications/tools/list_changed" ? [state, debouncedRefreshFx] : state;

const SelectTool = (state, tool) => ({
  ...state,
  selected: tool,
  form: buildForm(tool.inputSchema),
});

const SetJsonText = (state, jsonText) =>
  state.form ? { ...state, form: { ...state.form, jsonText, jsonError: null } } : state;

const Run = (state) => {
  const form = state.form;
  if (!form || !state.selected || state.running) return state;
  let args;
  if (form.empty) {
    args = {};
  } else {
    let parsed;
    try {
      parsed = JSON.parse(form.jsonText.trim() === "" ? "{}" : form.jsonText);
    } catch (e) {
      return {
        ...state,
        form: { ...form, jsonError: `Invalid JSON: ${e.message}`, formMsg: "Arguments are not valid JSON" },
      };
    }
    if (!isSchemaObject(parsed)) {
      return {
        ...state,
        form: { ...form, jsonError: "Arguments must be a JSON object.", formMsg: "Arguments must be a JSON object" },
      };
    }
    args = parsed;
  }
  return [
    { ...state, running: true, form: { ...form, jsonError: null, formMsg: null } },
    [callToolFx, { name: state.selected.name, args }],
  ];
};

const CallOk = (state, { result, raw, ms, at }) =>
  addResult(state, {
    tool: state.selected?.name || "?",
    kind: result?.isError ? "toolerr" : "ok",
    result,
    raw,
    ms,
    at,
  });

const CallFailed = (state, { error, ms, at }) =>
  addResult(state, {
    tool: state.selected?.name || "?",
    kind: "rpcerr",
    error,
    raw: error?.raw || null,
    ms,
    at,
  });

function addResult(state, entry) {
  return {
    ...state,
    running: false,
    results: [{ id: state.nextResultId, ...entry }, ...state.results],
    nextResultId: state.nextResultId + 1,
  };
}

let client = null;
let refreshTimer = null;

const connectFx = (dispatch) => {
  if (!client) {
    client = new McpClient({
      endpoint: cfg.endpoint,
      onStatus: (kind, detail) =>
        dispatch(SetStatus, { kind, detail: detail || "", sessionId: client ? client.sessionId : null }),
      onNotification: (msg) => dispatch(GotNotification, msg),
    });
  }
  client
    .connect()
    .then((init) => dispatch(ConnectOk, init))
    .catch((err) => dispatch(ConnectFailed, String(err.message || err)));
};

const refreshToolsFx = (dispatch) => {
  client
    .listTools()
    .then((tools) => dispatch(ToolsOk, tools))
    .catch((err) => dispatch(ToolsFailed, String(err.message || err)));
};

const debouncedRefreshFx = (dispatch) => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => dispatch(RefreshTools), 150);
};

const callToolFx = (dispatch, { name, args }) => {
  const started = performance.now();
  const done = () => ({
    ms: Math.max(1, Math.round(performance.now() - started)),
    at: new Date().toLocaleTimeString(),
  });
  client
    .callTool(name, args)
    .then(({ result, raw }) => dispatch(CallOk, { result, raw, ...done() }))
    .catch((error) => dispatch(CallFailed, { error, ...done() }));
};

const statusChip = ({ status, onretry }) => {
  const { kind, detail, sessionId } = status;
  const label =
    kind === "connecting"
      ? "connecting…"
      : kind === "connected"
        ? sessionId
          ? `connected · ${sessionId.slice(0, 8)}`
          : "connected"
        : "error";
  const title =
    kind === "connected"
      ? sessionId
        ? `Session ${sessionId}`
        : "Connected (stateless session)"
      : kind === "error"
        ? `${detail || "connection failed"} - click to retry`
        : "";
  return h(
    "div",
    { id: "status-chip", class: ["chip", `chip-${kind}`], title, onclick: kind === "error" ? onretry : undefined },
    text(label),
  );
};

const serverInfo = ({ server }) =>
  h(
    "div",
    { id: "server-info", hidden: !server },
    server
      ? [h("div", { class: "server-name" }, text(server.name)), metaLine(server)]
      : [],
  );

const metaLine = (server) => {
  const meta = [server.version ? `v${server.version}` : "", server.protocolVersion].filter(Boolean).join(" · ");
  return meta ? h("div", { class: "server-meta" }, text(meta)) : false;
};

const toolItem = ({ tool, active, onselect }) => {
  const desc = (tool.description || "").split("\n")[0];
  return h("button", { type: "button", class: ["tool-item", { active }], "data-name": tool.name, onclick: onselect }, [
    h("div", { class: "tool-item-name" }, text(tool.title || tool.annotations?.title || tool.name)),
    desc ? h("div", { class: "tool-item-desc", title: tool.description }, text(desc)) : false,
  ]);
};

const connectErrorCard = ({ message, onretry }) =>
  h("div", { class: "connect-error" }, [
    h("div", { class: "connect-error-title" }, text("Could not connect to the MCP server")),
    h("div", { class: "connect-error-msg" }, text(message)),
    h("button", { type: "button", class: "primary", onclick: onretry }, text("Retry")),
  ]);

const toolList = ({ tools, connectError, selectedName }) =>
  h(
    "nav",
    { id: "tool-list", "aria-label": "Tools" },
    connectError
      ? [connectErrorCard({ message: connectError, onretry: Retry })]
      : [
          tools.length === 0 ? h("div", { class: "no-tools" }, text("The server exposes no tools.")) : false,
          ...tools.map((tool) => toolItem({ tool, active: tool.name === selectedName, onselect: [SelectTool, tool] })),
        ],
  );

const rail = ({ title, server, status, tools, connectError, toolsSpinning, selectedName }) =>
  h("aside", { id: "rail" }, [
    h("header", { id: "rail-head" }, [
      h("h1", { id: "app-title" }, text(title)),
      serverInfo({ server }),
      statusChip({ status, onretry: Retry }),
    ]),
    h("div", { id: "tools-head" }, [
      h("span", {}, text("Tools")),
      h(
        "button",
        {
          id: "refresh-tools",
          type: "button",
          class: ["icon-btn", { spinning: toolsSpinning }],
          title: "Refresh tool list",
          "aria-label": "Refresh tool list",
          onclick: RefreshTools,
        },
        text("⟳"),
      ),
    ]),
    toolList({ tools, connectError, selectedName }),
  ]);

const resultHead = ({ res, badge, badgeClass }) =>
  h("header", { class: "result-head" }, [
    h("span", { class: "result-tool" }, text(res.tool)),
    h("span", { class: ["badge", badgeClass] }, text(badge)),
    h("span", { class: "spacer" }),
    h("span", { class: "result-ms" }, text(`${res.ms} ms`)),
    h("time", { class: "result-time" }, text(res.at)),
  ]);

const errorText = (error) => {
  if (error instanceof McpError) return `JSON-RPC error ${error.code}: ${error.message}`;
  if (error instanceof HttpError) return error.message;
  return String(error?.message || error);
};

const resultCard = ({ res }) => {
  if (res.kind === "rpcerr") {
    return h("article", { key: res.id, class: "result-card is-error" }, [
      resultHead({ res, badge: "Error", badgeClass: "badge-err" }),
      h("div", { class: "result-body" }, [
        h("pre", { class: "text-block error-text" }, text(errorText(res.error))),
      ]),
    ]);
  }
  const isErr = res.kind === "toolerr";
  const result = res.result || {};
  const blocks = (result.content ?? []).filter((b) => b?.type === "text");
  return h("article", { key: res.id, class: ["result-card", { "is-error": isErr }] }, [
    resultHead({ res, badge: isErr ? "Tool error" : "OK", badgeClass: isErr ? "badge-err" : "badge-ok" }),
    h(
      "div",
      { class: "result-body" },
      blocks.length
        ? blocks.map((b) => h("pre", { class: "text-block" }, text(b.text ?? "")))
        : [h("div", { class: "text-dim" }, text("(empty result)"))],
    ),
  ]);
};

const toolPanel = ({ selected, form, running, results }) =>
  h(
    "section",
    { id: "tool-panel", hidden: !selected },
    selected
      ? [
          h("div", { id: "form-card", class: "card" }, [
            h("div", { id: "tool-title-row" }, [
              h("div", {}, [
                h("h2", { id: "tool-title" }, text(selected.title || selected.annotations?.title || selected.name)),
                h("p", { id: "tool-desc", hidden: !selected.description }, text(selected.description || "")),
              ]),
              h(
                "label",
                { class: "json-toggle", title: "Arguments are edited as raw JSON." },
                [
                  h("input", { type: "checkbox", id: "json-mode", checked: !form.empty, disabled: true }),
                  text(" "),
                  h("span", {}, text("Edit as JSON")),
                ],
              ),
            ]),
            h(
              "form",
              {
                id: "tool-form",
                novalidate: true,
                onsubmit: (state, event) => (event.preventDefault(), Run),
              },
              [
                h("div", { class: "form-fields", hidden: !form.empty }, [
                  form.empty ? h("p", { class: "no-args" }, text("This tool takes no arguments.")) : false,
                ]),
                h("div", { class: "json-editor", hidden: form.empty }, [
                  h("textarea", {
                    class: "json-textarea",
                    spellcheck: false,
                    "aria-label": "Tool arguments as JSON",
                    value: form.jsonText,
                    oninput: (_, event) => [SetJsonText, event.target.value],
                  }),
                  h(
                    "div",
                    { class: "field-error json-parse-error", hidden: !form.jsonError },
                    form.jsonError ? text(form.jsonError) : [],
                  ),
                ]),
              ],
            ),
            h("div", { id: "form-actions" }, [
              h(
                "button",
                {
                  id: "run-btn",
                  type: "button",
                  class: ["primary", { busy: running }],
                  disabled: running,
                  onclick: Run,
                },
                text("Run tool"),
              ),
            ]),
            h("div", { id: "form-msg", class: "form-msg", hidden: !form.formMsg }, form.formMsg ? text(form.formMsg) : []),
          ]),
          h("section", { id: "results", "aria-live": "polite" }, results.map((res) => resultCard({ res }))),
        ]
      : [],
  );

const emptyState = ({ visible }) =>
  h(
    "section",
    { id: "empty-state", hidden: !visible },
    h("p", {}, text("Select a tool from the list to build a request from its schema.")),
  );

const rootView = (state) =>
  h("div", { id: "app" }, [
    rail({
      title: cfg.title,
      server: state.server,
      status: state.status,
      tools: state.tools,
      connectError: state.connectError,
      toolsSpinning: state.toolsSpinning,
      selectedName: state.selected?.name,
    }),
    h("main", { id: "main" }, [
      toolPanel({ selected: state.selected, form: state.form, running: state.running, results: state.results }),
      emptyState({ visible: !state.selected }),
    ]),
  ]);

app({
  init: [initialState, connectFx],
  view: rootView,
  node: document.getElementById("app"),
});
