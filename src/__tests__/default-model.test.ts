import { CodexToolHandler } from '../tools/handlers.js';
import { InMemorySessionStorage } from '../session/storage.js';
import { executeCommand } from '../utils/command.js';

// Mock the command execution
jest.mock('../utils/command.js', () => ({
  executeCommand: jest.fn(),
}));

const mockedExecuteCommand = executeCommand as jest.MockedFunction<
  typeof executeCommand
>;

describe('Default Model Configuration', () => {
  let handler: CodexToolHandler;
  let sessionStorage: InMemorySessionStorage;

  beforeEach(() => {
    sessionStorage = new InMemorySessionStorage();
    handler = new CodexToolHandler(sessionStorage);
    mockedExecuteCommand.mockClear();
    mockedExecuteCommand.mockResolvedValue({
      stdout: 'Test response',
      stderr: '',
    });
  });

  test('should not pass --model when no model specified (inherit config.toml)', async () => {
    await handler.execute({ prompt: 'Test prompt' });

    expect(mockedExecuteCommand).toHaveBeenCalledWith('codex', [
      'exec',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      'Test prompt',
    ]);
  });

  test('should omit model from response metadata when not explicitly provided', async () => {
    const result = await handler.execute({ prompt: 'Test prompt' });

    expect(result._meta?.model).toBeUndefined();
  });

  test('should override default model when explicit model provided', async () => {
    await handler.execute({
      prompt: 'Test prompt',
      model: 'gpt-4',
    });

    expect(mockedExecuteCommand).toHaveBeenCalledWith('codex', [
      'exec',
      '--model',
      'gpt-4',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      'Test prompt',
    ]);
  });

  test('should use default model with sessions', async () => {
    const sessionId = sessionStorage.createSession();

    await handler.execute({
      prompt: 'Test prompt',
      sessionId,
    });

    expect(mockedExecuteCommand).toHaveBeenCalledWith('codex', [
      'exec',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      'Test prompt',
    ]);
  });

  test('should not force model in resume functionality when not explicitly provided', async () => {
    const sessionId = sessionStorage.createSession();
    sessionStorage.setCodexConversationId(sessionId, 'existing-conv-id');

    await handler.execute({
      prompt: 'Resume with default model',
      sessionId,
    });

    // Resume mode: all exec options must come BEFORE 'resume' subcommand
    expect(mockedExecuteCommand).toHaveBeenCalledWith('codex', [
      'exec',
      '--skip-git-repo-check',
      'resume',
      'existing-conv-id',
      'Resume with default model',
    ]);
  });

  test('should combine inherited model with reasoning effort', async () => {
    await handler.execute({
      prompt: 'Complex task',
      reasoningEffort: 'high',
    });

    expect(mockedExecuteCommand).toHaveBeenCalledWith('codex', [
      'exec',
      '-c',
      'model_reasoning_effort="high"',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      'Complex task',
    ]);
  });

  test('should ignore CODEX_DEFAULT_MODEL environment variable by default (inherit config.toml)', async () => {
    const originalEnv = process.env.CODEX_DEFAULT_MODEL;
    process.env.CODEX_DEFAULT_MODEL = 'gpt-4';

    try {
      await handler.execute({ prompt: 'Test with env var' });

      expect(mockedExecuteCommand).toHaveBeenCalledWith('codex', [
        'exec',
        '--sandbox',
        'workspace-write',
        '--skip-git-repo-check',
        'Test with env var',
      ]);
    } finally {
      if (originalEnv) {
        process.env.CODEX_DEFAULT_MODEL = originalEnv;
      } else {
        delete process.env.CODEX_DEFAULT_MODEL;
      }
    }
  });
});
