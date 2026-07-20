// Minimal MCP streamable-HTTP client for the console UI.
//
// NOTE: Speaks protocol 2025-06-18 (tolerating servers that negotiate older
// versions) against any spec-compliant server.

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "mcpconsole", version: "0.1.0" };

export class McpError extends Error {
  constructor(code, message, data, raw) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.data = data;
    this.raw = raw;
  }
}

export class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}${body ? `: ${truncate(body.trim(), 300)}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function mediaType(res) {
  return (res.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
}

// Yield the data payload of each event in an SSE stream.
async function* sseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let data = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length) {
            yield data.join("\n");
            data = [];
          }
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
        // event:/id:/retry: fields and comments are irrelevant here.
      }
    }
    if (data.length) yield data.join("\n");
  } finally {
    reader.releaseLock();
  }
}

export class McpClient {
  #nextId = 0;

  constructor({ endpoint, onNotification, onStatus } = {}) {
    this.endpoint = new URL(endpoint, document.baseURI).toString();
    this.onNotification = onNotification;
    this.onStatus = onStatus;
    this.sessionId = null;
    this.protocolVersion = null;
    this.serverInfo = null;
    this.serverCapabilities = null;
  }

  async connect() {
    this.onStatus?.("connecting");
    try {
      const result = await this.#initialize();
      await this.#notify("notifications/initialized");
      this.onStatus?.("connected");
      return result;
    } catch (err) {
      this.onStatus?.("error", String(err.message || err));
      throw err;
    }
  }

  async listTools() {
    const tools = [];
    let cursor = null;
    do {
      const { result } = await this.#rpc("tools/list", cursor ? { cursor } : {});
      tools.push(...(result?.tools ?? []));
      cursor = result?.nextCursor || null;
    } while (cursor);
    return tools;
  }

  callTool(name, args) {
    return this.#rpc("tools/call", { name, arguments: args });
  }

  #headers(extra = {}) {
    const h = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...extra,
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    if (this.protocolVersion) h["MCP-Protocol-Version"] = this.protocolVersion;
    return h;
  }

  async #initialize() {
    this.sessionId = null;
    this.protocolVersion = null;
    const id = ++this.#nextId;
    const request = {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {}, // no sampling, elicitation, or roots.
        clientInfo: CLIENT_INFO,
      },
    };
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(request),
      signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(15000) : undefined,
    });
    if (!res.ok) throw new HttpError(res.status, await safeText(res));
    this.sessionId = res.headers.get("Mcp-Session-Id"); // may be empty for stateless servers
    const reply = await this.#readReply(res, id, []);
    if (reply.error) {
      throw new McpError(reply.error.code, reply.error.message, reply.error.data);
    }
    const result = reply.result || {};
    this.protocolVersion = result.protocolVersion || PROTOCOL_VERSION;
    this.serverInfo = result.serverInfo || null;
    this.serverCapabilities = result.capabilities || {};
    return result;
  }

  async #notify(method, params) {
    const body = { jsonrpc: "2.0", method };
    if (params !== undefined) body.params = params;
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok && res.status !== 202 && res.status !== 204) {
      throw new HttpError(res.status, await safeText(res));
    }
    await safeText(res); // drain the (empty) body so the browser closes cleanly
  }

  async #rpc(method, params) {
    const id = ++this.#nextId;
    const request = { jsonrpc: "2.0", id, method, params };
    const raw = { request, response: null, httpStatus: null, transport: null };
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(request),
    });
    raw.httpStatus = res.status;
    if (!res.ok) {
      const text = await safeText(res);
      const err = new HttpError(res.status, text);
      err.raw = { ...raw, response: text || null };
      throw err;
    }
    const messages = [];
    let reply;
    try {
      reply = await this.#readReply(res, id, messages);
    } finally {
      raw.response = messages.length === 1 ? messages[0] : messages;
      raw.transport = mediaType(res);
    }
    if (reply.error) {
      throw new McpError(reply.error.code, reply.error.message, reply.error.data, raw);
    }
    return { result: reply.result, raw };
  }

  async #readReply(res, id, sink) {
    const ct = mediaType(res);
    if (ct === "application/json") {
      const parsed = await res.json();
      const list = Array.isArray(parsed) ? parsed : [parsed];
      sink.push(...list);
      let found = null;
      for (const msg of list) {
        if (!found && this.#isReplyTo(msg, id)) found = msg;
        else this.#dispatch(msg);
      }
      if (!found) throw new Error(`no response for request ${id} in JSON body`);
      return found;
    }
    if (ct === "text/event-stream") {
      let found = null;
      for await (const data of sseEvents(res.body)) {
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          continue; // tolerate non-JSON keepalives
        }
        sink.push(msg);
        if (!found && this.#isReplyTo(msg, id)) {
          found = msg;
          // The reply is what we came for. The SDK closes the stream here
          // anyway; breaking also protects against servers that hold the POST
          // stream open indefinitely.
          break;
        }
        this.#dispatch(msg);
      }
      if (found) {
        await res.body.cancel().catch(() => {});
        return found;
      }
      throw new Error(`response stream ended without a reply to request ${id}`);
    }
    throw new Error(`unexpected response content type "${ct || "none"}"`);
  }

  #isReplyTo(msg, id) {
    return !msg.method && msg.id !== undefined && String(msg.id) === String(id);
  }

  #dispatch(msg) {
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      // Decline (we declared no capabilities!)
      fetch(this.endpoint, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "mcpconsole declares no client capabilities" },
        }),
      }).catch(() => {});
      return;
    }
    if (msg.method) this.onNotification?.(msg);
  }
}
