/**
 * nuggets-memory-pro — Cloud Sync (Pro feature)
 *
 * Syncs the local MemoryStore with a remote backend.
 * Default backend: Supabase (via REST API — no Supabase SDK dependency).
 * Alternative: any REST endpoint that implements the NuggetsSync protocol.
 *
 * Protocol:
 *   POST /v1/sync/push   { store: StoreExport }  → { ok: true, serverTs: number }
 *   GET  /v1/sync/pull   → StoreExport
 *   GET  /v1/sync/status → { lastSync: number; slotCount: number }
 *
 * Environment variables:
 *   NUGGETS_SUPABASE_URL     Supabase project URL (or custom backend base URL)
 *   NUGGETS_SUPABASE_KEY     Supabase anon/service key  (or API key)
 *   NUGGETS_API_BASE         Override for Nuggets Pro backend
 */

import 'dotenv/config';
import { z } from 'zod';
import type { MemoryStore } from '../nuggets/memory.js';
import type { AuthManager } from './auth.js';
import type { AuditLog } from '../nuggets/audit.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

const SyncStatusSchema = z.object({
  lastSync: z.number(),
  slotCount: z.number(),
  teamId: z.string().optional(),
});

const PushResponseSchema = z.object({
  ok: z.literal(true),
  serverTs: z.number(),
  merged: z.number().optional(), // number of remote slots merged back
});

// ─── CloudSync ────────────────────────────────────────────────────────────────

const NUGGETS_API_BASE = process.env.NUGGETS_API_BASE ?? 'https://api.nuggets-memory.pro';

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
  serverTs: number;
}

export class CloudSync {
  constructor(
    private store: MemoryStore,
    private auth: AuthManager,
    private audit: AuditLog
  ) {}

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.auth.apiKey ?? ''}`,
      'Content-Type': 'application/json',
      ...(this.auth.teamId ? { 'X-Team-Id': this.auth.teamId } : {}),
    };
  }

  // ── Push ─────────────────────────────────────────────────────────────────

  async push(): Promise<SyncResult> {
    const { default: fetch } = await import('node-fetch');
    const export_ = this.store.exportRaw();
    const slotCount = export_.slots.length;

    const res = await fetch(`${NUGGETS_API_BASE}/v1/sync/push`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ store: export_ }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cloud push failed: ${res.status} ${text}`);
    }

    const body = PushResponseSchema.parse(await res.json());

    this.audit.append({
      op: 'sync_push',
      actor: this.auth.email,
      meta: { slotCount, serverTs: body.serverTs },
    });

    return {
      pushed: slotCount,
      pulled: body.merged ?? 0,
      conflicts: 0,
      serverTs: body.serverTs,
    };
  }

  // ── Pull ─────────────────────────────────────────────────────────────────

  async pull(): Promise<SyncResult> {
    const { default: fetch } = await import('node-fetch');

    const res = await fetch(`${NUGGETS_API_BASE}/v1/sync/pull`, {
      headers: this.headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cloud pull failed: ${res.status} ${text}`);
    }

    const remoteStore = await res.json() as Parameters<MemoryStore['mergeFrom']>[0];
    const beforeSize = this.store.size;
    this.store.mergeFrom(remoteStore);
    const pulled = this.store.size - beforeSize;

    this.audit.append({
      op: 'sync_pull',
      actor: this.auth.email,
      meta: { pulled },
    });

    return { pushed: 0, pulled, conflicts: 0, serverTs: Date.now() };
  }

  // ── Full bidirectional sync ────────────────────────────────────────────

  async sync(): Promise<SyncResult> {
    // Pull first (so local merge is based on latest remote)
    const pullResult = await this.pull();
    // Then push merged state
    const pushResult = await this.push();

    return {
      pushed: pushResult.pushed,
      pulled: pullResult.pulled,
      conflicts: 0,
      serverTs: pushResult.serverTs,
    };
  }

  // ── Status check ──────────────────────────────────────────────────────

  async status(): Promise<z.infer<typeof SyncStatusSchema>> {
    const { default: fetch } = await import('node-fetch');

    const res = await fetch(`${NUGGETS_API_BASE}/v1/sync/status`, {
      headers: this.headers,
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) throw new Error(`Cloud status failed: ${res.status}`);
    return SyncStatusSchema.parse(await res.json());
  }

  // ── Team shared memory ────────────────────────────────────────────────

  /**
   * Fetch the shared team memory superposition (Team plan only).
   * Returns a raw store export that can be merged locally.
   */
  async fetchTeamMemory(): Promise<void> {
    if (this.auth.tier !== 'team') {
      throw new Error('Team memory requires a Team plan subscription.');
    }
    const { default: fetch } = await import('node-fetch');

    const res = await fetch(`${NUGGETS_API_BASE}/v1/team/memory`, {
      headers: this.headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) throw new Error(`Team memory fetch failed: ${res.status}`);
    const teamStore = await res.json() as Parameters<MemoryStore['mergeFrom']>[0];
    this.store.mergeFrom(teamStore);
  }
}
