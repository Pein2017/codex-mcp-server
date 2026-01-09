import { spawn, type ChildProcess } from 'child_process';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'crypto';
import { SandboxMode, type SandboxModeValue } from '../types.js';

type JobStatus = 'running' | 'done' | 'failed' | 'canceled';

export type NormalizedEventType =
  | 'message'
  | 'progress'
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'final';

export interface NormalizedEvent {
  type: NormalizedEventType;
  content: unknown;
  timestamp: string;
}

export interface CodexWaitAnyResult {
  completedJobId: string | null;
  timedOut: boolean;
  missingJobIds?: string[];
}

export interface CodexSpawnJobArgs {
  prompt: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  sandbox?: SandboxModeValue;
  fullAuto?: boolean;
  workingDirectory?: string;
  label?: string; // coordinator-facing only; no effect on execution
}

export interface CodexJobEffectiveOptions {
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  sandbox?: SandboxModeValue;
  useFullAuto: boolean; // whether the spawned process included `--full-auto`
  workingDirectory?: string;
}

export interface CodexJobSpawnMetadata {
  requested: CodexSpawnJobArgs;
  effective: CodexJobEffectiveOptions;
  label?: string;
}

export interface CodexJobStatus {
  jobId: string;
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
}

export interface CodexJobResult extends CodexJobStatus {
  finalMessage?: string;
  stdoutTail?: string;
  stderrTail?: string;
}

const isWindows = process.platform === 'win32';

function escapeArgForWindows(arg: string): string {
  let escaped = arg.replace(/%/g, '%%');
  if (/[\s"&|<>^%]/.test(arg)) {
    escaped = `"${escaped.replace(/"/g, '""')}"`;
  }
  return escaped;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseMaxJobsFromEnv(): number {
  const raw = process.env.CODEX_MCP_MAX_JOBS;
  if (!raw) return 32;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 32;
  return parsed;
}

const MAX_OUTPUT_BUFFER_BYTES = 2 * 1024 * 1024; // keep last ~2MB per stream
function appendTail(current: string, chunk: string, maxBytes: number): string {
  if (chunk.length === 0) return current;
  const combined = current + chunk;
  if (Buffer.byteLength(combined, 'utf8') <= maxBytes) return combined;
  // Truncate from the front. Approximate by slicing chars, then re-check.
  let start = Math.max(0, combined.length - maxBytes);
  let sliced = combined.slice(start);
  while (Buffer.byteLength(sliced, 'utf8') > maxBytes && start < combined.length) {
    start += Math.ceil((combined.length - start) / 10);
    sliced = combined.slice(start);
  }
  return sliced;
}

function normalizeThreadEvent(rawEvent: unknown): NormalizedEvent | null {
  if (!rawEvent || typeof rawEvent !== 'object') return null;
  const ev = rawEvent as Record<string, unknown>;
  const type = ev.type;
  if (typeof type !== 'string') return null;

  const stamp = nowIso();

  // Top-level lifecycle events.
  if (type === 'thread.started') {
    return {
      type: 'progress',
      timestamp: stamp,
      content: { threadId: (ev as any).thread_id },
    };
  }
  if (type === 'turn.started') {
    return { type: 'progress', timestamp: stamp, content: { kind: 'turn.started' } };
  }
  if (type === 'turn.completed') {
    return {
      type: 'progress',
      timestamp: stamp,
      content: { kind: 'turn.completed', usage: (ev as any).usage },
    };
  }
  if (type === 'turn.failed') {
    return {
      type: 'error',
      timestamp: stamp,
      content: { kind: 'turn.failed', error: (ev as any).error },
    };
  }
  if (type === 'error') {
    return { type: 'error', timestamp: stamp, content: ev };
  }

  // Item events.
  if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    const item = (ev as any).item as Record<string, unknown> | undefined;
    const itemType = item?.type;
    if (typeof itemType !== 'string') {
      return { type: 'progress', timestamp: stamp, content: { kind: type, item } };
    }

    const itemId = item?.id;
    const base = { kind: type, itemType, itemId };

    switch (itemType) {
      case 'agent_message':
        return {
          type: 'message',
          timestamp: stamp,
          content: { ...base, text: (item as any).text },
        };
      case 'reasoning':
        return {
          type: 'progress',
          timestamp: stamp,
          content: { ...base, text: (item as any).text },
        };
      case 'command_execution':
        // This represents shell/unified exec tool work, not MCP.
        return {
          type: type === 'item.completed' ? 'tool_result' : 'tool_call',
          timestamp: stamp,
          content: {
            ...base,
            command: (item as any).command,
            status: (item as any).status,
            exitCode: (item as any).exit_code,
          },
        };
      case 'file_change':
        return {
          type: type === 'item.completed' ? 'tool_result' : 'tool_call',
          timestamp: stamp,
          content: { ...base, changes: (item as any).changes, status: (item as any).status },
        };
      case 'mcp_tool_call':
        return {
          type: type === 'item.completed' ? 'tool_result' : 'tool_call',
          timestamp: stamp,
          content: {
            ...base,
            server: (item as any).server,
            tool: (item as any).tool,
            status: (item as any).status,
            arguments: (item as any).arguments,
            result: (item as any).result,
            error: (item as any).error,
          },
        };
      case 'web_search':
        return {
          type: type === 'item.completed' ? 'tool_result' : 'tool_call',
          timestamp: stamp,
          content: { ...base, query: (item as any).query },
        };
      case 'todo_list':
        return {
          type: 'progress',
          timestamp: stamp,
          content: { ...base, items: (item as any).items },
        };
      case 'error':
        return {
          type: 'error',
          timestamp: stamp,
          content: { ...base, message: (item as any).message },
        };
      default:
        return { type: 'progress', timestamp: stamp, content: { ...base, item } };
    }
  }

  // Unknown event: keep it as progress so it is visible.
  return { type: 'progress', timestamp: stamp, content: ev };
}

interface JobRecord {
  jobId: string;
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  cancelRequested: boolean;
  child: ChildProcess;
  stdoutTail: string;
  stderrTail: string;
  events: NormalizedEvent[];
  lastAgentMessage?: string;
  spawnMetadata: CodexJobSpawnMetadata;
  turnCompleted: boolean;
  resolveCompletion: () => void;
  completion: Promise<void>;
  stdoutRemainder: string;
}

export class CodexJobManager {
  private readonly jobs = new Map<string, JobRecord>();

  spawnCodexJob(args: CodexSpawnJobArgs): CodexJobStatus {
    const envDefaultSandbox = process.env.CODEX_MCP_DEFAULT_SANDBOX;
    const parsedEnvSandbox = envDefaultSandbox ? SandboxMode.safeParse(envDefaultSandbox) : null;
    const sandboxFromEnv = parsedEnvSandbox?.success ? parsedEnvSandbox.data : undefined;
    const effectiveSandbox =
      args.sandbox ?? sandboxFromEnv ?? (args.fullAuto ? undefined : 'workspace-write');
    const effectiveUseFullAuto = Boolean(args.fullAuto && !effectiveSandbox);

    const cmdArgs: string[] = ['exec', '--json'];

    if (args.model) cmdArgs.push('--model', args.model);
    if (args.reasoningEffort) {
      cmdArgs.push('-c', `model_reasoning_effort="${args.reasoningEffort}"`);
    }
    if (effectiveSandbox) {
      cmdArgs.push('--sandbox', effectiveSandbox);
    }
    if (effectiveUseFullAuto) {
      cmdArgs.push('--full-auto');
    }
    if (args.workingDirectory) {
      cmdArgs.push('-C', args.workingDirectory);
    }
    cmdArgs.push('--skip-git-repo-check');
    cmdArgs.push(args.prompt);

    const spawnMetadata: CodexJobSpawnMetadata = {
      requested: { ...args },
      effective: {
        model: args.model,
        reasoningEffort: args.reasoningEffort,
        sandbox: effectiveSandbox,
        useFullAuto: effectiveUseFullAuto,
        workingDirectory: args.workingDirectory,
      },
      label: args.label,
    };

    return this.spawnJob(cmdArgs, spawnMetadata);
  }

  spawnCodexJobWithEffectiveOptions(args: {
    prompt: string;
    effective: CodexJobEffectiveOptions;
    label?: string;
  }): CodexJobStatus {
    const sandbox = args.effective.sandbox;
    const useFullAuto = Boolean(args.effective.useFullAuto && !sandbox);

    const cmdArgs: string[] = ['exec', '--json'];

    if (args.effective.model) cmdArgs.push('--model', args.effective.model);
    if (args.effective.reasoningEffort) {
      cmdArgs.push('-c', `model_reasoning_effort="${args.effective.reasoningEffort}"`);
    }
    if (sandbox) {
      cmdArgs.push('--sandbox', sandbox);
    }
    if (useFullAuto) {
      cmdArgs.push('--full-auto');
    }
    if (args.effective.workingDirectory) {
      cmdArgs.push('-C', args.effective.workingDirectory);
    }
    cmdArgs.push('--skip-git-repo-check');
    cmdArgs.push(args.prompt);

    const spawnMetadata: CodexJobSpawnMetadata = {
      requested: {
        prompt: args.prompt,
        model: args.effective.model,
        reasoningEffort: args.effective.reasoningEffort,
        sandbox,
        fullAuto: useFullAuto,
        workingDirectory: args.effective.workingDirectory,
        label: args.label,
      },
      effective: {
        model: args.effective.model,
        reasoningEffort: args.effective.reasoningEffort,
        sandbox,
        useFullAuto,
        workingDirectory: args.effective.workingDirectory,
      },
      label: args.label,
    };

    return this.spawnJob(cmdArgs, spawnMetadata);
  }

  getStatus(jobId: string): CodexJobStatus {
    const job = this.requireJob(jobId);
    return {
      jobId: job.jobId,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
    };
  }

  getResult(jobId: string): CodexJobResult {
    const job = this.requireJob(jobId);
    return {
      ...this.getStatus(jobId),
      finalMessage: job.lastAgentMessage,
      stdoutTail: job.stdoutTail || undefined,
      stderrTail: job.stderrTail || undefined,
    };
  }

  cancel(jobId: string, force = false): { success: boolean } {
    const job = this.requireJob(jobId);
    if (job.status !== 'running') return { success: false };
    job.cancelRequested = true;

    if (force) {
      job.child.kill('SIGKILL');
      return { success: true };
    }

    job.child.kill();
    return { success: true };
  }

  getSpawnMetadata(jobId: string): CodexJobSpawnMetadata {
    const job = this.requireJob(jobId);
    // Return a defensive copy so callers cannot mutate internal state.
    return {
      requested: { ...job.spawnMetadata.requested },
      effective: { ...job.spawnMetadata.effective },
      ...(job.spawnMetadata.label ? { label: job.spawnMetadata.label } : {}),
    };
  }

  getEventTail(
    jobId: string,
    maxEvents: number,
    allowedTypes?: NormalizedEventType[]
  ): NormalizedEvent[] {
    const job = this.requireJob(jobId);
    const limit = Math.max(0, Math.trunc(maxEvents));
    if (limit === 0) return [];

    const allowed = allowedTypes ? new Set<NormalizedEventType>(allowedTypes) : null;
    const filtered = allowed ? job.events.filter((e) => allowed.has(e.type)) : job.events;
    return filtered.slice(Math.max(0, filtered.length - limit));
  }

  async waitForExit(jobId: string, waitMs: number): Promise<{ exited: boolean }> {
    const job = this.requireJob(jobId);
    if (job.status !== 'running') return { exited: true };

    const ms = Math.max(0, Math.trunc(waitMs));
    if (ms === 0) return { exited: false };

    const timeout = new Promise<false>((resolve) => {
      setTimeout(() => resolve(false), ms);
    });

    const exited = await Promise.race([
      job.completion.then(() => true as const),
      timeout,
    ]);

    return { exited };
  }

  getEvents(
    jobId: string,
    cursor: string | undefined,
    maxEvents: number
  ): { events: NormalizedEvent[]; nextCursor: string; done: boolean } {
    const job = this.requireJob(jobId);
    const start = cursor ? Number.parseInt(cursor, 10) : 0;
    const safeStart = Number.isFinite(start) && start >= 0 ? start : 0;
    const endExclusive = Math.min(job.events.length, safeStart + Math.max(1, maxEvents));
    const slice = job.events.slice(safeStart, endExclusive);
    return {
      events: slice,
      nextCursor: String(endExclusive),
      done: job.status !== 'running',
    };
  }

  async waitAny(jobIds: string[], timeoutMs: number): Promise<CodexWaitAnyResult> {
    const missingJobIds = jobIds.filter((id) => !this.jobs.has(id));
    const knownJobIds = jobIds.filter((id) => this.jobs.has(id));

    if (knownJobIds.length === 0) {
      return {
        completedJobId: null,
        timedOut: false,
        ...(missingJobIds.length > 0 ? { missingJobIds } : {}),
      };
    }

    const immediate = knownJobIds.find((id) => {
      const job = this.jobs.get(id);
      return job && job.status !== 'running';
    });
    if (immediate) {
      return {
        completedJobId: immediate,
        timedOut: false,
        ...(missingJobIds.length > 0 ? { missingJobIds } : {}),
      };
    }

    const jobs = knownJobIds.map((id) => this.jobs.get(id)).filter(Boolean) as JobRecord[];
    if (jobs.length === 0) {
      return {
        completedJobId: null,
        timedOut: false,
        ...(missingJobIds.length > 0 ? { missingJobIds } : {}),
      };
    }

    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), Math.max(0, timeoutMs));
    });

    const winner = await Promise.race([
      ...jobs.map(async (j) => {
        await j.completion;
        return j.jobId;
      }),
      timeout,
    ]);

    if (typeof winner === 'string') {
      return {
        completedJobId: winner,
        timedOut: false,
        ...(missingJobIds.length > 0 ? { missingJobIds } : {}),
      };
    }

    return {
      completedJobId: null,
      timedOut: true,
      ...(missingJobIds.length > 0 ? { missingJobIds } : {}),
    };
  }

  private consumeStdoutJsonl(jobId: string, chunk: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.stdoutRemainder += chunk;
    while (true) {
      const idx = job.stdoutRemainder.indexOf('\n');
      if (idx < 0) break;
      const line = job.stdoutRemainder.slice(0, idx).trim();
      job.stdoutRemainder = job.stdoutRemainder.slice(idx + 1);
      if (!line) continue;

      try {
        const parsed = JSON.parse(line) as unknown;
        const normalized = normalizeThreadEvent(parsed);
        if (normalized) {
          job.events.push(normalized);
          if (normalized.type === 'message') {
            const text = (normalized.content as any)?.text;
            if (typeof text === 'string') {
              job.lastAgentMessage = text;
            }
          }
          if (normalized.type === 'progress') {
            const kind = (normalized.content as any)?.kind;
            if (kind === 'turn.completed') {
              job.turnCompleted = true;
            }
          }
        }
      } catch (err) {
        job.events.push({
          type: 'error',
          timestamp: nowIso(),
          content: { message: 'Failed to parse codex JSONL event', line, error: String(err) },
        });
      }
    }
  }

  private requireJob(jobId: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown jobId: ${jobId}`);
    }
    return job;
  }

  private spawnJob(cmdArgs: string[], spawnMetadata: CodexJobSpawnMetadata): CodexJobStatus {
    const maxJobs = parseMaxJobsFromEnv();
    const running = Array.from(this.jobs.values()).filter((j) => j.status === 'running').length;
    if (running >= maxJobs) {
      throw new Error(
        `Too many concurrent jobs: ${running} running (max ${maxJobs}). Set CODEX_MCP_MAX_JOBS to override.`
      );
    }

    const jobId = randomUUID();
    const startedAt = nowIso();

    const escapedArgs = isWindows ? cmdArgs.map(escapeArgForWindows) : cmdArgs;

    const child = spawn('codex', escapedArgs, {
      shell: isWindows,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolveCompletion: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    const record: JobRecord = {
      jobId,
      status: 'running',
      startedAt,
      cancelRequested: false,
      child,
      stdoutTail: '',
      stderrTail: '',
      events: [],
      spawnMetadata,
      turnCompleted: false,
      resolveCompletion,
      completion,
      stdoutRemainder: '',
    };

    this.jobs.set(jobId, record);

    child.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      record.stdoutTail = appendTail(record.stdoutTail, chunk, MAX_OUTPUT_BUFFER_BYTES);
      this.consumeStdoutJsonl(jobId, chunk);
    });

    child.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      record.stderrTail = appendTail(record.stderrTail, chunk, MAX_OUTPUT_BUFFER_BYTES);
      // Stderr is typically logs; keep it available via result/status.
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      const finishedAt = nowIso();
      record.exitCode = code;
      record.exitSignal = signal;
      record.finishedAt = finishedAt;

      // Treat cancellation as authoritative unless the job clearly completed its turn.
      // Codex CLI may handle SIGTERM gracefully and exit 0 with no exitSignal; in that case
      // the process can look "done" even though it was interrupted mid-turn.
      if (record.cancelRequested && !record.turnCompleted) {
        record.status = 'canceled';
      } else if (code === 0) {
        record.status = 'done';
      } else {
        record.status = 'failed';
      }

      record.events.push({
        type: 'final',
        timestamp: finishedAt,
        content: {
          jobId,
          status: record.status,
          exitCode: code,
          exitSignal: signal,
          lastMessage: record.lastAgentMessage,
        },
      });

      record.resolveCompletion();
    });

    child.on('error', (err) => {
      const stamp = nowIso();
      record.status = record.cancelRequested ? 'canceled' : 'failed';
      record.finishedAt = stamp;
      record.events.push({ type: 'error', timestamp: stamp, content: { message: String(err) } });
      record.resolveCompletion();
    });

    record.events.push({
      type: 'progress',
      timestamp: startedAt,
      content: {
        jobId,
        kind: 'spawned',
        command: 'codex',
        args: cmdArgs,
        effectiveSandbox: spawnMetadata.effective.sandbox ?? null,
        label: spawnMetadata.label ?? null,
      },
    });

    return { jobId, status: 'running', startedAt };
  }
}
