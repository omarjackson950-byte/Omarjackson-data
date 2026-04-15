#!/usr/bin/env node
/**
 * nuggets-memory-pro — MCP Server
 *
 * Implements the Model Context Protocol stdio transport.
 * Registers all free + pro tools and surfaces nudges as a resource.
 *
 * Usage (stdio transport, for .mcp.json):
 *   node dist/mcp/server.js
 *
 * The server reads NUGGETS_* env vars from the process environment.
 * Set them in .env or pass them via the MCP config "env" block.
 */

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { ALL_TOOLS } from './tools.js';
import { getStore } from '../nuggets/memory.js';
import { getAuditLog } from '../nuggets/audit.js';
import { NudgeScheduler } from '../pro/nudge.js';
import { getAuth as _getAuth } from '../pro/auth.js';

// ─── Server init ─────────────────────────────────────────────────────────────

const PKG_NAME = 'nuggets-memory-pro';
const PKG_VERSION = '1.0.0';

const server = new Server(
  { name: PKG_NAME, version: PKG_VERSION },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// ─── Tool listing ─────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const auth = _getAuth();
  await auth.verify().catch(() => {});

  return {
    tools: ALL_TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  };
});

// ─── Tool calling ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const tool = ALL_TOOLS.find(t => t.name === name);
  if (!tool) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  try {
    const result = await tool.handler(args ?? {});
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new McpError(ErrorCode.InternalError, message);
  }
});

// ─── Resource listing ─────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const auth = _getAuth();
  const resources = [
    {
      uri: 'memory://store/status',
      name: 'Memory Store Status',
      description: 'Current HRR memory store statistics and anchor hash',
      mimeType: 'application/json',
    },
  ];

  if (auth.isPro) {
    resources.push({
      uri: 'memory://nudges/queue',
      name: 'Nudge Queue',
      description: 'Proactive nudges due for surfacing to the agent',
      mimeType: 'application/json',
    });
  }

  return { resources };
});

// ─── Resource reading ─────────────────────────────────────────────────────────

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const store = getStore();
  const auth = _getAuth();
  const audit = getAuditLog(auth.isPro);

  if (uri === 'memory://store/status') {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              slotCount: store.size,
              anchor: store.anchor,
              tier: auth.tier,
              email: auth.email ?? null,
              isPro: auth.isPro,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (uri === 'memory://nudges/queue') {
    if (!auth.isPro) {
      throw new McpError(ErrorCode.InvalidRequest, 'Nudge queue requires Pro subscription.');
    }
    const scheduler = new NudgeScheduler(store, audit);
    const due = scheduler.getDueNudges();
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ nudges: due, summary: scheduler.formatNudges(due) }, null, 2),
        },
      ],
    };
  }

  throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal Zod → JSON Schema converter (covers our tool schemas).
 * Not a full implementation — handles object, string, number, boolean, array, optional.
 */
function zodToJsonSchema(schema: { _def: unknown }): Record<string, unknown> {
  return convertZodDef(schema._def as ZodDef);
}

type ZodDef =
  | { typeName: 'ZodObject'; shape: () => Record<string, { _def: ZodDef }> }
  | { typeName: 'ZodString'; checks?: { kind: string }[]; description?: string }
  | { typeName: 'ZodNumber'; checks?: { kind: string; value?: number }[]; description?: string }
  | { typeName: 'ZodBoolean'; description?: string }
  | { typeName: 'ZodArray'; type: { _def: ZodDef }; description?: string }
  | { typeName: 'ZodOptional'; innerType: { _def: ZodDef } }
  | { typeName: 'ZodDefault'; innerType: { _def: ZodDef }; defaultValue: () => unknown }
  | { typeName: 'ZodEnum'; values: string[] }
  | { typeName: 'ZodUnion'; options: { _def: ZodDef }[] }
  | { typeName: string };

function convertZodDef(def: ZodDef): Record<string, unknown> {
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, val] of Object.entries(shape)) {
        const inner = val._def as ZodDef;
        if (inner.typeName !== 'ZodOptional' && inner.typeName !== 'ZodDefault') {
          required.push(key);
        }
        properties[key] = convertZodDef(
          inner.typeName === 'ZodOptional' || inner.typeName === 'ZodDefault'
            ? (inner as { innerType: { _def: ZodDef } }).innerType._def
            : inner
        );
      }
      return { type: 'object', properties, required };
    }
    case 'ZodString':
      return { type: 'string', ...(def.description ? { description: def.description } : {}) };
    case 'ZodNumber':
      return { type: 'number', ...(def.description ? { description: def.description } : {}) };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodArray':
      return { type: 'array', items: convertZodDef(def.type._def) };
    case 'ZodOptional':
      return convertZodDef(def.innerType._def);
    case 'ZodDefault':
      return convertZodDef(def.innerType._def);
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    default:
      return {};
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[nuggets-memory-pro] MCP server running (stdio)\n`);
}

main().catch(err => {
  process.stderr.write(`[nuggets-memory-pro] Fatal: ${err}\n`);
  process.exit(1);
});
