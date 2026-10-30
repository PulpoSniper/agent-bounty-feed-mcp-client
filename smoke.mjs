// Live read-only verification. Run from the repository folder with Node 22+.
import assert from 'node:assert/strict';
import { FeedClient, freshness } from './client.mjs';

const evidence = { checked_at: new Date().toISOString(), node: process.version, checks: [], responses: {} };
try {
  const client = new FeedClient();
  evidence.server = await client.connect();
  assert.equal(evidence.server.name, 'agent-bounty-feed');
  evidence.checks.push('initialize and initialized notification accepted');
  const advertised = await client.request('tools/list');
  const names = advertised.tools.map(t => t.name);
  for (const name of ['list_bounties', 'get_feed_stats', 'get_bounty', 'get_new_bounties']) assert.ok(names.includes(name));
  evidence.checks.push('all four free tools advertised');
  const list = await client.call('list_bounties', { limit: 5, exclude_requires: 'kyc,stake,bond,purchase,human_only' });
  assert.ok(Array.isArray(list.items));
  assert.equal(list.items.length, list.count);
  evidence.responses.list = list;
  evidence.freshness = freshness(list);
  evidence.checks.push('list_bounties returns a well-formed list');
  const stats = await client.call('get_feed_stats');
  assert.ok(stats && typeof stats === 'object' && !Array.isArray(stats));
  evidence.responses.stats = stats;
  evidence.checks.push('get_feed_stats returns data');
  const item = list.items[0];
  if (!item) throw new Error('Cannot verify get_bounty: the filtered feed contains no item');
  const detail = await client.call('get_bounty', { id: item.id });
  assert.equal(detail.item?.id, item.id);
  evidence.responses.get = detail;
  evidence.checks.push('get_bounty resolves an ID from the current list');
  const recent = await client.call('get_new_bounties', { since: '2026-10-29T00:00:00Z', limit: 10 });
  assert.ok(Array.isArray(recent.items));
  assert.equal(typeof recent.has_more, 'boolean');
  evidence.responses.new = recent;
  evidence.checks.push('get_new_bounties returns items and pagination state');
  evidence.ok = true;
} catch (error) {
  evidence.ok = false;
  evidence.error = error.message;
  process.exitCode = 1;
}
console.log(JSON.stringify(evidence, null, 2));
