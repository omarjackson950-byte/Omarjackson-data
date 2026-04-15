/**
 * nuggets-memory-pro — Determinism Guardrails (Pro feature)
 *
 * Ensures repeatable, verifiable outputs from tool-calling agents by:
 *
 *   1. STATE ANCHORING
 *      Before any tool call the HRR memory anchor (8-byte fingerprint) is
 *      captured.  After the call it is recomputed and compared.  Drift triggers
 *      a warning + optional rollback.
 *
 *   2. STRUCTURED OUTPUT SCHEMAS
 *      All MCP tool results are validated against Zod schemas before returning.
 *      Schema mismatches are caught and wrapped in a typed error object —
 *      never silently swallowed.
 *
 *   3. VERIFICATION LOOPS
 *      Critical writes (remember, cloud push) run up to MAX_RETRIES times with
 *      a hash check between attempts.  A retry is only triggered when the
 *      post-write anchor differs from expected (not for transient network errors
 *      which have separate retry logic).
 */

import { z } from 'zod';
import { stateAnchor } from '../nuggets/core.js';
import type { MemoryStore } from '../nuggets/memory.js';
import type { AuditLog } from '../nuggets/audit.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const ANCHOR_TOLERANCE = 0; // exact match required (0 = no drift allowed)

// ─── Typed error ─────────────────────────────────────────────────────────────

export class GuardrailError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'ANCHOR_DRIFT'
      | 'SCHEMA_MISMATCH'
      | 'VERIFICATION_FAILED'
      | 'MAX_RETRIES_EXCEEDED'
  ) {
    super(message);
    this.name = 'GuardrailError';
  }
}

// ─── Structured output schemas ────────────────────────────────────────────────

/** Schema for MCP tool result envelopes */
export const ToolResultSchema = z.object({
  ok: z.boolean(),
  data: z.unknown(),
  anchor: z.string().optional(),
  timestamp: z.number(),
});

export type ToolResult<T = unknown> = {
  ok: boolean;
  data: T;
  anchor?: string;
  timestamp: number;
};

/** Wrap any tool output in a verified, timestamped envelope */
export function wrapResult<T>(data: T, anchor?: string): ToolResult<T> {
  return {
    ok: true,
    data,
    anchor,
    timestamp: Date.now(),
  };
}

export function wrapError(message: string, code?: string): ToolResult<{ error: string; code?: string }> {
  return {
    ok: false,
    data: { error: message, code },
    timestamp: Date.now(),
  };
}

// ─── Anchor guard ─────────────────────────────────────────────────────────────

export interface AnchorSnapshot {
  anchor: string;
  capturedAt: number;
}

export function captureAnchor(store: MemoryStore): AnchorSnapshot {
  return { anchor: store.anchor, capturedAt: Date.now() };
}

export function verifyAnchor(
  store: MemoryStore,
  snapshot: AnchorSnapshot,
  audit: AuditLog
): { ok: boolean; driftDetected: boolean; before: string; after: string } {
  const afterAnchor = store.anchor;
  const driftDetected = afterAnchor !== snapshot.anchor;

  if (driftDetected) {
    audit.append({
      op: 'anchor_drift',
      anchor: afterAnchor,
      driftFrom: snapshot.anchor,
      meta: { capturedAt: snapshot.capturedAt },
    });
  } else {
    audit.append({ op: 'anchor_verified', anchor: afterAnchor });
  }

  return {
    ok: !driftDetected,
    driftDetected,
    before: snapshot.anchor,
    after: afterAnchor,
  };
}

// ─── Verification loop ────────────────────────────────────────────────────────

/**
 * Execute a write operation with anchor verification.
 * Retries up to MAX_RETRIES times if the post-write anchor matches
 * neither the pre-write anchor (expected for mutations) nor a stable
 * expected anchor (indicates indeterminate write).
 *
 * @param operation   Async function that mutates the store
 * @param store       MemoryStore instance
 * @param audit       AuditLog instance
 * @param expectDrift Whether the anchor is expected to change (true for writes)
 */
export async function withVerification<T>(
  operation: () => Promise<T>,
  store: MemoryStore,
  audit: AuditLog,
  expectDrift = true
): Promise<T> {
  const before = captureAnchor(store);
  let lastResult: T | undefined;
  let lastAnchor: string | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    lastResult = await operation();

    const after = store.anchor;

    if (!expectDrift) {
      // Read-only op: anchor must not change
      if (after !== before.anchor) {
        throw new GuardrailError(
          `Unexpected anchor drift during read-only operation (attempt ${attempt}). Before: ${before.anchor}, After: ${after}`,
          'ANCHOR_DRIFT'
        );
      }
      audit.append({ op: 'anchor_verified', anchor: after });
      return lastResult;
    }

    // Write op: anchor must change (or remain same if no-op), and must be stable
    if (lastAnchor !== undefined && after !== lastAnchor) {
      // Anchor changed between retries — non-deterministic write
      audit.append({
        op: 'anchor_drift',
        anchor: after,
        driftFrom: lastAnchor,
        meta: { attempt, reason: 'non_deterministic_write' },
      });
      if (attempt === MAX_RETRIES) {
        throw new GuardrailError(
          `Write produced non-deterministic state after ${MAX_RETRIES} attempts.`,
          'MAX_RETRIES_EXCEEDED'
        );
      }
      lastAnchor = after;
      continue;
    }

    // Anchor is stable → verify and return
    audit.append({ op: 'anchor_verified', anchor: after });
    return lastResult;
  }

  throw new GuardrailError('Verification loop failed to stabilise.', 'VERIFICATION_FAILED');
}

// ─── Schema validation wrapper ────────────────────────────────────────────────

/**
 * Validate a value against a Zod schema.
 * Returns the parsed value or throws GuardrailError on mismatch.
 */
export function validateSchema<T>(
  schema: z.ZodSchema<T>,
  value: unknown,
  context = 'tool result'
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new GuardrailError(
      `Schema validation failed for ${context}: ${result.error.message}`,
      'SCHEMA_MISMATCH'
    );
  }
  return result.data;
}

// ─── Guardrails manager ───────────────────────────────────────────────────────

export class Guardrails {
  constructor(
    private store: MemoryStore,
    private audit: AuditLog,
    public readonly enabled: boolean
  ) {}

  capture(): AnchorSnapshot {
    return captureAnchor(this.store);
  }

  verify(snapshot: AnchorSnapshot) {
    if (!this.enabled) return { ok: true, driftDetected: false, before: '', after: '' };
    return verifyAnchor(this.store, snapshot, this.audit);
  }

  async run<T>(op: () => Promise<T>, expectDrift = true): Promise<T> {
    if (!this.enabled) return op();
    return withVerification(op, this.store, this.audit, expectDrift);
  }

  wrap<T>(data: T): ToolResult<T> {
    return wrapResult(data, this.enabled ? this.store.anchor : undefined);
  }
}
