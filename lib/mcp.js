import { spawn } from 'node:child_process';

/**
 * 极简 MCP（Model Context Protocol）stdio 客户端。
 * 只支持 stdio 传输（npx / 本地命令），SSE/HTTP 后续再补。
 * 协议：newline-delimited JSON-RPC。
 */
class McpStdioClient {
  constructor(id, name, command) {
    this.id = id;
    this.name = name;
    this.command = command; // 完整启动命令，如 "npx -y @modelcontextprotocol/server-filesystem /tmp"
  }

  async start() {
    const parts = this.command.trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.proc.stdout.on('data', (chunk) => this._onData(chunk.toString()));
    this.proc.stderr.on('data', () => {}); // 忽略 stderr
    this.proc.on('error', (e) => this._failAll(e));

    await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'bunny-home', version: '1.0.0' },
    });
    this._notify('notifications/initialized', {});
    return this;
  }

  _onData(s) {
    this.buf += s;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
        else resolve(msg.result);
      }
    }
  }

  _send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  _notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  _failAll(e) {
    for (const [, p] of this.pending) p.reject(e);
    this.pending.clear();
  }

  async listTools() {
    const result = await this._request('tools/list', {});
    return (result?.tools || []).map((t) => ({
      serverId: this.id,
      serverName: this.name,
      name: t.name,
      description: t.description || '',
      parameters: t.inputSchema || { type: 'object', properties: {} },
    }));
  }

  async callTool(name, args) {
    const result = await this._request('tools/call', { name, arguments: args || {} });
    const parts = (result?.content || [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text);
    return parts.join('\n') || (result?.isError ? '调用出错' : '(空结果)');
  }

  close() {
    try { this.proc?.kill(); } catch {}
  }
}

// 会话级：spawn 所有配置的服务器，聚合工具
export class McpSession {
  constructor(servers) {
    this.servers = servers;
    this.clients = [];
    this.tools = [];
  }

  async start() {
    for (const s of this.servers) {
      try {
        const c = new McpStdioClient(s.id, s.name, s.command);
        await c.start();
        this.clients.push(c);
        this.tools.push(...(await c.listTools()));
      } catch (e) {
        console.warn('[mcp] 服务器启动失败:', s.name, e.message);
      }
    }
    return this;
  }

  async callTool(name, args) {
    for (const c of this.clients) {
      if (this.tools.some((t) => t.serverId === c.id && t.name === name)) {
        return c.callTool(name, args);
      }
    }
    return '未找到该工具';
  }

  async close() {
    for (const c of this.clients) c.close();
  }
}

// 解析 app_settings 里存的 mcp_servers（JSON 字符串或数组）
export function parseMcpServers(raw) {
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr.filter((s) => s && s.command) : [];
  } catch {
    return [];
  }
}
