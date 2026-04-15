# Nuggets Memory Pro

> HRR-powered persistent memory for AI agents — free local memory plus Pro cloud sync, determinism guardrails, and team sharing.

Built as a production-grade extension of [NeoVertex1/nuggets](https://github.com/NeoVertex1/nuggets), fully backward-compatible with the original free plugin.

---

## What is HRR?

**Holographic Reduced Representation** (Plate, 1995) encodes associations as fixed-width vectors using circular convolution. Every memory is a 512-dimensional float vector that can be:

- **Bound** to a key: `memory = bind(keyVec, valueVec)`
- **Probed** for retrieval: `value ≈ probe(memory, keyVec)`
- **Superposed** with other memories without collision

This means memories are math — deterministic, compact, and structurally composable.

---

## Tiers

| Feature | Free | Individual ($9/mo) | Team ($29/mo) |
|---|:---:|:---:|:---:|
| Local HRR memory store | ✓ | ✓ | ✓ |
| `remember`, `recall`, `search`, `forget`, `list` | ✓ | ✓ | ✓ |
| Memory anchor (drift detection) | ✓ | ✓ | ✓ |
| Structured output schemas | ✓ | ✓ | ✓ |
| Cloud sync (multi-device) | | ✓ | ✓ |
| Audit logs (persistent) | | ✓ (30 days) | ✓ (1 year) |
| Determinism guardrails | | ✓ | ✓ |
| Proactive nudge scheduling | | | ✓ |
| Shared team memory | | | ✓ |
| Priority support | | ✓ | ✓ |

---

## Installation

### Global CLI (recommended)

```bash
npm install -g nuggets-memory-pro
```

### Local project

```bash
npm install nuggets-memory-pro
```

---

## Quick Start

### 1. Add to Claude / MCP client

Copy `.mcp.json` to your project root, or add this block to your existing `.mcp.json`:

```json
{
  "mcpServers": {
    "nuggets-memory-pro": {
      "command": "node",
      "args": ["node_modules/nuggets-memory-pro/dist/mcp/server.js"]
    }
  }
}
```

For a global install:

```json
{
  "mcpServers": {
    "nuggets-memory-pro": {
      "command": "nuggets-memory-pro-server"
    }
  }
}
```

### 2. Free tier — works immediately

No sign-up needed. Memories are stored locally at `~/.nuggets-memory-pro/store.json`.

```
Agent: memory_remember { key: "project_goal", value: "Ship v2 by end of quarter" }
Agent: memory_recall   { key: "project_goal" }
Agent: memory_search   { query: "quarterly deadline" }
```

---

## CLI Commands

```
nuggets-memory-pro login              Authenticate (required for Pro features)
nuggets-memory-pro upgrade [--plan]   Start Stripe checkout ($9 or $29/mo)
nuggets-memory-pro status             Show tier, memory stats, anchor hash
nuggets-memory-pro sync               Sync local memory with cloud (Pro)
nuggets-memory-pro audit [--limit N]  Show audit log (Pro)
nuggets-memory-pro nudges             Show proactive nudge queue (Pro)
nuggets-memory-pro billing            Manage Stripe subscription (Pro)
nuggets-memory-pro logout             Clear saved credentials
```

---

## MCP Tools Reference

### Free Tier

#### `memory_remember`
Store a key→value association in the HRR memory store.
```json
{ "key": "api_key_name", "value": "the secret value", "priority": 1, "tags": ["secrets"] }
```

#### `memory_recall`
Retrieve memories associated with a key.
```json
{ "key": "api_key_name", "topK": 5 }
```

#### `memory_search`
Semantic similarity search across all stored memories.
```json
{ "query": "authentication credentials", "topK": 10, "tag": "secrets" }
```

#### `memory_forget`
Delete a memory slot by id or label.
```json
{ "id": "api_key_name" }
```

#### `memory_list`
List all memory slots with optional filters.
```json
{ "tag": "deadline", "priority": 2 }
```

#### `memory_status`
Show store stats, anchor hash, and current tier. No input required.

---

### Pro Tier

#### `memory_sync` (Individual + Team)
Bidirectional sync of local memory with cloud. Enables multi-device and team sharing.

#### `memory_audit` (Individual + Team)
```json
{ "limit": 100, "op": "remember" }
```
Returns recent audit events from the persistent log.

#### `memory_nudges` (Team)
Returns the proactive nudge queue — high-priority memories due for agent review.

#### `memory_set_rule` (Team)
```json
{
  "label": "Remind me of deadlines every 2 hours",
  "tag": "deadline",
  "intervalMs": 7200000
}
```

#### `memory_anchor` (Individual + Team)
```json
{ "compareWith": "a1b2c3d4e5f6g7h8" }
```
Verify the current HRR state anchor and detect memory drift between agent turns.

---

## Determinism Guardrails

Every Pro tool call is wrapped in three layers of verification:

1. **State anchoring** — An 8-byte fingerprint of the memory vector is captured before and after each write. Drift triggers an audit event and (optionally) a rollback.

2. **Structured output schemas** — All tool results are validated with Zod before being returned. Schema mismatches are typed `GuardrailError`s, never silent failures.

3. **Verification loops** — Critical writes retry up to 3 times, checking the anchor stabilises between attempts. Non-deterministic states are surfaced as `MAX_RETRIES_EXCEEDED` errors.

---

## Library Usage

```typescript
import { MemoryStore, bind, tokenVector, stateAnchor } from 'nuggets-memory-pro';

const store = new MemoryStore();

// Store a memory
store.remember('sprint_goal', 'Finish auth module');

// Recall by key
const results = store.recall('sprint_goal');
console.log(results[0].slot.label, results[0].similarity);

// Low-level HRR
const keyVec = tokenVector('my_key');
const valVec = tokenVector('my_value');
const bound  = bind(keyVec, valVec);
console.log('Anchor:', stateAnchor(bound));
```

---

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Default | Description |
|---|---|---|
| `NUGGETS_STORE_PATH` | `~/.nuggets-memory-pro/store.json` | Local memory store |
| `NUGGETS_API_BASE` | `https://api.nuggets-memory.pro` | Pro backend URL |
| `STRIPE_SECRET_KEY` | — | Required if self-hosting payments |
| `STRIPE_PRICE_INDIVIDUAL` | — | Stripe Price ID for $9/mo |
| `STRIPE_PRICE_TEAM` | — | Stripe Price ID for $29/mo |

---

## Self-Hosting

The backend protocol is open. Any server that implements these three endpoints can replace the hosted API:

```
POST /v1/sync/push     { store: StoreExport }  →  { ok: true, serverTs: number }
GET  /v1/sync/pull                             →  StoreExport
GET  /v1/sync/status                           →  { lastSync, slotCount }
POST /v1/checkout/session                      →  { sessionId, url, pollToken }
GET  /v1/checkout/poll?token=...               →  { status, apiKey?, tier? }
POST /v1/billing/portal                        →  { url }
```

Point `NUGGETS_API_BASE` to your server.

---

## License

MIT — free tier source is open. Pro features are source-available in this repo.

---

*Built by Omar Jackson — [LinkedIn](https://www.linkedin.com/in/omar-j-b0a458361)*
