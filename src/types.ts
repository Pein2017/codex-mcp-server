import { z } from 'zod';

// Tool constants
export const TOOLS = {
  CODEX: 'codex',
  REVIEW: 'review',
  PING: 'ping',
  HELP: 'help',
  LIST_SESSIONS: 'listSessions',
  CODEX_SPAWN: 'codex_spawn',
  CODEX_STATUS: 'codex_status',
  CODEX_RESULT: 'codex_result',
  CODEX_CANCEL: 'codex_cancel',
  CODEX_EVENTS: 'codex_events',
  CODEX_WAIT_ANY: 'codex_wait_any',
} as const;

export type ToolName = typeof TOOLS[keyof typeof TOOLS];

// Tool annotations for MCP 2025-11-25 spec
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// Tool definition interface
export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  annotations?: ToolAnnotations;
}

// Tool result interface matching MCP SDK expectations
export interface ToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

// Server configuration
export interface ServerConfig {
  name: string;
  version: string;
}

// Sandbox mode enum
export const SandboxMode = z.enum([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);
export type SandboxModeValue = z.infer<typeof SandboxMode>;

// Zod schemas for tool arguments
export const CodexToolSchema = z.object({
  prompt: z.string(),
  sessionId: z.string().optional(),
  resetSession: z.boolean().optional(),
  model: z.string().optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  sandbox: SandboxMode.optional(),
  fullAuto: z.boolean().optional(),
  workingDirectory: z.string().optional(),
});

// Async job (subagent) schemas.
// Note: these are intentionally single-turn. Persistent multi-turn context remains handled by `codex` + sessionId.
export const CodexSpawnToolSchema = z.object({
  prompt: z.string(),
  model: z.string().optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  sandbox: SandboxMode.optional(),
  fullAuto: z.boolean().optional(),
  workingDirectory: z.string().optional(),
});

export const CodexJobIdSchema = z.object({
  jobId: z.string(),
});

export const CodexResultToolSchema = z.object({
  jobId: z.string(),
  view: z.enum(['full', 'finalMessage']).optional(),
});

export const CodexEventsToolSchema = z.object({
  jobId: z.string(),
  cursor: z.string().optional(),
  maxEvents: z.number().int().positive().max(2000).optional(),
});

export const CodexCancelToolSchema = z.object({
  jobId: z.string(),
  force: z.boolean().optional(),
});

export const CodexWaitAnyToolSchema = z.object({
  jobIds: z.array(z.string()).min(1),
  timeoutMs: z.number().int().nonnegative().max(5 * 60 * 1000).optional(),
});

// Review tool schema
export const ReviewToolSchema = z.object({
  prompt: z.string().optional(),
  uncommitted: z.boolean().optional(),
  base: z.string().optional(),
  commit: z.string().optional(),
  title: z.string().optional(),
  model: z.string().optional(),
  workingDirectory: z.string().optional(),
});

export const PingToolSchema = z.object({
  message: z.string().optional(),
});

export const HelpToolSchema = z.object({});

export const ListSessionsToolSchema = z.object({});

export type CodexToolArgs = z.infer<typeof CodexToolSchema>;
export type ReviewToolArgs = z.infer<typeof ReviewToolSchema>;
export type PingToolArgs = z.infer<typeof PingToolSchema>;
export type ListSessionsToolArgs = z.infer<typeof ListSessionsToolSchema>;
export type CodexSpawnToolArgs = z.infer<typeof CodexSpawnToolSchema>;
export type CodexJobIdArgs = z.infer<typeof CodexJobIdSchema>;
export type CodexResultToolArgs = z.infer<typeof CodexResultToolSchema>;
export type CodexEventsToolArgs = z.infer<typeof CodexEventsToolSchema>;
export type CodexCancelToolArgs = z.infer<typeof CodexCancelToolSchema>;
export type CodexWaitAnyToolArgs = z.infer<typeof CodexWaitAnyToolSchema>;

// Command execution result
export interface CommandResult {
  stdout: string;
  stderr: string;
}

// Progress token from MCP request metadata
export type ProgressToken = string | number;

// Context passed to tool handlers for sending progress notifications
export interface ToolHandlerContext {
  progressToken?: ProgressToken;
  sendProgress: (message: string, progress?: number, total?: number) => Promise<void>;
}
