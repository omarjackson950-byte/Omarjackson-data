/**
 * nuggets-memory-pro — Stripe Integration
 *
 * CLI-first payment flow:
 *   1. `nuggets-memory-pro upgrade` → creates a Stripe Checkout session
 *   2. Opens the browser to the hosted checkout page
 *   3. Polls the backend (every 3 s, up to 5 min) for session completion
 *   4. On success: saves API key + tier to local config
 *
 * Plans:
 *   individual  → $9/mo   (STRIPE_PRICE_INDIVIDUAL)
 *   team        → $29/mo  (STRIPE_PRICE_TEAM)
 *
 * Environment variables needed (in .env or shell):
 *   STRIPE_SECRET_KEY          Server-side secret key (sk_live_...)
 *   STRIPE_PUBLISHABLE_KEY     Client-side key (pk_live_...)  — informational only
 *   STRIPE_PRICE_INDIVIDUAL    Price ID for $9/mo plan
 *   STRIPE_PRICE_TEAM          Price ID for $29/mo plan
 *   NUGGETS_API_BASE           Backend base URL (default: https://api.nuggets-memory.pro)
 */

import 'dotenv/config';
import { z } from 'zod';
import type { AuthManager } from './auth.js';
import type { Tier } from './auth.js';

// ─── Plan definitions ─────────────────────────────────────────────────────────

export const PLANS = {
  individual: {
    label: 'Individual',
    price: '$9/month',
    priceId: process.env.STRIPE_PRICE_INDIVIDUAL ?? 'price_individual_placeholder',
    tier: 'individual' as Tier,
    features: [
      'Unlimited local HRR memory',
      'Cloud sync (1 device)',
      'Audit logs (30 days)',
      'Determinism guardrails',
      'Priority support',
    ],
  },
  team: {
    label: 'Team',
    price: '$29/month',
    priceId: process.env.STRIPE_PRICE_TEAM ?? 'price_team_placeholder',
    tier: 'team' as Tier,
    features: [
      'Everything in Individual',
      'Shared team memory',
      'Unlimited devices',
      'Audit logs (1 year)',
      'Proactive nudge scheduling',
      'SAML SSO (coming soon)',
    ],
  },
} as const;

export type PlanKey = keyof typeof PLANS;

// ─── Schema for backend responses ────────────────────────────────────────────

const CheckoutSessionSchema = z.object({
  sessionId: z.string(),
  url: z.string().url(),
  pollToken: z.string(),
});

const PollResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({
    status: z.literal('complete'),
    apiKey: z.string(),
    tier: z.enum(['individual', 'team']),
    expiresAt: z.number(),
    teamId: z.string().optional(),
  }),
  z.object({ status: z.literal('expired') }),
]);

// ─── StripeCheckout ───────────────────────────────────────────────────────────

const API_BASE = process.env.NUGGETS_API_BASE ?? 'https://api.nuggets-memory.pro';
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000;

export class StripeCheckout {
  constructor(private auth: AuthManager) {}

  /**
   * Start the upgrade flow for a given plan.
   * Returns the checkout URL (caller opens the browser).
   */
  async createSession(plan: PlanKey): Promise<{ url: string; pollToken: string }> {
    const { default: fetch } = await import('node-fetch');
    const priceId = PLANS[plan].priceId;

    const res = await fetch(`${API_BASE}/v1/checkout/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        priceId,
        email: this.auth.email,
        successUrl: `${API_BASE}/checkout/success`,
        cancelUrl: `${API_BASE}/checkout/cancel`,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to create checkout session: ${res.status} ${text}`);
    }

    const body = CheckoutSessionSchema.parse(await res.json());
    return { url: body.url, pollToken: body.pollToken };
  }

  /**
   * Poll for checkout completion.
   * Resolves with the acquired API key and tier, or rejects on timeout/expiry.
   */
  async pollForCompletion(
    pollToken: string,
    onPing?: (elapsed: number) => void
  ): Promise<{ apiKey: string; tier: Tier; expiresAt: number; teamId?: string }> {
    const { default: fetch } = await import('node-fetch');
    const start = Date.now();

    while (Date.now() - start < POLL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);
      onPing?.(Date.now() - start);

      const res = await fetch(`${API_BASE}/v1/checkout/poll?token=${pollToken}`, {
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) continue; // transient error — keep polling

      const body = PollResultSchema.parse(await res.json());

      if (body.status === 'complete') {
        return {
          apiKey: body.apiKey,
          tier: body.tier,
          expiresAt: body.expiresAt,
          teamId: body.teamId,
        };
      }

      if (body.status === 'expired') {
        throw new Error('Checkout session expired. Please run `upgrade` again.');
      }
      // status === 'pending' → keep polling
    }

    throw new Error('Checkout polling timed out (5 minutes). Please try again.');
  }

  /**
   * Full upgrade flow (for use in CLI):
   *   open browser → poll → save credentials.
   */
  async upgrade(
    plan: PlanKey,
    onUrl: (url: string) => void,
    onPing?: (elapsed: number) => void
  ): Promise<Tier> {
    const { url, pollToken } = await this.createSession(plan);
    onUrl(url);

    const result = await this.pollForCompletion(pollToken, onPing);
    this.auth.setCredentials(this.auth.email ?? '', result.apiKey);
    this.auth.setTier(result.tier, { expiresAt: result.expiresAt, teamId: result.teamId });

    return result.tier;
  }

  /**
   * Cancel / manage subscription (opens billing portal).
   */
  async manageBilling(): Promise<string> {
    if (!this.auth.apiKey) throw new Error('Not logged in.');
    const { default: fetch } = await import('node-fetch');

    const res = await fetch(`${API_BASE}/v1/billing/portal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.auth.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) throw new Error(`Billing portal error: ${res.status}`);
    const body = await res.json() as { url: string };
    return body.url;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
