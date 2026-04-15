/**
 * nuggets-memory-pro — Local Memory Store
 *
 * Persists HRR memory slots to disk using a JSON flat-file database.
 * Free tier uses this exclusively.  Pro tier syncs this store to cloud.
 *
 * Design goals:
 *   - Zero runtime dependencies beyond Node.js built-ins + zod
 *   - Atomic writes (write tmp → rename) to avoid corruption
 *   - O(n) similarity search with early-exit for large stores
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  HRR_DIM,
  HRRMemorySlot,
  HRRQueryResult,
  bind,
  cosine,
  deserialiseVector,
  normalise,
  probe,
  serialiseVector,
  stateAnchor,
  superpose,
  tokenVector,
} from './core.js';

// ─── Persistence schema ───────────────────────────────────────────────────────

const SlotSchema = z.object({
  id: z.string(),
  label: z.string(),
  vector: z.array(z.number()).length(HRR_DIM),
  anchor: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  priority: z.number().min(0).max(2),
  tags: z.array(z.string()),
});

const StoreSchema = z.object({
  version: z.literal(1),
  slots: z.array(SlotSchema),
  globalMemory: z.array(z.number()).length(HRR_DIM).optional(),
  updatedAt: z.number(),
});

type StoreData = z.infer<typeof StoreSchema>;

// ─── Paths ────────────────────────────────────────────────────────────────────

function getStorePath(): string {
  const base = process.env.NUGGETS_STORE_PATH
    ?? path.join(os.homedir(), '.nuggets-memory-pro', 'store.json');
  fs.mkdirSync(path.dirname(base), { recursive: true });
  return base;
}

// ─── MemoryStore class ────────────────────────────────────────────────────────

export class MemoryStore {
  private storePath: string;
  private data: StoreData;

  constructor(storePath?: string) {
    this.storePath = storePath ?? getStorePath();
    this.data = this.load();
  }

  // ── I/O ────────────────────────────────────────────────────────────────────

  private load(): StoreData {
    try {
      const raw = fs.readFileSync(this.storePath, 'utf8');
      const parsed = StoreSchema.parse(JSON.parse(raw));
      return parsed;
    } catch {
      return {
        version: 1,
        slots: [],
        updatedAt: Date.now(),
      };
    }
  }

  save(): void {
    const tmp = this.storePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.storePath); // atomic on POSIX
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /** Store a memory by encoding a (key, value) pair into HRR. */
  remember(
    key: string,
    value: string,
    opts: { priority?: number; tags?: string[] } = {}
  ): HRRMemorySlot {
    const keyVec = tokenVector(key);
    const valVec = tokenVector(value);
    const bound = bind(keyVec, valVec);

    const existing = this.data.slots.find(s => s.label === key);
    const now = Date.now();

    let slot: HRRMemorySlot;

    if (existing) {
      // Update: superpose old vector with new binding
      const oldVec = deserialiseVector(existing.vector);
      const merged = superpose(oldVec, bound);
      existing.vector = serialiseVector(merged);
      existing.anchor = stateAnchor(merged);
      existing.updatedAt = now;
      existing.priority = opts.priority ?? existing.priority;
      existing.tags = [...new Set([...existing.tags, ...(opts.tags ?? [])])];
      slot = existing as unknown as HRRMemorySlot;
    } else {
      const id = `slot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const newSlot = {
        id,
        label: key,
        vector: serialiseVector(bound),
        anchor: stateAnchor(bound),
        createdAt: now,
        updatedAt: now,
        priority: opts.priority ?? 0,
        tags: opts.tags ?? [],
      };
      this.data.slots.push(newSlot);
      slot = { ...newSlot, vector: bound } as unknown as HRRMemorySlot;
    }

    // Refresh global superposition
    this.rebuildGlobalMemory();
    this.data.updatedAt = now;
    this.save();
    return slot;
  }

  /** Recall value vector given a key. */
  recall(key: string, topK = 5): HRRQueryResult[] {
    if (this.data.slots.length === 0) return [];

    const keyVec = tokenVector(key);
    const global = this.getGlobalMemory();

    // Probe global memory for the approximate value
    const retrieved = probe(global, keyVec);

    // Score each slot by similarity to the retrieved vector
    return this.data.slots
      .map(s => {
        const slotVec = deserialiseVector(s.vector);
        // Probe this specific slot for its value component
        const slotValue = probe(slotVec, keyVec);
        const sim = cosine(slotValue, retrieved);
        return { slot: s as unknown as HRRMemorySlot, similarity: sim };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK)
      .filter(r => r.similarity > 0.01);
  }

  /** Semantic search: find slots whose stored vector is most similar to query. */
  search(query: string, topK = 5): HRRQueryResult[] {
    if (this.data.slots.length === 0) return [];

    const queryVec = tokenVector(query);

    return this.data.slots
      .map(s => {
        const slotVec = deserialiseVector(s.vector);
        const sim = cosine(queryVec, slotVec);
        return { slot: s as unknown as HRRMemorySlot, similarity: sim };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  /** Forget a slot by id or label. */
  forget(idOrLabel: string): boolean {
    const before = this.data.slots.length;
    this.data.slots = this.data.slots.filter(
      s => s.id !== idOrLabel && s.label !== idOrLabel
    );
    if (this.data.slots.length < before) {
      this.rebuildGlobalMemory();
      this.data.updatedAt = Date.now();
      this.save();
      return true;
    }
    return false;
  }

  /** Return all slots, optionally filtered by tag or priority. */
  list(filter?: { tag?: string; priority?: number }): HRRMemorySlot[] {
    let slots = this.data.slots as unknown as HRRMemorySlot[];
    if (filter?.tag) slots = slots.filter(s => s.tags.includes(filter.tag!));
    if (filter?.priority !== undefined)
      slots = slots.filter(s => s.priority === filter.priority);
    return slots.sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt);
  }

  /** Number of stored slots. */
  get size(): number {
    return this.data.slots.length;
  }

  /** Current global memory anchor hash. */
  get anchor(): string {
    const global = this.getGlobalMemory();
    return stateAnchor(global);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private getGlobalMemory(): Float64Array {
    if (this.data.globalMemory) {
      return deserialiseVector(this.data.globalMemory);
    }
    return this.rebuildGlobalMemory();
  }

  private rebuildGlobalMemory(): Float64Array {
    if (this.data.slots.length === 0) {
      const zero = new Float64Array(HRR_DIM);
      this.data.globalMemory = serialiseVector(zero);
      return zero;
    }
    const vecs = this.data.slots.map(s => deserialiseVector(s.vector));
    const global = vecs.length === 1 ? normalise(vecs[0]) : superpose(...vecs);
    this.data.globalMemory = serialiseVector(global);
    return global;
  }

  /** Export raw store data (for cloud sync). */
  exportRaw(): StoreData {
    return JSON.parse(JSON.stringify(this.data)) as StoreData;
  }

  /** Merge incoming cloud store into local (higher priority wins on conflict). */
  mergeFrom(remote: StoreData): void {
    const localMap = new Map(this.data.slots.map(s => [s.id, s]));
    for (const remoteSlot of remote.slots) {
      const local = localMap.get(remoteSlot.id);
      if (!local || remoteSlot.updatedAt > local.updatedAt) {
        localMap.set(remoteSlot.id, remoteSlot);
      }
    }
    this.data.slots = Array.from(localMap.values());
    this.rebuildGlobalMemory();
    this.data.updatedAt = Date.now();
    this.save();
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _store: MemoryStore | null = null;

export function getStore(storePath?: string): MemoryStore {
  if (!_store) _store = new MemoryStore(storePath);
  return _store;
}
