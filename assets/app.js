import { app, h, text } from "./hyperapp.js";
import { McpClient, McpError, HttpError } from "./mcp.js";
import {
  collect,
  controlsFromJson,
  initialControls,
  isEmptyObjectSchema,
  isRenderable,
  isSchemaObject,
  jsonSeed,
  tokenizeJson,
} from "./schema.js";
import { toolForm } from "./form.js";

const BASE_URI = document.baseURI;

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

// Derive the form state for a tool's input schema.
function buildForm(schema) {
  const empty = isEmptyObjectSchema(schema);
  const renderable = !empty && isRenderable(schema);
  return {
    schema,
    empty,
    renderable,
    forcedJson: !empty && !renderable,
    jsonMode: !empty && !renderable,
    jsonText: JSON.stringify(jsonSeed(schema), null, 2),
    jsonError: null,
    controls: empty || !renderable ? {} : initialControls(schema),
    errors: {},
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

const ToggleJsonMode = (state, on) => {
  const form = state.form;
  if (!form) return state;
  on = Boolean(on) || form.forcedJson;
  if (on === form.jsonMode) return { ...state, form: { ...form, formMsg: null } };
  if (on) {
    const r = form.renderable ? collect(form.schema, form.controls) : { any: false };
    const seed = r.any ? r.args : jsonSeed(form.schema);
    return {
      ...state,
      form: {
        ...form,
        jsonMode: true,
        jsonText: JSON.stringify(seed, null, 2),
        jsonError: null,
        errors: {},
        formMsg: null,
      },
    };
  }
    // Note: Best effort.
  let controls = form.controls;
  try {
    const parsed = JSON.parse(form.jsonText);
    if (isSchemaObject(parsed) && form.renderable) {
      controls = controlsFromJson(form.schema, form.controls, parsed);
    }
  } catch {
  }
  return { ...state, form: { ...form, jsonMode: false, controls, jsonError: null, formMsg: null } };
};

const SetJsonText = (state, jsonText) =>
  state.form ? { ...state, form: { ...state.form, jsonText, jsonError: null } } : state;

const patchControl = (state, path, control) =>
  state.form
    ? { ...state, form: { ...state.form, controls: { ...state.form.controls, [path]: control } } }
    : state;

const SetText = (state, { path, value }) => patchControl(state, path, value);
const SetNumber = (state, { path, text: t, badInput }) => patchControl(state, path, { text: t, badInput });
const SetToggle = (state, { path, checked }) => patchControl(state, path, checked);

const RunRequested = (state) =>
  state.form && state.selected && !state.running ? [state, captureNumberValidityFx] : state;

// mergeNumberCapture routes a captured {path, text, badInput} to its control:
// either a direct entry, or a row control inside an array (path "<array>.<id>").
function mergeNumberCapture(controls, { path, text: t, badInput }) {
  if (path in controls) return { ...controls, [path]: { text: t, badInput } };
  const i = path.lastIndexOf(".");
  if (i < 0) return controls;
  const parent = path.slice(0, i);
  const id = Number(path.slice(i + 1));
  const rows = controls[parent];
  if (!Array.isArray(rows)) return controls;
  return {
    ...controls,
    [parent]: rows.map((row) => (row.id === id ? { ...row, control: { text: t, badInput } } : row)),
  };
}

const RunWithCapturedValidity = (state, captured) => {
  if (!state.form) return state;
  let controls = state.form.controls;
  for (const c of captured) controls = mergeNumberCapture(controls, c);
  return Run({ ...state, form: { ...state.form, controls } });
};

const Run = (state) => {
  const form = state.form;
  if (!form || !state.selected || state.running) return state;
  let args;
  if (form.jsonMode) {
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
  } else if (form.empty || !form.renderable) {
    args = {};
  } else {
    const r = collect(form.schema, form.controls);
    if (r.count > 0) {
      return [
        {
          ...state,
          form: {
            ...form,
            errors: r.errors,
            formMsg: r.count === 1 ? "1 field needs attention" : `${r.count} fields need attention`,
          },
        },
        scrollToInvalidFx,
      ];
    }
    args = r.args;
  }
  return [
    { ...state, running: true, form: { ...form, errors: {}, jsonError: null, formMsg: null } },
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

const captureNumberValidityFx = (dispatch) => {
  const captured = Array.from(document.querySelectorAll('#tool-form input[type="number"][data-path]')).map((el) => ({
    path: el.dataset.path,
    text: el.value,
    badInput: Boolean(el.validity && el.validity.badInput),
  }));
  dispatch(RunWithCapturedValidity, captured);
};

// Note: Runs after the re-render triggered by the same dispatch (hyperapp queues
// its render on the animation frame before effects get to ours).
const scrollToInvalidFx = () => {
  requestAnimationFrame(() => {
    document.querySelector(".field.invalid")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
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

const jsonView = ({ value }) =>
  h(
    "pre",
    { class: "json-block" },
    tokenizeJson(value).map((t) => (t.cls ? h("span", { class: t.cls }, text(t.text)) : text(t.text))),
  );

const blockLabel = (label) => h("div", { class: "block-label" }, text(label));

const rawBlock = ({ block, label }) => h("div", {}, [blockLabel(label), jsonView({ value: block })]);

// A clickable URL only for http(s) targets.
function safeHref(uri) {
  try {
    const u = new URL(uri, BASE_URI);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch {
    // unparseable => unsafe
  }
  return null;
}

const contentView = ({ block }) => {
  switch (block?.type) {
    case "text":
      return h("pre", { class: "text-block" }, text(block.text ?? ""));
    case "image": {
      if (typeof block.data !== "string" || block.data === "") {
        return rawBlock({ block, label: "content (image, no data)" });
      }
      return h("img", {
        class: "image-block",
        src: `data:${block.mimeType || "image/png"};base64,${block.data}`,
        alt: block.mimeType || "image content",
      });
    }
    case "audio": {
      if (typeof block.data !== "string" || block.data === "") {
        return rawBlock({ block, label: "content (audio, no data)" });
      }
      return h("audio", {
        class: "audio-block",
        controls: true,
        src: `data:${block.mimeType || "audio/wav"};base64,${block.data}`,
      });
    }
    case "resource_link": {
      const href = safeHref(block.uri);
      const label = block.title || block.name || String(block.uri);
      return h("div", { class: "resource-link" }, [
        href
          ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text(label))
          : h("span", { class: "resource-link-inert" }, text(label)),
        h("div", { class: "field-desc" }, text(block.description || String(block.uri))),
      ]);
    }
    case "resource": {
      const r = block.resource || {};
      return h("div", { class: "embedded-resource" }, [
        blockLabel(`resource ${r.uri || ""}`),
        typeof r.text === "string"
          ? h("pre", { class: "text-block" }, text(r.text))
          : typeof r.blob === "string" && (r.mimeType || "").startsWith("image/")
            ? h("img", { class: "image-block", src: `data:${r.mimeType};base64,${r.blob}`, alt: r.uri || "resource image" })
            : jsonView({ value: r }),
      ]);
    }
    default:
      return rawBlock({ block, label: `content (${block?.type ?? "unknown"})` });
  }
};

const rawPanel = ({ raw }) =>
  h("details", { class: "raw" }, [
    h("summary", {}, text("Raw request · response")),
    h("div", { class: "raw-grid" }, [
      h("div", {}, [blockLabel("request"), jsonView({ value: raw.request })]),
      h("div", {}, [
        blockLabel(
          raw.transport ? `response (${raw.transport}, HTTP ${raw.httpStatus})` : `response (HTTP ${raw.httpStatus})`,
        ),
        jsonView({ value: raw.response }),
      ]),
    ]),
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
        res.error instanceof McpError && res.error.data !== undefined
          ? h("div", {}, [blockLabel("error.data"), jsonView({ value: res.error.data })])
          : false,
      ]),
      res.raw ? rawPanel({ raw: res.raw }) : false,
    ]);
  }
  const isErr = res.kind === "toolerr";
  const result = res.result || {};
  const blocks = result.content ?? [];
  const hasStructured = "structuredContent" in result && result.structuredContent !== undefined;
  return h("article", { key: res.id, class: ["result-card", { "is-error": isErr }] }, [
    resultHead({ res, badge: isErr ? "Tool error" : "OK", badgeClass: isErr ? "badge-err" : "badge-ok" }),
    h(
      "div",
      { class: "result-body" },
      blocks.length || hasStructured
        ? [
            ...blocks.map((block) => contentView({ block })),
            hasStructured ? blockLabel("structuredContent") : false,
            hasStructured ? jsonView({ value: result.structuredContent }) : false,
          ]
        : [h("div", { class: "text-dim" }, text("(empty result)"))],
    ),
    res.raw ? rawPanel({ raw: res.raw }) : false,
  ]);
};

const formHandlers = { SetText, SetNumber, SetToggle, SetJsonText };

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
                {
                  class: ["json-toggle", { forced: form.forcedJson }],
                  title: form.forcedJson
                    ? "This schema uses constructs the form renderer doesn't cover; edit the arguments as JSON."
                    : "",
                },
                [
                  h("input", {
                    type: "checkbox",
                    id: "json-mode",
                    checked: form.jsonMode,
                    disabled: form.forcedJson,
                    onchange: (_, event) => [ToggleJsonMode, event.target.checked],
                  }),
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
                onsubmit: (state, event) => (event.preventDefault(), RunRequested),
              },
              toolForm({ form, handlers: formHandlers }),
            ),
            h("div", { id: "form-actions" }, [
              h(
                "button",
                {
                  id: "run-btn",
                  type: "button",
                  class: ["primary", { busy: running }],
                  disabled: running,
                  onclick: RunRequested,
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
