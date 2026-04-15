/**
 * nuggets-memory-pro — Auth / License layer
 *
 * Manages the user's tier (free vs pro), license key storage,
 * and subscription status checks against the Nuggets Pro backend.
 *
 * Flow:
 *   1. CLI `login`  → saves email + API key to ~/.nuggets-memory-pro/config.json
 *   2. Each MCP call → reads config, verifies subscription (cached 1 h)
 *   3. `logout`     → clears credentials
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// ─── Config schema ────────────────────────────────────────────────────────────

const ConfigSchema = z.object({
  email: z.string().email().optional(),
  apiKey: z.string().optional(),         // Nuggets Pro API key (from login)
  tier: z.enum(['free', 'individual', 'team']).default('free'),
  teamId: z.string().optional(),
  verifiedAt: z.number().optional(),     // last successful check (ms)
  expiresAt: z.number().optional(),      // subscription expiry (ms)
});

export type Config = z.infer<typeof ConfigSchema>;
export type Tier = Config['tier'];

// ─── Paths ────────────────────────────────────────────────────────────────────

function getConfigPath(): string {
  const dir = process.env.NUGGETS_CONFIG_DIR
    ?? path.join(os.homedir(), '.nuggets-memory-pro');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'config.json');
}

// ─── AuthManager ──────────────────────────────────────────────────────────────

const VERIFY_TTL_MS = 60 * 60 * 1_000; // 1 hour cache
const API_BASE = process.env.NUGGETS_API_BASE ?? 'https://api.nuggets-memory.pro';

export class AuthManager {
  private configPath: string;
  private config: Config;

  constructor(configPath?: string) {
    this.configPath = configPath ?? getConfigPath();
    this.config = this.load();
  }

  // ── I/O ─────────────────────────────────────────────────────────────────

  private load(): Config {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      return ConfigSchema.parse(JSON.parse(raw));
    } catch {
      return { tier: 'free' };
    }
  }

  private save(): void {
    const tmp = this.configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.configPath);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  get tier(): Tier {
    return this.config.tier;
  }

  get isPro(): boolean {
    return this.config.tier !== 'free';
  }

  get email(): string | undefined {
    return this.config.email;
  }

  get teamId(): string | undefined {
    return this.config.teamId;
  }

  get apiKey(): string | undefined {
    return this.config.apiKey;
  }

  /** Set credentials after login. Does not verify online yet. */
  setCredentials(email: string, apiKey: string): void {
    this.config.email = email;
    this.config.apiKey = apiKey;
    this.config.verifiedAt = undefined; // force re-check
    this.save();
  }

  /** Update tier info after successful verification. */
  setTier(tier: Tier, opts: { expiresAt?: number; teamId?: string } = {}): void {
    this.config.tier = tier;
    this.config.expiresAt = opts.expiresAt;
    this.config.teamId = opts.teamId;
    this.config.verifiedAt = Date.now();
    this.save();
  }

  /** Clear credentials (logout). */
  clear(): void {
    this.config = { tier: 'free' };
    this.save();
  }

  /**
   * Verify subscription online (with 1-hour local cache).
   * Returns true if Pro, false if Free.
   * Falls back to cached tier on network error.
   */
  async verify(): Promise<boolean> {
    if (!this.config.apiKey) return false;

    // Serve from cache if fresh
    if (
      this.config.verifiedAt &&
      Date.now() - this.config.verifiedAt < VERIFY_TTL_MS &&
      this.isPro
    ) {
      // Check local expiry
      if (this.config.expiresAt && Date.now() > this.config.expiresAt) {
        this.config.tier = 'free';
        this.save();
        return false;
      }
      return true;
    }

    try {
      const { default: fetch } = await import('node-fetch');
      const res = await fetch(`${API_BASE}/v1/subscription/status`, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          this.config.tier = 'free';
          this.save();
        }
        return false;
      }

      const body = await res.json() as {
        tier: Tier;
        expiresAt: number;
        teamId?: string;
      };

      this.setTier(body.tier, { expiresAt: body.expiresAt, teamId: body.teamId });
      return body.tier !== 'free';
    } catch {
      // Network error: fall back to cached result
      return this.isPro;
    }
  }

  /** Summary for `nuggets-memory-pro status`. */
  statusSummary(): {
    tier: Tier;
    email: string | null;
    expiresAt: Date | null;
    verifiedAt: Date | null;
  } {
    return {
      tier: this.config.tier,
      email: this.config.email ?? null,
      expiresAt: this.config.expiresAt ? new Date(this.config.expiresAt) : null,
      verifiedAt: this.config.verifiedAt ? new Date(this.config.verifiedAt) : null,
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _auth: AuthManager | null = null;

export function getAuth(): AuthManager {
  if (!_auth) _auth = new AuthManager();
  return _auth;
}
