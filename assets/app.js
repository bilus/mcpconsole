import { app, h, text } from "./hyperapp.js";
import { McpClient } from "./mcp.js";

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
};

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

const ToolsOk = (state, tools) => ({ ...state, tools, toolsSpinning: false, connectError: null });

const ToolsFailed = (state, message) => ({ ...state, toolsSpinning: false, connectError: message });

const GotNotification = (state, msg) =>
  msg.method === "notifications/tools/list_changed" ? [state, debouncedRefreshFx] : state;

const SelectTool = (state, tool) => ({ ...state, selected: tool });

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
    h("main", { id: "main" }, [emptyState({ visible: true })]),
  ]);

app({
  init: [initialState, connectFx],
  view: rootView,
  node: document.getElementById("app"),
});
