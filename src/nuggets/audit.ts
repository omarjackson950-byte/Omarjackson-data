/**
 * nuggets-memory-pro — Audit Log (Pro feature)
 *
 * Append-only structured log of all memory operations.
 * Each entry is a NDJSON line written atomically.
 * Pro users get full history; free users get last 50 events in-memory only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// ─── Schema ───────────────────────────────────────────────────────────────────

export const AuditEventSchema = z.object({
  ts: z.number(),                        // unix ms
  op: z.enum([
    'remember', 'recall', 'forget', 'search', 'list',
    'sync_push', 'sync_pull', 'anchor_verified', 'anchor_drift',
    'nudge_sent', 'upgrade', 'login', 'logout',
  ]),
  actor: z.string().optional(),          // user/agent ID
  key: z.string().optional(),            // memory key involved
  slotId: z.string().optional(),
  anchor: z.string().optional(),         // state anchor hash
  driftFrom: z.string().optional(),      // previous anchor (for drift events)
  meta: z.record(z.unknown()).optional(),
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditOp = AuditEvent['op'];

// ─── Audit log ────────────────────────────────────────────────────────────────

function getAuditPath(): string {
  const base = process.env.NUGGETS_AUDIT_PATH
    ?? path.join(os.homedir(), '.nuggets-memory-pro', 'audit.ndjson');
  fs.mkdirSync(path.dirname(base), { recursive: true });
  return base;
}

const FREE_MEMORY_LIMIT = 50;

export class AuditLog {
  private auditPath: string;
  private isPro: boolean;
  private memoryBuffer: AuditEvent[] = [];

  constructor(isPro: boolean, auditPath?: string) {
    this.isPro = isPro;
    this.auditPath = auditPath ?? getAuditPath();
  }

  append(event: Omit<AuditEvent, 'ts'>): void {
    const full: AuditEvent = { ts: Date.now(), ...event };

    if (this.isPro) {
      // Atomic append — open, write line, close
      fs.appendFileSync(this.auditPath, JSON.stringify(full) + '\n', 'utf8');
    } else {
      // Free tier: in-memory ring buffer
      this.memoryBuffer.push(full);
      if (this.memoryBuffer.length > FREE_MEMORY_LIMIT) {
        this.memoryBuffer.shift();
      }
    }
  }

  /** Read recent audit events (Pro: from disk; Free: from buffer). */
  recent(limit = 100): AuditEvent[] {
    if (!this.isPro) {
      return this.memoryBuffer.slice(-limit);
    }

    try {
      const raw = fs.readFileSync(this.auditPath, 'utf8');
      return raw
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try {
            return AuditEventSchema.parse(JSON.parse(line));
          } catch {
            return null;
          }
        })
        .filter((e): e is AuditEvent => e !== null)
        .slice(-limit);
    } catch {
      return [];
    }
  }

  /** Return events matching a specific operation. */
  filter(op: AuditOp, limit = 50): AuditEvent[] {
    return this.recent(1000).filter(e => e.op === op).slice(-limit);
  }

  /** Rotate log file (Pro only) — keeps last N lines. */
  rotate(keepLines = 10_000): void {
    if (!this.isPro) return;
    try {
      const raw = fs.readFileSync(this.auditPath, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      if (lines.length > keepLines) {
        fs.writeFileSync(this.auditPath, lines.slice(-keepLines).join('\n') + '\n', 'utf8');
      }
    } catch {
      // File doesn't exist yet — no-op
    }
  }

  /** Summarise recent activity for the status command. */
  summary(): {
    total: number;
    byOp: Partial<Record<AuditOp, number>>;
    lastEvent: AuditEvent | null;
  } {
    const events = this.recent(1000);
    const byOp: Partial<Record<AuditOp, number>> = {};
    for (const e of events) {
      byOp[e.op] = (byOp[e.op] ?? 0) + 1;
    }
    return {
      total: events.length,
      byOp,
      lastEvent: events.at(-1) ?? null,
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _audit: AuditLog | null = null;

export function getAuditLog(isPro = false): AuditLog {
  if (!_audit) _audit = new AuditLog(isPro);
  return _audit;
}

export function reinitAuditLog(isPro: boolean): AuditLog {
  _audit = new AuditLog(isPro);
  return _audit;
}
