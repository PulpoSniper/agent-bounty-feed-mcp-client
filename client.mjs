#!/usr/bin/env node
// Free Agent Bounty Feed MCP client. Node 22+, no packages or credentials.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

export const ENDPOINT = 'https://agent-bounty-feed.dailydollar.workers.dev/mcp';
const PROTOCOL = '2025-03-26';
const TOOLS = { list: 'list_bounties', stats: 'get_feed_stats', get: 'get_bounty', new: 'get_new_bounties' };
const USAGE = 'Usage: node client.mjs [list|stats|get|new|tools] [JSON arguments]\n       node client.mjs COMMAND --args-file arguments.json\nExample: node client.mjs list --args-file filters.json';

function unwrap(packet, id) {
  if (packet?.jsonrpc !== '2.0' || packet.id !== id) throw new Error('Invalid or mismatched JSON-RPC response');
  if (packet.error) throw new Error(`MCP ${packet.error.code}: ${packet.error.message}`);
  if (!Object.hasOwn(packet, 'result')) throw new Error('JSON-RPC result is missing');
  return packet.result;
}

export async function readReply(response, id) {
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}; no paid fallback is attempted`);
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return unwrap(await response.json(), id);
  // Return as soon as our reply arrives; an SSE connection need not close.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop();
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        const packet = JSON.parse(data);
        if (packet.id === id) return unwrap(packet, id);
      }
      if (buffer.length > 2_000_000) throw new Error('MCP event exceeds the client limit');
      if (done) throw new Error('SSE closed before the matching JSON-RPC reply');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class FeedClient {
  constructor(fetchImpl = fetch) {
    this.fetch = fetchImpl;
    this.nextId = 1;
    this.headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  }
  async post(message) {
    return this.fetch(ENDPOINT, {
      method: 'POST', headers: { ...this.headers }, body: JSON.stringify(message),
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
  }
  async request(method, params = {}) {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: '2.0', id, method, params });
    if (method === 'initialize' && response.headers.has('mcp-session-id')) {
      this.headers['Mcp-Session-Id'] = response.headers.get('mcp-session-id');
    }
    return readReply(response, id);
  }
  async connect() {
    const info = await this.request('initialize', {
      protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'abf-free-client', version: '1.0.0' },
    });
    if (info.protocolVersion !== PROTOCOL) throw new Error(`Unsupported MCP protocol: ${info.protocolVersion}`);
    this.headers['MCP-Protocol-Version'] = info.protocolVersion;
    const response = await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`MCP initialized notification: HTTP ${response.status}`);
    return info.serverInfo;
  }
  async call(name, args = {}) {
    if (!Object.values(TOOLS).includes(name)) throw new Error('Only the four free read tools are supported');
    const result = await this.request('tools/call', { name, arguments: args });
    if (result?.isError) throw new Error(`MCP tool failed: ${JSON.stringify(result.content)}`);
    if (result?.structuredContent !== undefined) return result.structuredContent;
    const texts = result?.content?.filter(item => item.type === 'text').map(item => item.text) ?? [];
    if (texts.length !== 1) throw new Error('Expected one JSON text result from Agent Bounty Feed');
    return JSON.parse(texts[0]);
  }
}

export function parseArgs(argv) {
  const command = argv[0] ?? 'list';
  if (!(command === 'tools' || Object.hasOwn(TOOLS, command))) throw new Error(USAGE);
  let json = '{}';
  if (argv[1] === '--args-file') {
    if (argv.length !== 3 || !argv[2]) throw new Error(USAGE);
    json = readFileSync(argv[2], 'utf8');
  } else {
    if (argv.length > 2) throw new Error(USAGE);
    json = argv[1] ?? '{}';
  }
  const args = JSON.parse(json);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be a JSON object');
  if (command === 'tools' && Object.keys(args).length) throw new Error('tools takes no arguments');
  if (command === 'get' && (typeof args.id !== 'string' || !args.id)) throw new Error('get requires {"id":"source:id"}');
  if (command === 'new' && (typeof args.since !== 'string' || !Number.isFinite(Date.parse(args.since)))) {
    throw new Error('new requires {"since":"ISO-8601 timestamp"}');
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) {
    throw new Error('limit must be an integer from 1 to 100');
  }
  return { command, args };
}

export function freshness(result, now = Date.now()) {
  const generated = Date.parse(result?.generated_at);
  if (!Number.isFinite(generated)) return { feed_age_minutes: null, older_than_six_hours: null };
  const minutes = Math.floor((now - generated) / 60_000);
  return { feed_age_minutes: minutes, older_than_six_hours: now - generated > 6 * 60 * 60 * 1000 };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { console.log(USAGE); return; }
  const { command, args } = parseArgs(argv); // Invalid input makes no requests.
  const client = new FeedClient();
  const server = await client.connect();
  const result = command === 'tools' ? await client.request('tools/list') : await client.call(TOOLS[command], args);
  console.log(JSON.stringify({ fetched_at: new Date().toISOString(), server, ...freshness(result), result }, null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}
