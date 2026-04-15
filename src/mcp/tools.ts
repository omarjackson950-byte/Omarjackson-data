/**
 * nuggets-memory-pro — MCP Tool Definitions
 *
 * Defines all tools exposed to AI agents via the Model Context Protocol.
 * Free tools work without authentication.
 * Pro tools check the license and return a descriptive upgrade prompt
 * if the user is on the free tier.
 *
 * Tool catalogue:
 *
 *  FREE TIER
 *  ─────────
 *  memory_remember    Store a key→value memory in local HRR store
 *  memory_recall      Retrieve memories by key
 *  memory_search      Semantic similarity search over stored memories
 *  memory_forget      Delete a memory slot
 *  memory_list        List all stored memories (with optional filters)
 *  memory_status      Show store stats and current anchor hash
 *
 *  PRO TIER (individual + team)
 *  ─────────────────────────────
 *  memory_sync        Bidirectional cloud sync
 *  memory_audit       Retrieve recent audit events
 *  memory_nudges      Get proactive nudge queue
 *  memory_set_rule    Add/update a nudge rule
 *  memory_anchor      Verify/compare state anchors
 */

import { z } from 'zod';
import { getStore } from '../nuggets/memory.js';
import { getAuditLog } from '../nuggets/audit.js';
import { getAuth } from '../pro/auth.js';
import { wrapResult, wrapError } from '../pro/guardrails.js';
import { CloudSync } from '../pro/cloud.js';
import { NudgeScheduler } from '../pro/nudge.js';

// ─── Tool input schemas ───────────────────────────────────────────────────────

export const RememberInputSchema = z.object({
  key: z.string().min(1).describe('Unique label for this memory'),
  value: z.string().min(1).describe('The content to remember'),
  priority: z.number().min(0).max(2).optional().describe('0=normal, 1=high, 2=critical'),
  tags: z.array(z.string()).optional().describe('Tags for filtering and nudge rules'),
});

export const RecallInputSchema = z.object({
  key: z.string().min(1).describe('The key to recall'),
  topK: z.number().min(1).max(20).optional().default(5).describe('Max results'),
});

export const SearchInputSchema = z.object({
  query: z.string().min(1).describe('Semantic query string'),
  topK: z.number().min(1).max(20).optional().default(5).describe('Max results'),
  tag: z.string().optional().describe('Filter by tag'),
});

export const ForgetInputSchema = z.object({
  id: z.string().min(1).describe('Slot id or label to forget'),
});

export const ListInputSchema = z.object({
  tag: z.string().optional().describe('Filter by tag'),
  priority: z.number().min(0).max(2).optional().describe('Filter by priority'),
});

export const AuditInputSchema = z.object({
  limit: z.number().min(1).max(500).optional().default(50).describe('Max events to return'),
  op: z.string().optional().describe('Filter by operation type'),
});

export const SetRuleInputSchema = z.object({
  label: z.string().describe('Human-readable rule description'),
  tag: z.string().optional(),
  priority: z.number().min(0).max(2).optional(),
  intervalMs: z.number().positive().describe('Milliseconds between nudges'),
  maxAgeMs: z.number().optional(),
  enabled: z.boolean().optional().default(true),
});

export const AnchorInputSchema = z.object({
  compareWith: z.string().optional().describe('Anchor hash to compare with current'),
});

// ─── Pro gate helper ──────────────────────────────────────────────────────────

const PRO_REQUIRED_MSG = (feature: string) =>
  `"${feature}" requires Nuggets Memory Pro. Run \`nuggets-memory-pro upgrade\` to get started.`;

function assertPro(feature: string): boolean {
  return getAuth().isPro;
}

// ─── Tool implementations ─────────────────────────────────────────────────────

/** FREE: Store a memory */
export async function toolRemember(input: z.infer<typeof RememberInputSchema>) {
  const store = getStore();
  const audit = getAuditLog(getAuth().isPro);

  const slot = store.remember(input.key, input.value, {
    priority: input.priority,
    tags: input.tags,
  });

  audit.append({ op: 'remember', key: input.key, slotId: slot.id, anchor: store.anchor });

  return wrapResult({
    id: slot.id,
    label: slot.label,
    anchor: store.anchor,
    message: `Remembered "${input.key}" (${store.size} total slots)`,
  }, store.anchor);
}

/** FREE: Recall memories by key */
export async function toolRecall(input: z.infer<typeof RecallInputSchema>) {
  const store = getStore();
  const audit = getAuditLog(getAuth().isPro);

  const results = store.recall(input.key, input.topK);
  audit.append({ op: 'recall', key: input.key });

  return wrapResult({
    results: results.map(r => ({
      id: r.slot.id,
      label: r.slot.label,
      similarity: Math.round(r.similarity * 1000) / 1000,
      priority: r.slot.priority,
      tags: r.slot.tags,
      updatedAt: new Date(r.slot.updatedAt).toISOString(),
    })),
    count: results.length,
  });
}

/** FREE: Semantic search */
export async function toolSearch(input: z.infer<typeof SearchInputSchema>) {
  const store = getStore();
  const audit = getAuditLog(getAuth().isPro);

  let results = store.search(input.query, input.topK * 2); // over-fetch for tag filter
  if (input.tag) results = results.filter(r => r.slot.tags.includes(input.tag!));
  results = results.slice(0, input.topK);

  audit.append({ op: 'search', key: input.query });

  return wrapResult({
    results: results.map(r => ({
      id: r.slot.id,
      label: r.slot.label,
      similarity: Math.round(r.similarity * 1000) / 1000,
      priority: r.slot.priority,
      tags: r.slot.tags,
    })),
    count: results.length,
  });
}

/** FREE: Forget a slot */
export async function toolForget(input: z.infer<typeof ForgetInputSchema>) {
  const store = getStore();
  const audit = getAuditLog(getAuth().isPro);

  const deleted = store.forget(input.id);
  audit.append({ op: 'forget', key: input.id });

  return wrapResult({
    deleted,
    message: deleted ? `Forgot "${input.id}"` : `No slot found for "${input.id}"`,
    anchor: store.anchor,
  }, store.anchor);
}

/** FREE: List memories */
export async function toolList(input: z.infer<typeof ListInputSchema>) {
  const store = getStore();
  const audit = getAuditLog(getAuth().isPro);
  const slots = store.list({ tag: input.tag, priority: input.priority });

  audit.append({ op: 'list' });

  return wrapResult({
    slots: slots.map(s => ({
      id: s.id,
      label: s.label,
      priority: s.priority,
      tags: s.tags,
      createdAt: new Date(s.createdAt).toISOString(),
      updatedAt: new Date(s.updatedAt).toISOString(),
    })),
    count: slots.length,
    anchor: store.anchor,
  });
}

/** FREE: Store status */
export async function toolStatus() {
  const store = getStore();
  const auth = getAuth();
  const summary = getAuditLog(auth.isPro).summary();

  return wrapResult({
    tier: auth.tier,
    email: auth.email ?? null,
    slotCount: store.size,
    anchor: store.anchor,
    auditSummary: summary,
    pro: auth.isPro
      ? { teamId: auth.teamId ?? null }
      : null,
  });
}

/** PRO: Cloud sync */
export async function toolSync() {
  if (!assertPro('memory_sync')) {
    return wrapError(PRO_REQUIRED_MSG('memory_sync'), 'PRO_REQUIRED');
  }

  const store = getStore();
  const auth = getAuth();
  const audit = getAuditLog(true);
  const cloud = new CloudSync(store, auth, audit);

  const result = await cloud.sync();
  return wrapResult({
    pushed: result.pushed,
    pulled: result.pulled,
    serverTs: new Date(result.serverTs).toISOString(),
  });
}

/** PRO: Audit log query */
export async function toolAudit(input: z.infer<typeof AuditInputSchema>) {
  if (!assertPro('memory_audit')) {
    return wrapError(PRO_REQUIRED_MSG('memory_audit'), 'PRO_REQUIRED');
  }

  const audit = getAuditLog(true);
  const events = input.op
    ? audit.filter(input.op as Parameters<typeof audit.filter>[0], input.limit)
    : audit.recent(input.limit);

  return wrapResult({ events, count: events.length });
}

/** PRO: Get nudge queue */
export async function toolNudges() {
  if (!assertPro('memory_nudges')) {
    return wrapError(PRO_REQUIRED_MSG('memory_nudges'), 'PRO_REQUIRED');
  }

  const store = getStore();
  const audit = getAuditLog(true);
  const scheduler = new NudgeScheduler(store, audit);
  const due = scheduler.getDueNudges();
  scheduler.markAllDue();

  return wrapResult({
    nudges: due.map(n => ({
      ruleLabel: n.rule.label,
      slotId: n.slot.id,
      slotLabel: n.slot.label,
      priority: n.slot.priority,
      tags: n.slot.tags,
      ageMs: n.ageMs,
    })),
    summary: scheduler.formatNudges(due),
    count: due.length,
  });
}

/** PRO: Add nudge rule */
export async function toolSetRule(input: z.infer<typeof SetRuleInputSchema>) {
  if (!assertPro('memory_set_rule')) {
    return wrapError(PRO_REQUIRED_MSG('memory_set_rule'), 'PRO_REQUIRED');
  }

  const store = getStore();
  const audit = getAuditLog(true);
  const scheduler = new NudgeScheduler(store, audit);
  const rule = scheduler.addRule(input);

  return wrapResult({ rule, message: `Nudge rule "${rule.label}" created (id: ${rule.id})` });
}

/** PRO: Anchor verification */
export async function toolAnchor(input: z.infer<typeof AnchorInputSchema>) {
  if (!assertPro('memory_anchor')) {
    return wrapError(PRO_REQUIRED_MSG('memory_anchor'), 'PRO_REQUIRED');
  }

  const store = getStore();
  const current = store.anchor;
  const match = input.compareWith ? input.compareWith === current : null;

  return wrapResult({
    current,
    compareWith: input.compareWith ?? null,
    match,
    driftDetected: match === false,
  });
}

// ─── Tool manifest (used by MCP server) ──────────────────────────────────────

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: z.ZodSchema;
  handler: (input: unknown) => Promise<ReturnType<typeof wrapResult>>;
  tier: 'free' | 'pro';
}

export const ALL_TOOLS: MCPTool[] = [
  {
    name: 'memory_remember',
    description: 'Store a key→value memory in the local HRR memory store. Memories persist across sessions.',
    inputSchema: RememberInputSchema,
    handler: (i) => toolRemember(RememberInputSchema.parse(i)),
    tier: 'free',
  },
  {
    name: 'memory_recall',
    description: 'Retrieve memories associated with a key using HRR probing.',
    inputSchema: RecallInputSchema,
    handler: (i) => toolRecall(RecallInputSchema.parse(i)),
    tier: 'free',
  },
  {
    name: 'memory_search',
    description: 'Semantic similarity search across all stored memory slots.',
    inputSchema: SearchInputSchema,
    handler: (i) => toolSearch(SearchInputSchema.parse(i)),
    tier: 'free',
  },
  {
    name: 'memory_forget',
    description: 'Delete a memory slot by id or label.',
    inputSchema: ForgetInputSchema,
    handler: (i) => toolForget(ForgetInputSchema.parse(i)),
    tier: 'free',
  },
  {
    name: 'memory_list',
    description: 'List all memory slots, optionally filtered by tag or priority.',
    inputSchema: ListInputSchema,
    handler: (i) => toolList(ListInputSchema.parse(i)),
    tier: 'free',
  },
  {
    name: 'memory_status',
    description: 'Show memory store statistics, anchor hash, and subscription tier.',
    inputSchema: z.object({}),
    handler: () => toolStatus(),
    tier: 'free',
  },
  {
    name: 'memory_sync',
    description: '[PRO] Bidirectional sync of local memory with cloud (multi-device/team sharing).',
    inputSchema: z.object({}),
    handler: () => toolSync(),
    tier: 'pro',
  },
  {
    name: 'memory_audit',
    description: '[PRO] Retrieve recent audit log events for memory operations.',
    inputSchema: AuditInputSchema,
    handler: (i) => toolAudit(AuditInputSchema.parse(i)),
    tier: 'pro',
  },
  {
    name: 'memory_nudges',
    description: '[PRO] Get the proactive nudge queue — high-priority memories due for review.',
    inputSchema: z.object({}),
    handler: () => toolNudges(),
    tier: 'pro',
  },
  {
    name: 'memory_set_rule',
    description: '[PRO] Create a nudge rule to proactively surface memories to agents.',
    inputSchema: SetRuleInputSchema,
    handler: (i) => toolSetRule(SetRuleInputSchema.parse(i)),
    tier: 'pro',
  },
  {
    name: 'memory_anchor',
    description: '[PRO] Verify the current HRR state anchor and detect memory drift.',
    inputSchema: AnchorInputSchema,
    handler: (i) => toolAnchor(AnchorInputSchema.parse(i)),
    tier: 'pro',
  },
];
