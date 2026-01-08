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
  CodexStatusToolHandler,
  CodexResultToolHandler,
  CodexEventsToolHandler,
  CodexWaitAnyToolHandler,
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
});
