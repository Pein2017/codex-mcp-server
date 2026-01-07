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

    const result = JSON.parse(
      (await resultHandler.execute({ jobId: status0.jobId })).content[0].text
    ) as { status: string; finalMessage?: string };
    expect(result.status).toBe('done');
    expect(result.finalMessage).toBe('hello from subagent');

    const events = JSON.parse(
      (await eventsHandler.execute({ jobId: status0.jobId, cursor: '0', maxEvents: 50 }))
        .content[0].text
    ) as { events: Array<{ type: string }> };
    expect(events.events.map((e) => e.type)).toContain('message');
    expect(events.events.map((e) => e.type)).toContain('final');
  });
});

