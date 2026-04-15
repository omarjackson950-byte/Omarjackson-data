/**
 * nuggets-memory-pro — Proactive Nudge Scheduler (Pro feature)
 *
 * Surfaces forgotten or high-priority memories to agents at the right time.
 *
 * How it works:
 *   - Each memory slot has a `priority` (0=normal, 1=high, 2=critical) and tags.
 *   - Nudge rules define when to surface a slot (e.g. "remind every 24h",
 *     "surface when tag=deadline and age > 1h").
 *   - The MCP server calls `getDueNudges()` at session start and returns
 *     them as a special MCP resource.
 *   - Nudge state (last surfaced time) is stored alongside memory slots.
 *
 * Pro Team plan adds cross-agent nudge broadcasting via cloud sync.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { HRRMemorySlot } from '../nuggets/core.js';
import type { MemoryStore } from '../nuggets/memory.js';
import type { AuditLog } from '../nuggets/audit.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

const NudgeRuleSchema = z.object({
  id: z.string(),
  label: z.string(),
  tag: z.string().optional(),          // target slots with this tag
  priority: z.number().min(0).max(2).optional(), // target slots with this priority
  intervalMs: z.number().positive(),   // minimum ms between nudges
  maxAgeMs: z.number().optional(),     // only nudge slots newer than this
  enabled: z.boolean().default(true),
});

const NudgeStateSchema = z.object({
  version: z.literal(1),
  rules: z.array(NudgeRuleSchema),
  lastNudged: z.record(z.string(), z.number()), // slotId → last nudge timestamp
});

export type NudgeRule = z.infer<typeof NudgeRuleSchema>;
type NudgeState = z.infer<typeof NudgeStateSchema>;

// ─── Default rules ────────────────────────────────────────────────────────────

const DEFAULT_RULES: NudgeRule[] = [
  {
    id: 'critical_frequent',
    label: 'Surface critical memories every 30 minutes',
    priority: 2,
    intervalMs: 30 * 60 * 1_000,
    enabled: true,
  },
  {
    id: 'high_daily',
    label: 'Surface high-priority memories every 24 hours',
    priority: 1,
    intervalMs: 24 * 60 * 60 * 1_000,
    enabled: true,
  },
  {
    id: 'deadline_tag',
    label: 'Remind deadline-tagged items every 6 hours',
    tag: 'deadline',
    intervalMs: 6 * 60 * 60 * 1_000,
    enabled: true,
  },
];

// ─── Paths ────────────────────────────────────────────────────────────────────

function getNudgePath(): string {
  const base = process.env.NUGGETS_NUDGE_PATH
    ?? path.join(os.homedir(), '.nuggets-memory-pro', 'nudge.json');
  fs.mkdirSync(path.dirname(base), { recursive: true });
  return base;
}

// ─── NudgeScheduler ───────────────────────────────────────────────────────────

export interface DueNudge {
  rule: NudgeRule;
  slot: HRRMemorySlot;
  ageMs: number;
  lastNudgedMs: number | null;
}

export class NudgeScheduler {
  private nudgePath: string;
  private state: NudgeState;

  constructor(
    private store: MemoryStore,
    private audit: AuditLog,
    nudgePath?: string
  ) {
    this.nudgePath = nudgePath ?? getNudgePath();
    this.state = this.load();
  }

  // ── I/O ──────────────────────────────────────────────────────────────────

  private load(): NudgeState {
    try {
      const raw = fs.readFileSync(this.nudgePath, 'utf8');
      return NudgeStateSchema.parse(JSON.parse(raw));
    } catch {
      return { version: 1, rules: DEFAULT_RULES, lastNudged: {} };
    }
  }

  private save(): void {
    const tmp = this.nudgePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmp, this.nudgePath);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Return all slots due for nudging right now. */
  getDueNudges(): DueNudge[] {
    const now = Date.now();
    const slots = this.store.list();
    const due: DueNudge[] = [];

    for (const rule of this.state.rules) {
      if (!rule.enabled) continue;

      for (const slot of slots) {
        // Tag filter
        if (rule.tag && !slot.tags.includes(rule.tag)) continue;
        // Priority filter
        if (rule.priority !== undefined && slot.priority < rule.priority) continue;
        // Max age filter
        if (rule.maxAgeMs && now - slot.createdAt > rule.maxAgeMs) continue;

        const lastNudged = this.state.lastNudged[slot.id] ?? null;
        const timeSinceLast = lastNudged ? now - lastNudged : Infinity;

        if (timeSinceLast >= rule.intervalMs) {
          due.push({
            rule,
            slot,
            ageMs: now - slot.createdAt,
            lastNudgedMs: lastNudged,
          });
        }
      }
    }

    // Sort: critical first, then by time since last nudge (most overdue first)
    return due.sort((a, b) => {
      if (b.slot.priority !== a.slot.priority) return b.slot.priority - a.slot.priority;
      const aOverdue = (a.lastNudgedMs ? Date.now() - a.lastNudgedMs : Infinity);
      const bOverdue = (b.lastNudgedMs ? Date.now() - b.lastNudgedMs : Infinity);
      return bOverdue - aOverdue;
    });
  }

  /** Mark a slot as nudged (call after surfacing to agent). */
  markNudged(slotId: string): void {
    this.state.lastNudged[slotId] = Date.now();
    this.save();
    this.audit.append({ op: 'nudge_sent', slotId });
  }

  /** Mark all due nudges as sent. */
  markAllDue(): DueNudge[] {
    const due = this.getDueNudges();
    for (const nudge of due) {
      this.markNudged(nudge.slot.id);
    }
    return due;
  }

  // ── Rule management ────────────────────────────────────────────────────

  addRule(rule: Omit<NudgeRule, 'id'>): NudgeRule {
    const full: NudgeRule = {
      id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ...rule,
    };
    this.state.rules.push(full);
    this.save();
    return full;
  }

  removeRule(id: string): boolean {
    const before = this.state.rules.length;
    this.state.rules = this.state.rules.filter(r => r.id !== id);
    if (this.state.rules.length < before) { this.save(); return true; }
    return false;
  }

  toggleRule(id: string, enabled: boolean): boolean {
    const rule = this.state.rules.find(r => r.id === id);
    if (!rule) return false;
    rule.enabled = enabled;
    this.save();
    return true;
  }

  listRules(): NudgeRule[] {
    return [...this.state.rules];
  }

  /** Format due nudges as a human-readable summary for MCP. */
  formatNudges(nudges: DueNudge[]): string {
    if (nudges.length === 0) return 'No pending nudges.';
    return nudges
      .map(n => {
        const priority = ['normal', 'high', 'critical'][n.slot.priority] ?? 'normal';
        const age = formatDuration(n.ageMs);
        const last = n.lastNudgedMs ? `last surfaced ${formatDuration(Date.now() - n.lastNudgedMs)} ago` : 'never surfaced';
        return `[${priority.toUpperCase()}] "${n.slot.label}" (${age} old, ${last})\n  Rule: ${n.rule.label}`;
      })
      .join('\n\n');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
