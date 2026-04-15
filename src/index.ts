/**
 * nuggets-memory-pro — Public API
 *
 * Re-exports the building blocks so the package can be used as a library
 * in addition to the CLI and MCP server.
 *
 * import { MemoryStore, bind, tokenVector } from 'nuggets-memory-pro';
 */

// ─── HRR Core ────────────────────────────────────────────────────────────────

export {
  // constants
  HRR_DIM,
  // operations
  bind,
  probe,
  superpose,
  normalise,
  dot,
  cosine,
  // helpers
  randomVector,
  tokenVector,
  stateAnchor,
  // serialisation
  serialiseVector,
  deserialiseVector,
  // types
  type HRRMemorySlot,
  type HRRQueryResult,
} from './nuggets/core.js';

// ─── Memory Store ─────────────────────────────────────────────────────────────

export { MemoryStore, getStore } from './nuggets/memory.js';

// ─── Audit Log ────────────────────────────────────────────────────────────────

export {
  AuditLog,
  getAuditLog,
  reinitAuditLog,
  type AuditEvent,
  type AuditOp,
} from './nuggets/audit.js';

// ─── Pro: Auth ────────────────────────────────────────────────────────────────

export { AuthManager, getAuth, type Tier } from './pro/auth.js';

// ─── Pro: Stripe ─────────────────────────────────────────────────────────────

export { StripeCheckout, PLANS, type PlanKey } from './pro/stripe.js';

// ─── Pro: Cloud Sync ─────────────────────────────────────────────────────────

export { CloudSync, type SyncResult } from './pro/cloud.js';

// ─── Pro: Guardrails ──────────────────────────────────────────────────────────

export {
  Guardrails,
  GuardrailError,
  withVerification,
  validateSchema,
  captureAnchor,
  verifyAnchor,
  wrapResult,
  wrapError,
  type ToolResult,
  type AnchorSnapshot,
} from './pro/guardrails.js';

// ─── Pro: Nudge Scheduler ─────────────────────────────────────────────────────

export {
  NudgeScheduler,
  type NudgeRule,
  type DueNudge,
} from './pro/nudge.js';

// ─── MCP Tools ────────────────────────────────────────────────────────────────

export { ALL_TOOLS, type MCPTool } from './mcp/tools.js';
