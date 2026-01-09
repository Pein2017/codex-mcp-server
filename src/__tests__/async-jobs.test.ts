import { EventEmitter } from 'events';

// Mock chalk to avoid ESM issues in Jest
jest.mock('chalk', () => ({
  default: {
    blue: (text: string) => text,
    yellow: (text: string) => text,
    green: (text: string) => text,
    red: (text: string) => text,
  },
}));

const spawnMock = jest.fn();
jest.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import {
  CodexSpawnToolHandler,
  CodexSpawnGroupToolHandler,
  CodexStatusToolHandler,
  CodexResultToolHandler,
  CodexCancelToolHandler,
  CodexEventsToolHandler,
  CodexWaitAnyToolHandler,
  CodexInterruptToolHandler,
} from '../tools/handlers.js';

function makeMockChildProcess() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe('Async subagent jobs', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  test('codex_spawn returns jobId immediately; status/result/events reflect progress', async () => {
    const child = makeMockChildProcess();
    spawnMock.mockReturnValue(child);

    const spawnHandler = new CodexSpawnToolHandler();
    const statusHandler = new CodexStatusToolHandler();
    const resultHandler = new CodexResultToolHandler();
    const eventsHandler = new CodexEventsToolHandler();
    const waitAnyHandler = new CodexWaitAnyToolHandler();

    const spawnRes = await spawnHandler.execute({
      prompt: 'Say hello',
      sandbox: 'read-only',
      workingDirectory: '/data/Qwen3-VL',
    });

    const status0 = JSON.parse(spawnRes.content[0].text) as { jobId: string };
    expect(typeof status0.jobId).toBe('string');

    const statusRunning = JSON.parse(
      (await statusHandler.execute({ jobId: status0.jobId })).content[0].text
    ) as { status: string };
    expect(statusRunning.status).toBe('running');

    const wait0 = JSON.parse(
      (await waitAnyHandler.execute({ jobIds: [status0.jobId], timeoutMs: 0 })).content[0].text
    ) as { completedJobId: string | null; timedOut: boolean };
    expect(wait0.completedJobId).toBeNull();
    expect(wait0.timedOut).toBe(true);

    // Emit a codex JSONL agent message event (stdout).
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'item.completed',
          item: { id: '1', type: 'agent_message', text: 'hello from subagent' },
        }) + '\n'
      )
    );

    // Finish the process.
    child.emit('close', 0);

    const defaultFinalMessage = (await resultHandler.execute({ jobId: status0.jobId }))
      .content[0].text;
    expect(defaultFinalMessage).toBe('hello from subagent');

    const fullResult = JSON.parse(
      (await resultHandler.execute({ jobId: status0.jobId, view: 'full' })).content[0].text
    ) as { status: string; finalMessage?: string };
    expect(fullResult.status).toBe('done');
    expect(fullResult.finalMessage).toBe('hello from subagent');

    const events = JSON.parse(
      (await eventsHandler.execute({ jobId: status0.jobId, cursor: '0', maxEvents: 50 }))
        .content[0].text
    ) as { events: Array<{ type: string }> };
    expect(events.events.map((e) => e.type)).toContain('message');
    expect(events.events.map((e) => e.type)).toContain('final');
  });

  test('multi-job orchestration: waitAny timeout signal, missingJobIds, default sandbox, and cancel', async () => {
    const childA = makeMockChildProcess();
    const childB = makeMockChildProcess();
    spawnMock.mockReturnValueOnce(childA).mockReturnValueOnce(childB);

    const spawnHandler = new CodexSpawnToolHandler();
    const statusHandler = new CodexStatusToolHandler();
    const resultHandler = new CodexResultToolHandler();
    const cancelHandler = new CodexCancelToolHandler();
    const waitAnyHandler = new CodexWaitAnyToolHandler();

    const previousDefaultSandbox = process.env.CODEX_MCP_DEFAULT_SANDBOX;
    delete process.env.CODEX_MCP_DEFAULT_SANDBOX;

    try {
      const spawnA = await spawnHandler.execute({
        prompt: 'Task A',
        workingDirectory: '/data/Qwen3-VL',
      });
      const jobA = JSON.parse(spawnA.content[0].text) as { jobId: string };
      expect(typeof jobA.jobId).toBe('string');

      // When sandbox is omitted, codex-mcp-server should default to workspace-write.
      const argsA = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
      expect(Array.isArray(argsA)).toBe(true);
      expect(argsA).toContain('--sandbox');
      expect(argsA).toContain('workspace-write');

      const spawnB = await spawnHandler.execute({
        prompt: 'Task B',
        workingDirectory: '/data/Qwen3-VL',
      });
      const jobB = JSON.parse(spawnB.content[0].text) as { jobId: string };

      const wait0 = JSON.parse(
        (await waitAnyHandler.execute({
          jobIds: ['missing', jobA.jobId, jobB.jobId],
          timeoutMs: 0,
        })).content[0].text
      ) as { completedJobId: string | null; timedOut: boolean; missingJobIds?: string[] };
      expect(wait0.completedJobId).toBeNull();
      expect(wait0.timedOut).toBe(true);
      expect(wait0.missingJobIds).toEqual(['missing']);

      // Complete job A.
      childA.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'item.completed',
            item: { id: '1', type: 'agent_message', text: 'final A' },
          }) + '\n'
        )
      );
      childA.emit('close', 0);

      const wait1 = JSON.parse(
        (await waitAnyHandler.execute({
          jobIds: [jobA.jobId, jobB.jobId],
          timeoutMs: 1000,
        })).content[0].text
      ) as { completedJobId: string | null; timedOut: boolean };
      expect(wait1.completedJobId).toBe(jobA.jobId);
      expect(wait1.timedOut).toBe(false);

      // Result handler defaults to returning the final message as plain text.
      const messageOnly = (await resultHandler.execute({
        jobId: jobA.jobId,
        view: 'finalMessage',
      })).content[0].text;
      expect(messageOnly).toBe('final A');

      const full = JSON.parse(
        (await resultHandler.execute({ jobId: jobA.jobId, view: 'full' })).content[0].text
      ) as { status: string; finalMessage?: string };
      expect(full.status).toBe('done');
      expect(full.finalMessage).toBe('final A');

      // Force-cancel job B and ensure it becomes canceled (not failed) after close.
      await cancelHandler.execute({ jobId: jobB.jobId, force: true });
      expect(childB.kill).toHaveBeenCalledWith('SIGKILL');
      childB.emit('close', 137);

      const statusB = JSON.parse(
        (await statusHandler.execute({ jobId: jobB.jobId })).content[0].text
      ) as { status: string };
      expect(statusB.status).toBe('canceled');

      // If a job is canceled before emitting any agent_message event, finalMessage-only should
      // still return a helpful fallback rather than an empty string.
      const canceledMessage = (await resultHandler.execute({ jobId: jobB.jobId })).content[0]
        .text;
      expect(canceledMessage.trim().length).toBeGreaterThan(0);
      expect(canceledMessage.toLowerCase()).toContain('canceled');
    } finally {
      if (previousDefaultSandbox !== undefined) {
        process.env.CODEX_MCP_DEFAULT_SANDBOX = previousDefaultSandbox;
      } else {
        delete process.env.CODEX_MCP_DEFAULT_SANDBOX;
      }
    }
  });

  test('codex_spawn_group returns partial success (cap) and optional handshake events', async () => {
    const childA = makeMockChildProcess();
    spawnMock.mockReturnValueOnce(childA);

    const previousMaxJobs = process.env.CODEX_MCP_MAX_JOBS;
    process.env.CODEX_MCP_MAX_JOBS = '1';

    try {
      const spawnGroupHandler = new CodexSpawnGroupToolHandler();

      const res = await spawnGroupHandler.execute({
        defaults: {
          sandbox: 'read-only',
          workingDirectory: '/data/Qwen3-VL',
        },
        includeHandshake: true,
        handshakeMaxEvents: 1,
        jobs: [
          { prompt: 'Job A', label: 'a' },
          { prompt: 'Job B', label: 'b' },
        ],
      });

      const out = JSON.parse(res.content[0].text) as {
        results: Array<{ jobId?: string; error?: string; label?: string; handshake?: any }>;
      };
      expect(out.results).toHaveLength(2);

      expect(typeof out.results[0]?.jobId).toBe('string');
      expect(out.results[0]?.label).toBe('a');
      expect(out.results[0]?.handshake?.events?.length).toBe(1);
      expect(out.results[0]?.handshake?.events?.[0]?.type).toBe('progress');

      expect(typeof out.results[1]?.error).toBe('string');
      expect(out.results[1]?.error?.toLowerCase()).toContain('too many concurrent jobs');
      expect(out.results[1]?.label).toBe('b');

      // Ensure defaults were applied to spawned job A.
      const argsA = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
      expect(Array.isArray(argsA)).toBe(true);
      expect(argsA).toContain('--sandbox');
      expect(argsA).toContain('read-only');
      expect(argsA).toContain('-C');
      expect(argsA).toContain('/data/Qwen3-VL');

      // Cleanup: finish job A so it doesn't leak running state into other tests.
      childA.emit('close', 0);
    } finally {
      if (previousMaxJobs !== undefined) {
        process.env.CODEX_MCP_MAX_JOBS = previousMaxJobs;
      } else {
        delete process.env.CODEX_MCP_MAX_JOBS;
      }
    }
  });

  test('codex_interrupt cancels + respawns with inherited settings and injected event tail', async () => {
    const childA = makeMockChildProcess();
    const childB = makeMockChildProcess();
    spawnMock.mockReturnValueOnce(childA).mockReturnValueOnce(childB);

    const spawnHandler = new CodexSpawnToolHandler();
    const interruptHandler = new CodexInterruptToolHandler();

    const spawnRes = await spawnHandler.execute({
      prompt: 'Original task',
      model: 'gpt-4o',
      reasoningEffort: 'high',
      sandbox: 'read-only',
      workingDirectory: '/data/Qwen3-VL',
    });

    const jobA = JSON.parse(spawnRes.content[0].text) as { jobId: string };

    childA.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'item.completed',
          item: { id: '1', type: 'agent_message', text: 'working on it' },
        }) + '\n'
      )
    );

    // Ensure the interrupt wait sees the job exit as canceled.
    setTimeout(() => childA.emit('close', 137), 0);

    const interruptRes = await interruptHandler.execute({
      jobId: jobA.jobId,
      newPrompt: 'New scope: focus only on docs',
      waitMs: 1000,
      tailMaxEvents: 5,
    });

    const out = JSON.parse(interruptRes.content[0].text) as {
      respawned: boolean;
      newJobId?: string;
    };
    expect(out.respawned).toBe(true);
    expect(typeof out.newJobId).toBe('string');
    expect(childA.kill).toHaveBeenCalled();

    // Second spawn should inherit model/reasoning/sandbox/workingDirectory by default.
    const argsB = spawnMock.mock.calls[1]?.[1] as string[] | undefined;
    expect(Array.isArray(argsB)).toBe(true);
    expect(argsB).toContain('--model');
    expect(argsB).toContain('gpt-4o');
    expect(argsB).toContain('--sandbox');
    expect(argsB).toContain('read-only');
    expect(argsB).toContain('-C');
    expect(argsB).toContain('/data/Qwen3-VL');

    const promptB = argsB?.[argsB.length - 1];
    expect(typeof promptB).toBe('string');
    expect(promptB).toContain(`Prior Context (from interrupted job ${jobA.jobId})`);
    expect(promptB).toContain('working on it');
    expect(promptB).toContain('Updated Instructions');
    expect(promptB).toContain('New scope: focus only on docs');
    expect(promptB).toContain('IMPORTANT: Refresh-before-write');

    // Cleanup: finish respawned job B.
    childB.emit('close', 0);
  });

  test('codex_interrupt refuses respawn if job completes naturally during wait', async () => {
    const childA = makeMockChildProcess();
    spawnMock.mockReturnValueOnce(childA);

    const spawnHandler = new CodexSpawnToolHandler();
    const interruptHandler = new CodexInterruptToolHandler();

    const spawnRes = await spawnHandler.execute({
      prompt: 'Short task',
      sandbox: 'read-only',
    });
    const jobA = JSON.parse(spawnRes.content[0].text) as { jobId: string };

    // Natural completion (turn.completed + exit 0) racing with interrupt cancellation.
    // We include a `turn.completed` event so the job manager can distinguish "completed turn"
    // from a graceful SIGTERM exit.
    setTimeout(() => {
      childA.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n')
      );
      childA.emit('close', 0);
    }, 0);

    const interruptRes = await interruptHandler.execute({
      jobId: jobA.jobId,
      newPrompt: 'New scope',
      waitMs: 1000,
    });

    const out = JSON.parse(interruptRes.content[0].text) as {
      respawned: boolean;
      previousStatus: string;
      reason?: string;
    };
    expect(out.respawned).toBe(false);
    expect(out.previousStatus).toBe('done');
    expect(out.reason?.toLowerCase()).toContain('completed naturally');

    // Only the original job was spawned; no respawn should happen.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
