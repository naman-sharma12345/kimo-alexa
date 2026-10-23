// Minimal browser MCP client for Streamable HTTP (protocol 2025-11-25).
// POSTs JSON-RPC to one endpoint, keeps Mcp-Session-Id, sends MCP-Protocol-Version,
// and reads either a JSON body or an SSE stream (progress notifications arrive on it).
export class McpHttpClient {
  constructor(url, protocolVersion = "2025-11-25") {
    this.url = url; this.protocolVersion = protocolVersion; this.sessionId = null; this.nextId = 1;
  }
  headers() {
    const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (this.sessionId) { h["Mcp-Session-Id"] = this.sessionId; h["MCP-Protocol-Version"] = this.protocolVersion; }
    return h;
  }
  async post(msg, onMessage) {
    const res = await fetch(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify(msg) });
    const sid = res.headers.get("mcp-session-id"); if (sid) this.sessionId = sid;
    if (res.status === 202) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const type = res.headers.get("content-type") || "";
    if (type.includes("application/json")) return res.json();
    // text/event-stream: read events until the response for our id arrives
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (!data) continue;
        const m = JSON.parse(data);
        if (m.id === msg.id && ("result" in m || "error" in m)) { reader.cancel().catch(() => {}); return m; }
        onMessage?.(m);
      }
    }
    throw new Error("stream ended without a response");
  }
  async request(method, params, onMessage) {
    const m = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params }, onMessage);
    if (m.error) throw new Error(m.error.message);
    return m.result;
  }
  async connect(clientInfo = { name: "alexa-plus-sim", version: "0.1.0" }) {
    const r = await this.request("initialize", { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo });
    this.serverInfo = r.serverInfo; this.negotiated = r.protocolVersion; this.protocolVersion = r.protocolVersion;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return r;
  }
  listTools() { return this.request("tools/list", {}); }
  async callTool(name, args, onProgress) {
    const token = `p${this.nextId}`;
    const r = await this.request("tools/call", { name, arguments: args, _meta: { progressToken: token } },
      (m) => { if (m.method === "notifications/progress" && m.params?.progressToken === token) onProgress?.(m.params); });
    if (r.isError) throw new Error(r.content?.map((c) => c.text).join(" ") || "tool error");
    return r.structuredContent ?? JSON.parse(r.content?.[0]?.text || "{}");
  }
}
