import test from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINT, FeedClient, freshness, parseArgs, readReply } from './client.mjs';

const reply = (id, result, headers = {}) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
  headers: { 'Content-Type': 'application/json', ...headers },
});

test('handshake propagates negotiated protocol and session; lists free tools', async () => {
  const calls = [];
  const client = new FeedClient(async (url, options) => {
    const message = JSON.parse(options.body);
    calls.push({ url, options, message });
    if (message.method === 'initialize') return reply(message.id, {
      protocolVersion: '2025-03-26', serverInfo: { name: 'fixture' },
    }, { 'Mcp-Session-Id': 'test-session' });
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return reply(message.id, { tools: [] });
  });
  assert.deepEqual(await client.connect(), { name: 'fixture' });
  assert.deepEqual(await client.request('tools/list'), { tools: [] });
  assert.deepEqual(calls.map(c => c.message.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.ok(calls.every(c => c.url === ENDPOINT && c.options.redirect === 'error'));
  assert.equal(calls[1].options.headers['Mcp-Session-Id'], 'test-session');
  assert.equal(calls[1].options.headers['MCP-Protocol-Version'], '2025-03-26');
  assert.equal(Object.hasOwn(calls[1].message, 'id'), false);
});

test('stateless server and all four tool names work without a session header', async () => {
  const calls = [];
  const client = new FeedClient(async (_url, options) => {
    const message = JSON.parse(options.body);
    calls.push(message);
    if (message.method === 'initialize') return reply(message.id, { protocolVersion: '2025-03-26', serverInfo: {} });
    if (!message.id) return new Response(null, { status: 202 });
    return reply(message.id, { content: [{ type: 'text', text: JSON.stringify({ name: message.params.name, count: 0 }) }] });
  });
  await client.connect();
  for (const name of ['list_bounties', 'get_feed_stats', 'get_bounty', 'get_new_bounties']) {
    assert.deepEqual(await client.call(name), { name, count: 0 });
  }
  assert.equal(client.headers['Mcp-Session-Id'], undefined);
  assert.equal(calls.length, 6);
});

test('structuredContent is returned without assuming a text wrapper', async () => {
  const client = new FeedClient(async (_url, options) => reply(JSON.parse(options.body).id, { structuredContent: { count: 2 } }));
  assert.deepEqual(await client.call('list_bounties'), { count: 2 });
});

test('SSE handles chunks, CRLF, notifications, multiline data and a connection left open', async () => {
  let cancelled = false;
  const message = ': heartbeat\r\n\r\ndata: {"jsonrpc":"2.0","method":"notification"}\r\n\r\n'
    + 'event: message\r\ndata: {"jsonrpc":"2.0","id":7,\r\ndata: "result":{"title":"café"}}\r\n\r\n';
  const bytes = new TextEncoder().encode(message);
  const body = new ReadableStream({
    start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); },
    cancel() { cancelled = true; },
  });
  assert.deepEqual(await readReply(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), 7), { title: 'café' });
  assert.equal(cancelled, true);
});

test('an SSE stream ending without our response fails', async () => {
  const response = new Response('data: {"jsonrpc":"2.0","id":99,"result":{}}\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
  await assert.rejects(readReply(response, 1), /closed before/);
});

test('HTTP, RPC, wrong IDs and invalid JSON do not become empty successful feeds', async () => {
  const cases = [
    [new Response('', { status: 402 }), /HTTP 402/],
    [new Response('', { status: 503 }), /HTTP 503/],
    [new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid arguments' } })), /invalid arguments/],
    [reply(2, {}), /mismatched/],
    [new Response('{"jsonrpc":"2.0","id":1}'), /result is missing/],
    [new Response('not JSON'), /JSON/],
  ];
  for (const [response, pattern] of cases) await assert.rejects(readReply(response, 1), pattern);
});

test('tool errors stay errors and unknown tools make no requests', async () => {
  let requests = 0;
  const client = new FeedClient(async (_url, options) => {
    requests++;
    return reply(JSON.parse(options.body).id, { isError: true, content: [{ type: 'text', text: 'not found' }] });
  });
  await assert.rejects(client.call('pay'), /Only the four free/);
  assert.equal(requests, 0);
  await assert.rejects(client.call('get_bounty', { id: 'missing' }), /tool failed/);
});

test('unsupported protocol and failed initialization notification stop the handshake', async () => {
  for (const protocol of ['unsupported', '2025-03-26']) {
    const client = new FeedClient(async (_url, options) => {
      const message = JSON.parse(options.body);
      return message.id ? reply(message.id, { protocolVersion: protocol }) : new Response(null, { status: 403 });
    });
    await assert.rejects(client.connect(), protocol === 'unsupported' ? /Unsupported MCP protocol/ : /HTTP 403/);
  }
});

test('CLI rejects malformed input before connecting and preserves server filter arguments', () => {
  assert.deepEqual(parseArgs([]), { command: 'list', args: {} });
  const filters = { source: 'direct', limit: 5, exclude_requires: 'stake,purchase' };
  assert.deepEqual(parseArgs(['list', JSON.stringify(filters)]), { command: 'list', args: filters });
  assert.deepEqual(parseArgs(['get', '{"id":"direct:example"}']).args, { id: 'direct:example' });
  for (const args of [['pay'], ['constructor'], ['list', 'null'], ['list', '[]'], ['list', '{'],
    ['get'], ['new', '{"since":"nonsense"}'], ['list', '{"limit":0}'], ['list', '{"limit":101}'],
    ['list', '{"limit":1.5}'], ['tools', '{"id":"x"}'], ['list', '{}', 'extra']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('download time does not make an old feed fresh; absent dates remain unknown', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  assert.deepEqual(freshness({ generated_at: '2026-10-30T00:00:00Z' }, now), {
    feed_age_minutes: 720, older_than_six_hours: true,
  });
  assert.equal(freshness({ generated_at: '2026-10-30T11:00:00Z' }, now).older_than_six_hours, false);
  assert.equal(freshness({ generated_at: '2026-10-30T06:00:00Z' }, now).older_than_six_hours, false);
  assert.equal(freshness({ generated_at: '2026-10-30T05:59:59Z' }, now).older_than_six_hours, true);
  assert.deepEqual(freshness({}, now), { feed_age_minutes: null, older_than_six_hours: null });
});

test('argument files avoid native-shell JSON quoting and still validate before connecting', () => {
  const path = new URL('./filters.json', import.meta.url);
  assert.deepEqual(parseArgs(['list', '--args-file', path]), {
    command: 'list', args: { limit: 5, exclude_requires: 'kyc,stake,bond,purchase,human_only' },
  });
  assert.throws(() => parseArgs(['list', '--args-file']));
  assert.throws(() => parseArgs(['list', '--args-file', 'file-that-does-not-exist.json']));
  assert.throws(() => parseArgs(['list', '--args-file', path, 'extra']));
});
