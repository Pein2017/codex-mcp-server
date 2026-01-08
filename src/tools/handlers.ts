import {
  TOOLS,
  type ToolResult,
  type ToolHandlerContext,
  type CodexToolArgs,
  type CodexSpawnToolArgs,
  type CodexJobIdArgs,
  type CodexResultToolArgs,
  type CodexCancelToolArgs,
  type CodexEventsToolArgs,
  type CodexWaitAnyToolArgs,
  type ReviewToolArgs,
  type PingToolArgs,
  SandboxMode,
  CodexToolSchema,
  CodexSpawnToolSchema,
  CodexJobIdSchema,
  CodexResultToolSchema,
  CodexCancelToolSchema,
  CodexEventsToolSchema,
  CodexWaitAnyToolSchema,
  ReviewToolSchema,
  PingToolSchema,
  HelpToolSchema,
  ListSessionsToolSchema,
} from '../types.js';
import {
  InMemorySessionStorage,
  type SessionStorage,
  type ConversationTurn,
} from '../session/storage.js';
import { ToolExecutionError, ValidationError } from '../errors.js';
import { executeCommand, executeCommandStreaming } from '../utils/command.js';
import { ZodError } from 'zod';
import { CodexJobManager } from '../jobs/job_manager.js';

// Default no-op context for handlers that don't need progress
const defaultContext: ToolHandlerContext = {
  sendProgress: async () => {},
};

const jobManager = new CodexJobManager();

export class CodexToolHandler {
  constructor(private sessionStorage: SessionStorage) {}

  async execute(
    args: unknown,
    context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      const {
        prompt,
        sessionId,
        resetSession,
        model,
        reasoningEffort,
        sandbox: requestedSandbox,
        fullAuto,
        workingDirectory,
      }: CodexToolArgs = CodexToolSchema.parse(args);

      // Default sandbox for subagent runs (optional, configured by MCP server env)
      // - If caller passes `sandbox`, it wins.
      // - If caller omits `sandbox`, and CODEX_MCP_DEFAULT_SANDBOX is set to a valid mode,
      //   use it to keep subagent permission consistent without repeating parameters.
      const envDefaultSandbox = process.env.CODEX_MCP_DEFAULT_SANDBOX;
      const parsedEnvSandbox = envDefaultSandbox
        ? SandboxMode.safeParse(envDefaultSandbox)
        : null;
      const sandbox =
        requestedSandbox ?? (parsedEnvSandbox?.success ? parsedEnvSandbox.data : undefined);

      let activeSessionId = sessionId;
      let enhancedPrompt = prompt;

      // Only work with sessions if explicitly requested
      let useResume = false;
      let codexConversationId: string | undefined;

      if (sessionId) {
        if (resetSession) {
          this.sessionStorage.resetSession(sessionId);
        }

        codexConversationId =
          this.sessionStorage.getCodexConversationId(sessionId);
        if (codexConversationId) {
          useResume = true;
        } else {
          // Fallback to manual context building if no codex conversation ID
          const session = this.sessionStorage.getSession(sessionId);
          if (
            session &&
            Array.isArray(session.turns) &&
            session.turns.length > 0
          ) {
            enhancedPrompt = this.buildEnhancedPrompt(session.turns, prompt);
          }
        }
      }

      // Build command arguments with v0.75.0+ features
      // IMPORTANT: For "inherit config.toml" behavior, only set model when explicitly provided.
      // Otherwise, let Codex CLI resolve its default model/profile from ~/.codex/config.toml.
      const selectedModel = model;

      let cmdArgs: string[];

      if (useResume && codexConversationId) {
        // Resume mode: codex exec resume has limited flags
        // All exec options (--skip-git-repo-check, -c) must come BEFORE 'resume' subcommand
        cmdArgs = ['exec', '--skip-git-repo-check'];

        // Model must be set via -c config in resume mode (before subcommand) if explicitly provided.
        if (selectedModel) {
          cmdArgs.push('-c', `model="${selectedModel}"`);
        }

        // Reasoning effort via config (before subcommand)
        if (reasoningEffort) {
          cmdArgs.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
        }

        // Add resume subcommand with conversation ID and prompt
        cmdArgs.push('resume', codexConversationId, enhancedPrompt);
      } else {
        // Exec mode: supports full set of flags
        cmdArgs = ['exec'];

        // Add model parameter only when explicitly provided (inherit config.toml otherwise)
        if (selectedModel) {
          cmdArgs.push('--model', selectedModel);
        }

        // Add reasoning effort via config parameter (quoted for consistency)
        if (reasoningEffort) {
          cmdArgs.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
        }

        // Add sandbox mode (v0.75.0+)
        if (sandbox) {
          cmdArgs.push('--sandbox', sandbox);
        }

        // Add full-auto mode (v0.75.0+)
        // Note: --full-auto implies --sandbox workspace-write, so ignore it when sandbox is explicit.
        if (fullAuto && !sandbox) {
          cmdArgs.push('--full-auto');
        }

        // Add working directory (v0.75.0+)
        if (workingDirectory) {
          cmdArgs.push('-C', workingDirectory);
        }

        // Skip git repo check for v0.50.0+
        cmdArgs.push('--skip-git-repo-check');

        cmdArgs.push(enhancedPrompt);
      }

      // Send initial progress notification
      await context.sendProgress('Starting Codex execution...', 0);

      // Use streaming execution if progress is enabled
      const useStreaming = !!context.progressToken;
      const result = useStreaming
        ? await executeCommandStreaming('codex', cmdArgs, {
            onProgress: (message) => {
              // Send progress notification for each chunk of output
              context.sendProgress(message);
            },
          })
        : await executeCommand('codex', cmdArgs);

      // Codex CLI may output to stderr, so check both
      const response = result.stdout || result.stderr || 'No output from Codex';

      // Extract session ID from new conversations for future resume
      // Note: Codex v0.75.0 uses "session id:" format
      if (activeSessionId && !useResume) {
        const conversationIdMatch = result.stderr?.match(
          /session\s*id\s*:\s*([a-zA-Z0-9-]+)/i
        );
        if (conversationIdMatch) {
          this.sessionStorage.setCodexConversationId(
            activeSessionId,
            conversationIdMatch[1]
          );
        }
      }

      // Save turn only if using a session
      if (activeSessionId) {
        const turn: ConversationTurn = {
          prompt,
          response,
          timestamp: new Date(),
        };
        this.sessionStorage.addTurn(activeSessionId, turn);
      }

      return {
        content: [
          {
            type: 'text',
            text: response,
          },
        ],
        _meta: {
          ...(activeSessionId && { sessionId: activeSessionId }),
          ...(selectedModel && { model: selectedModel }),
        },
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.CODEX, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.CODEX,
        'Failed to execute codex command',
        error
      );
    }
  }

  private buildEnhancedPrompt(
    turns: ConversationTurn[],
    newPrompt: string
  ): string {
    if (turns.length === 0) return newPrompt;

    // Get relevant context from recent turns
    const recentTurns = turns.slice(-2);
    const contextualInfo = recentTurns
      .map((turn) => {
        // Extract key information without conversational format
        if (
          turn.response.includes('function') ||
          turn.response.includes('def ')
        ) {
          return `Previous code context: ${turn.response.slice(0, 200)}...`;
        }
        return `Context: ${turn.prompt} -> ${turn.response.slice(0, 100)}...`;
      })
      .join('\n');

    // Build enhanced prompt that provides context without conversation format
    return `${contextualInfo}\n\nTask: ${newPrompt}`;
  }
}

export class CodexSpawnToolHandler {
  async execute(
    args: unknown,
    context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      const parsed: CodexSpawnToolArgs = CodexSpawnToolSchema.parse(args);

      await context.sendProgress('Spawning Codex subagent...', 0);

      const status = jobManager.spawnCodexJob({
        prompt: parsed.prompt,
        model: parsed.model,
        reasoningEffort: parsed.reasoningEffort,
        sandbox: parsed.sandbox,
        fullAuto: parsed.fullAuto,
        workingDirectory: parsed.workingDirectory,
      });

      await context.sendProgress(`Spawned job ${status.jobId}`, 1);

      return {
        content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
        _meta: { jobId: status.jobId },
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.CODEX_SPAWN, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.CODEX_SPAWN,
        'Failed to spawn codex job',
        error
      );
    }
  }
}

export class CodexStatusToolHandler {
  async execute(
    args: unknown,
    _context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      const parsed: CodexJobIdArgs = CodexJobIdSchema.parse(args);
      const status = jobManager.getStatus(parsed.jobId);
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.CODEX_STATUS, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.CODEX_STATUS,
        'Failed to get codex job status',
        error
      );
    }
  }
}

export class CodexResultToolHandler {
  async execute(
    args: unknown,
    _context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      const parsed: CodexResultToolArgs = CodexResultToolSchema.parse(args);
      const result = jobManager.getResult(parsed.jobId);

      if (parsed.view === 'finalMessage') {
        return { content: [{ type: 'text', text: result.finalMessage ?? '' }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.CODEX_RESULT, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.CODEX_RESULT,
        'Failed to get codex job result',
        error
      );
    }
  }
}

export class CodexCancelToolHandler {
  async execute(
    args: unknown,
    _context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      const parsed: CodexCancelToolArgs = CodexCancelToolSchema.parse(args);
      const cancelled = jobManager.cancel(parsed.jobId, parsed.force ?? false);
      return {
        content: [{ type: 'text', text: JSON.stringify(cancelled, null, 2) }],
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.CODEX_CANCEL, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.CODEX_CANCEL,
        'Failed to cancel codex job',
        error
      );
    }
  }
}

export class CodexEventsToolHandler {
  async execute(
    args: unknown,
    _context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      const parsed: CodexEventsToolArgs = CodexEventsToolSchema.parse(args);
      const maxEvents = parsed.maxEvents ?? 200;
      const out = jobManager.getEvents(parsed.jobId, parsed.cursor, maxEvents);
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.CODEX_EVENTS, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.CODEX_EVENTS,
        'Failed to fetch codex job events',
        error
      );
    }
  }
}

export class CodexWaitAnyToolHandler {
  async execute(
    args: unknown,
    _context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      const parsed: CodexWaitAnyToolArgs = CodexWaitAnyToolSchema.parse(args);
      const timeoutMs = parsed.timeoutMs ?? 0;
      const out = await jobManager.waitAny(parsed.jobIds, timeoutMs);
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.CODEX_WAIT_ANY, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.CODEX_WAIT_ANY,
        'Failed to wait for any codex job to complete',
        error
      );
    }
  }
}

export class PingToolHandler {
  async execute(
    args: unknown,
    _context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      const { message = 'pong' }: PingToolArgs = PingToolSchema.parse(args);

      return {
        content: [
          {
            type: 'text',
            text: message,
          },
        ],
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.PING, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.PING,
        'Failed to execute ping command',
        error
      );
    }
  }
}

export class HelpToolHandler {
  async execute(
    args: unknown,
    _context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      HelpToolSchema.parse(args);

      const result = await executeCommand('codex', ['--help']);

      return {
        content: [
          {
            type: 'text',
            text: result.stdout || 'No help information available',
          },
        ],
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.HELP, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.HELP,
        'Failed to execute help command',
        error
      );
    }
  }
}

export class ListSessionsToolHandler {
  constructor(private sessionStorage: SessionStorage) {}

  async execute(
    args: unknown,
    _context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      ListSessionsToolSchema.parse(args);

      const sessions = this.sessionStorage.listSessions();
      const sessionInfo = sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        lastAccessedAt: session.lastAccessedAt.toISOString(),
        turnCount: session.turns.length,
      }));

      return {
        content: [
          {
            type: 'text',
            text:
              sessionInfo.length > 0
                ? JSON.stringify(sessionInfo, null, 2)
                : 'No active sessions',
          },
        ],
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.LIST_SESSIONS, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.LIST_SESSIONS,
        'Failed to list sessions',
        error
      );
    }
  }
}

export class ReviewToolHandler {
  async execute(
    args: unknown,
    context: ToolHandlerContext = defaultContext
  ): Promise<ToolResult> {
    try {
      const {
        prompt,
        uncommitted,
        base,
        commit,
        title,
        model,
        workingDirectory,
      }: ReviewToolArgs = ReviewToolSchema.parse(args);

      // Build command arguments for codex exec review
      // All exec options (-C, --skip-git-repo-check, -c) must come BEFORE 'review' subcommand
      const cmdArgs = ['exec'];

      // Add working directory if specified (must be before subcommand)
      if (workingDirectory) {
        cmdArgs.push('-C', workingDirectory);
      }

      // Skip git repo check (required for running outside trusted directories)
      cmdArgs.push('--skip-git-repo-check');

      // Add model parameter only when explicitly provided (inherit config.toml otherwise)
      if (model) {
        cmdArgs.push('-c', `model="${model}"`);
      }

      // Add the review subcommand
      cmdArgs.push('review');

      // Add review-specific flags
      if (uncommitted) {
        cmdArgs.push('--uncommitted');
      }

      if (base) {
        cmdArgs.push('--base', base);
      }

      if (commit) {
        cmdArgs.push('--commit', commit);
      }

      if (title) {
        cmdArgs.push('--title', title);
      }

      // Add custom review instructions if provided
      if (prompt) {
        cmdArgs.push(prompt);
      }

      // Send initial progress notification
      await context.sendProgress('Starting code review...', 0);

      // Use streaming execution if progress is enabled
      const useStreaming = !!context.progressToken;
      const result = useStreaming
        ? await executeCommandStreaming('codex', cmdArgs, {
            onProgress: (message) => {
              context.sendProgress(message);
            },
          })
        : await executeCommand('codex', cmdArgs);

      // Codex CLI outputs to stderr, so check both stdout and stderr
      const response =
        result.stdout || result.stderr || 'No review output from Codex';

      return {
        content: [
          {
            type: 'text',
            text: response,
          },
        ],
        _meta: {
          ...(model && { model }),
          ...(base && { base }),
          ...(commit && { commit }),
        },
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(TOOLS.REVIEW, error.message);
      }
      throw new ToolExecutionError(
        TOOLS.REVIEW,
        'Failed to execute code review',
        error
      );
    }
  }
}

// Tool handler registry
const sessionStorage = new InMemorySessionStorage();

export const toolHandlers = {
  [TOOLS.CODEX]: new CodexToolHandler(sessionStorage),
  [TOOLS.CODEX_SPAWN]: new CodexSpawnToolHandler(),
  [TOOLS.CODEX_STATUS]: new CodexStatusToolHandler(),
  [TOOLS.CODEX_RESULT]: new CodexResultToolHandler(),
  [TOOLS.CODEX_CANCEL]: new CodexCancelToolHandler(),
  [TOOLS.CODEX_EVENTS]: new CodexEventsToolHandler(),
  [TOOLS.CODEX_WAIT_ANY]: new CodexWaitAnyToolHandler(),
  [TOOLS.REVIEW]: new ReviewToolHandler(),
  [TOOLS.PING]: new PingToolHandler(),
  [TOOLS.HELP]: new HelpToolHandler(),
  [TOOLS.LIST_SESSIONS]: new ListSessionsToolHandler(sessionStorage),
} as const;
