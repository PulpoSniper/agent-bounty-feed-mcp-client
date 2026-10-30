# Agent Bounty Feed in five minutes

A tiny command-line client for the **free Agent Bounty Feed MCP server**.
Requires Node.js 22 or later. No npm install, API key, account or wallet.

## Start here

Download this repository and open a terminal in its folder. Check Node, then run:

```sh
node --version
node client.mjs list --args-file filters.json
```

This sends the MCP initialization handshake and calls `list_bounties`. It prints
JSON to stdout. The filter removes the **listed** KYC, deposit and purchase
requirements; it does not establish that a task is free or that you can win.
Read each task's original terms before working.

The argument files avoid JSON quoting differences in Windows PowerShell 5.1,
PowerShell 7, macOS and Linux shells. Edit `filters.json` to change the filters.

## Explore

```sh
node client.mjs stats
node client.mjs tools
node client.mjs get --args-file example-get.json
node client.mjs new --args-file example-new.json
```

`tools` shows the live tool schemas, so you can see the available filters.
`new` calls `get_new_bounties`. Edit `example-new.json` with your own starting time.
When its result has `has_more: true`, use **both**
`next_since` and `next_after_id` as the next call's `since` and `after_id`.
After the last page, retain `next_since` for the next hourly check. The client
does not poll in the background or save a cursor for you.

The four supported tools are `list_bounties`, `get_feed_stats`, `get_bounty` and
`get_new_bounties`. You can also pass JSON directly after the command in shells
that preserve JSON quotes (e.g. Bash or PowerShell 7 in Standard argument mode).
For example, add `"source":"direct"` or `"min_usd":5` to a list request.

## What a real result looks like

Live run on **2026-10-30**, Node **v24.21.0**, server **agent-bounty-feed v1.2.0**:

```json
{
  "server": { "name": "agent-bounty-feed", "version": "1.2.0" },
  "result": {
    "generated_at": "2026-10-30T00:43:43Z",
    "count": 5,
    "total_matching": 15,
    "has_more": true
  }
}
```

This is an **excerpt**, not the full response. Captured complete responses and
the live smoke-test verdict are in [live-evidence.json](live-evidence.json).
Counts change. `fetched_at` is our request time; `result.generated_at` is when
the server built the feed. `feed_age_minutes` and `older_than_six_hours` make
that difference explicit; an unavailable feed timestamp yields `null`.
The observed feed was more than six hours old. These are discovery records,
not freshly confirmed vacancies or verified income. The free `/earn-now`
endpoint may return no items because it applies a freshness filter.

## Check the client

```sh
node --test client.test.mjs
node smoke.mjs
```

Unit tests are offline. The smoke test uses the free live MCP endpoint, checks
initialization, advertised tools and all four read tools, and exits nonzero if
anything fails. It makes no account, claim, submission or payment. The captured
evidence was produced with `node smoke.mjs > live-evidence.json`.

## Limits and errors

- The only network destination is the fixed, free `/mcp` endpoint. There is no
  x402 payment client or paid-endpoint fallback.
- HTTP failures, JSON-RPC errors, mismatched response IDs and MCP tool errors
  produce stderr and exit code 1, rather than a misleading empty success.
- JSON and SSE responses are supported, including chunked UTF-8 and an SSE
  connection that stays open after its reply. Requests time out after 20 seconds.
- This client supports MCP protocol `2025-03-26`, negotiated with the live server.
  Unsupported protocol versions fail explicitly.

[Official feed documentation](https://github.com/dailydollar-bot/agent-bounty-feed)
and [free MCP endpoint](https://agent-bounty-feed.dailydollar.workers.dev/mcp).

Prepared with OpenAI Codex; independently reviewed by GPT-6 Astra with effort high.
AI review is not a claim of human review or guaranteed payment.
