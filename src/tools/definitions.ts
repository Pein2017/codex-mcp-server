import { TOOLS, type ToolDefinition } from '../types.js';

export const toolDefinitions: ToolDefinition[] = [
  {
    name: TOOLS.CODEX,
    description: 'Execute Codex CLI in non-interactive mode for AI assistance',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The coding task, question, or analysis request',
        },
        sessionId: {
          type: 'string',
          description:
            'Optional session ID for conversational context. Note: when resuming a session, sandbox/fullAuto/workingDirectory parameters are not applied (CLI limitation)',
        },
        resetSession: {
          type: 'boolean',
          description:
            'Reset the session history before processing this request',
        },
        model: {
          type: 'string',
          description:
            'Specify which model to use. If omitted, Codex CLI resolves its default (e.g., from ~/.codex/config.toml). Options often include: gpt-5.2-codex, gpt-5.1-codex, gpt-5.1-codex-max, gpt-5-codex, gpt-4o, gpt-4, o3, o4-mini',
        },
        reasoningEffort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description:
            'Control reasoning depth (low < medium < high). If omitted, Codex CLI resolves its default (e.g., from ~/.codex/config.toml).',
        },
        sandbox: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'danger-full-access'],
          description:
            'Sandbox policy for shell command execution. If omitted, Codex CLI resolves its default unless the MCP server sets CODEX_MCP_DEFAULT_SANDBOX. read-only: no writes allowed, workspace-write: writes only in workspace, danger-full-access: full system access (dangerous)',
        },
        fullAuto: {
          type: 'boolean',
          description:
            'Enable full-auto mode: sandboxed automatic execution without approval prompts (equivalent to -a on-request --sandbox workspace-write). Note: if an explicit sandbox is provided, fullAuto is ignored to avoid overriding the requested sandbox.',
        },
        workingDirectory: {
          type: 'string',
          description:
            'Working directory for the agent to use as its root (passed via -C flag)',
        },
      },
      required: ['prompt'],
    },
    annotations: {
      title: 'Execute Codex CLI',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: TOOLS.CODEX_SPAWN,
    description:
      'Spawn an async Codex subagent job (codex exec --json) and return a jobId immediately',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The coding task, question, or analysis request',
        },
        model: {
          type: 'string',
          description:
            'Optional model override. If omitted, Codex CLI resolves its default from ~/.codex/config.toml',
        },
        reasoningEffort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description:
            'Optional reasoning effort override. If omitted, Codex CLI uses config.toml default.',
        },
        sandbox: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'danger-full-access'],
          description:
            'Optional sandbox override. If omitted, uses CODEX_MCP_DEFAULT_SANDBOX when set.',
        },
        fullAuto: {
          type: 'boolean',
          description:
            'Enable full-auto mode for the spawned job (equivalent to -a on-request --sandbox workspace-write). Ignored if sandbox is explicitly set.',
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for the job (passed via -C flag)',
        },
      },
      required: ['prompt'],
    },
    annotations: {
      title: 'Spawn Codex Subagent',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: TOOLS.CODEX_SPAWN_GROUP,
    description:
      'Spawn multiple async Codex subagent jobs in one call (deterministic wrapper over multiple codex_spawn calls)',
    inputSchema: {
      type: 'object',
      properties: {
        defaults: {
          type: 'object',
          description:
            'Optional shared defaults applied only when a per-job field is omitted',
          properties: {
            model: {
              type: 'string',
              description:
                'Optional model override. If omitted, Codex CLI resolves its default from ~/.codex/config.toml',
            },
            reasoningEffort: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description:
                'Optional reasoning effort override. If omitted, Codex CLI uses config.toml default.',
            },
            sandbox: {
              type: 'string',
              enum: ['read-only', 'workspace-write', 'danger-full-access'],
              description:
                'Optional sandbox override. If omitted, uses CODEX_MCP_DEFAULT_SANDBOX when set.',
            },
            fullAuto: {
              type: 'boolean',
              description:
                'Enable full-auto mode for the spawned job (equivalent to -a on-request --sandbox workspace-write). Ignored if sandbox is explicitly set.',
            },
            workingDirectory: {
              type: 'string',
              description: 'Working directory for the job (passed via -C flag)',
            },
          },
        },
        jobs: {
          type: 'array',
          description: 'List of job spawn requests (partial success per entry)',
          items: {
            type: 'object',
            properties: {
              prompt: {
                type: 'string',
                description: 'The coding task, question, or analysis request',
              },
              model: {
                type: 'string',
                description:
                  'Optional model override. If omitted, Codex CLI resolves its default from ~/.codex/config.toml',
              },
              reasoningEffort: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
                description:
                  'Optional reasoning effort override. If omitted, Codex CLI uses config.toml default.',
              },
              sandbox: {
                type: 'string',
                enum: ['read-only', 'workspace-write', 'danger-full-access'],
                description:
                  'Optional sandbox override. If omitted, uses CODEX_MCP_DEFAULT_SANDBOX when set.',
              },
              fullAuto: {
                type: 'boolean',
                description:
                  'Enable full-auto mode for the spawned job (equivalent to -a on-request --sandbox workspace-write). Ignored if sandbox is explicitly set.',
              },
              workingDirectory: {
                type: 'string',
                description: 'Working directory for the job (passed via -C flag)',
              },
              label: {
                type: 'string',
                description:
                  'Optional coordinator label (server stores and echoes it; no effect on execution)',
              },
            },
            required: ['prompt'],
          },
        },
        includeHandshake: {
          type: 'boolean',
          description:
            'If true, include a small initial events page for each successfully spawned job',
        },
        handshakeMaxEvents: {
          type: 'number',
          description:
            'Max events to return in handshake per job (default 25, hard-capped)',
        },
      },
      required: ['jobs'],
    },
    annotations: {
      title: 'Spawn Group Subagents',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: TOOLS.CODEX_STATUS,
    description: 'Get status of a spawned Codex subagent job',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job identifier returned by codex_spawn' },
      },
      required: ['jobId'],
    },
    annotations: {
      title: 'Subagent Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: TOOLS.CODEX_RESULT,
    description:
      'Get the final agent message for a Codex subagent job (default). Use view=full to return status + stdout/stderr tails.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job identifier returned by codex_spawn' },
        view: {
          type: 'string',
          enum: ['full', 'finalMessage'],
          description:
            'Result view. Default returns only the final agent message as plain text; full returns status + tails.',
        },
      },
      required: ['jobId'],
    },
    annotations: {
      title: 'Subagent Result',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: TOOLS.CODEX_CANCEL,
    description: 'Cancel a running Codex subagent job',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job identifier returned by codex_spawn' },
        force: { type: 'boolean', description: 'Force kill (SIGKILL) when supported' },
      },
      required: ['jobId'],
    },
    annotations: {
      title: 'Cancel Subagent',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: TOOLS.CODEX_EVENTS,
    description: 'Poll normalized streaming events from a Codex subagent job',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job identifier returned by codex_spawn' },
        cursor: {
          type: 'string',
          description: 'Opaque cursor returned by previous codex_events call',
        },
        maxEvents: {
          type: 'number',
          description: 'Max events to return (default 200, max 2000)',
        },
      },
      required: ['jobId'],
    },
    annotations: {
      title: 'Subagent Events',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: TOOLS.CODEX_WAIT_ANY,
    description: 'Wait until any of the provided Codex subagent jobs completes (optional helper)',
    inputSchema: {
      type: 'object',
      properties: {
        jobIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of job IDs to wait on',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds (default 0 = immediate check)',
        },
      },
      required: ['jobIds'],
    },
    annotations: {
      title: 'Wait Any Subagent',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: TOOLS.CODEX_INTERRUPT,
    description:
      'Interrupt a running Codex subagent (cancel + bounded wait + respawn with injected event tail; deterministic wrapper)',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job identifier returned by codex_spawn' },
        newPrompt: {
          type: 'string',
          description: 'Updated instructions for the respawned job',
        },
        waitMs: {
          type: 'number',
          description: 'Max time to wait for cancellation before respawning (default 250, hard-capped)',
        },
        includeEventTail: {
          type: 'boolean',
          description: 'If true, inject a bounded tail of prior message/error/progress events (default true)',
        },
        tailMaxEvents: {
          type: 'number',
          description: 'Max events to inject in prompt tail (default 25, hard-capped)',
        },
        overrides: {
          type: 'object',
          description:
            'Optional overrides for the respawned job. When omitted, original effective settings are inherited.',
          properties: {
            model: {
              type: 'string',
              description:
                'Optional model override. If omitted, Codex CLI resolves its default from ~/.codex/config.toml',
            },
            reasoningEffort: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description:
                'Optional reasoning effort override. If omitted, Codex CLI uses config.toml default.',
            },
            sandbox: {
              type: 'string',
              enum: ['read-only', 'workspace-write', 'danger-full-access'],
              description:
                'Optional sandbox override. If omitted, uses original effective sandbox.',
            },
            fullAuto: {
              type: 'boolean',
              description:
                'Enable full-auto mode for the respawned job (ignored if sandbox is explicit).',
            },
            workingDirectory: {
              type: 'string',
              description: 'Working directory for the job (passed via -C flag)',
            },
          },
        },
      },
      required: ['jobId', 'newPrompt'],
    },
    annotations: {
      title: 'Interrupt Subagent',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: TOOLS.REVIEW,
    description:
      'Run a code review against the current repository using Codex CLI',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Custom review instructions or focus areas',
        },
        uncommitted: {
          type: 'boolean',
          description:
            'Review staged, unstaged, and untracked changes (working tree)',
        },
        base: {
          type: 'string',
          description:
            'Review changes against a specific base branch (e.g., "main", "develop")',
        },
        commit: {
          type: 'string',
          description: 'Review the changes introduced by a specific commit SHA',
        },
        title: {
          type: 'string',
          description: 'Optional title to display in the review summary',
        },
        model: {
          type: 'string',
          description:
            'Specify which model to use for the review. If omitted, Codex CLI resolves its default (e.g., from ~/.codex/config.toml).',
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory containing the repository to review',
        },
      },
      required: [],
    },
    annotations: {
      title: 'Code Review',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: TOOLS.PING,
    description: 'Test MCP server connection',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Message to echo back',
        },
      },
      required: [],
    },
    annotations: {
      title: 'Ping Server',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: TOOLS.HELP,
    description: 'Get Codex CLI help information',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: {
      title: 'Get Help',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: TOOLS.LIST_SESSIONS,
    description: 'List all active conversation sessions with metadata',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: {
      title: 'List Sessions',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];
