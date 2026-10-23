// Thin client for kimo-mcp (stdio MCP server, protocol 2024-11-05).
// One kimo-mcp child process per editing project, so follow-up edits land on the same project.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const KIMO_BIN = process.env.KIMO_BIN || new URL("../bin/kimo-mcp", import.meta.url).pathname;

export class KimoSession {
  constructor() {
    this.client = new Client({ name: "kimo-alexa-bridge", version: "0.1.0" });
    this.log = [];
  }
  async start() {
    this.transport = new StdioClientTransport({ command: KIMO_BIN, args: [], stderr: "ignore" });
    await this.client.connect(this.transport);
    this.serverInfo = this.client.getServerVersion();
    return this;
  }
  // kimo groups its ~420 actions into 14 group tools: call(group, action, args)
  async call(group, action, args = {}) {
    const t0 = Date.now();
    const res = await this.client.callTool(
      { name: group, arguments: { action, args } },
      undefined,
      { timeout: 15 * 60 * 1000, resetTimeoutOnProgress: true }
    );
    const text = (res.content || []).map((c) => c.text || "").join("");
    let data;
    try { data = JSON.parse(text); } catch { data = { text }; }
    this.log.push({ group, action, args, ms: Date.now() - t0, isError: !!res.isError });
    if (res.isError) throw new Error(`kimo ${group}.${action} failed: ${text.slice(0, 400)}`);
    return data;
  }
  async rawTool(name, args) {
    return this.client.callTool({ name, arguments: args }, undefined, { timeout: 15 * 60 * 1000 });
  }
  async close() { try { await this.client.close(); } catch {} }
}
