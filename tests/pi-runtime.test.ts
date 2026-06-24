import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildPiPromptCommand, buildPiRuntimeBootstrapCommand, redactPiPromptCommand } from '../server/lib/pi-runtime';

describe('pi runtime commands', () => {
  it('validates the baked runner instead of rewriting it', () => {
    const command = buildPiRuntimeBootstrapCommand();

    expect(command).toContain("mkdir -p '/root/.pi/sessions' '/root/.pi/agent'");
    expect(command).toContain("test -f '/workspace/board-sandbox-runtime/pi-runner.js'");
    expect(command).toContain("cat '/workspace/board-sandbox-runtime/VERSION.txt'");
    expect(command).not.toContain('base64 -d');
    expect(command).not.toContain('npm install --silent --ignore-scripts');
    expect(command).not.toContain('tsx');
    expect(spawnSync('bash', ['-n', '-c', command], { encoding: 'utf8' }).status).toBe(0);
  });

  it('runs the SDK runner with Board and Bedrock env', () => {
    const command = buildPiPromptCommand({
      boardApiBase: 'https://board.test',
      boardSessionId: 'sess1',
      boardToken: 'bridge-secret',
      boardOwner: 'user@example.com',
      prompt: 'hello',
      awsRegion: 'us-east-1',
      awsBearerTokenBedrock: 'bedrock-secret',
      bedrockModelId: 'us.anthropic.claude-opus-4-6-v1',
      thinkingLevel: 'high',
    });

    expect(command).toContain("LLM_PROVIDER='amazon-bedrock'");
    expect(command).toContain("LLM_MODEL='us.anthropic.claude-opus-4-6-v1'");
    expect(command).toContain("AWS_REGION='us-east-1'");
    expect(command).toContain("AWS_BEARER_TOKEN_BEDROCK='bedrock-secret'");
    expect(command).toContain("BEDROCK_MODEL_ID='us.anthropic.claude-opus-4-6-v1'");
    expect(command).toContain("PI_THINKING_LEVEL='high'");
    expect(command).toContain("PI_SESSION_DIR='/root/.pi/sessions'");
    expect(command).toContain("PI_CODING_AGENT_DIR='/root/.pi/agent'");
    expect(command).toContain('node pi-runner.js');
    expect(command).not.toContain('tsx');
    expect(command).not.toContain('pi --mode json --print');
  });

  it('runs the SDK runner with Codex subscription env', () => {
    const auth = JSON.stringify({ type: 'oauth', access: 'access-token', refresh: 'refresh-token', expires: 4102444800000, accountId: 'acct_123' });
    const command = buildPiPromptCommand({
      boardApiBase: 'https://board.test',
      boardSessionId: 'sess1',
      boardToken: 'bridge-secret',
      boardOwner: 'user@example.com',
      prompt: 'hello',
      llmProvider: 'openai-codex',
      llmModel: 'gpt-5.5',
      openaiCodexOAuthJson: auth,
      thinkingLevel: 'high',
    });

    expect(command).toContain("LLM_PROVIDER='openai-codex'");
    expect(command).toContain("LLM_MODEL='gpt-5.5'");
    expect(command).toContain('OPENAI_CODEX_OAUTH_JSON=');
    expect(command).toContain("PI_CODING_AGENT_DIR='/root/.pi/agent'");
    expect(spawnSync('bash', ['-n', '-c', command], { encoding: 'utf8' }).status).toBe(0);
  });

  it('tells the runner how to fetch the latest note before reflecting', () => {
    const runner = readFileSync(path.join(__dirname, '..', 'sandbox-runtime', 'pi-runner.js'), 'utf8');

    expect(runner).toContain('Empty string returns most recently updated notes');
    expect(runner).toContain('Search compiled Board Wiki pages before searching raw notes');
    expect(runner).toContain('Use search_wiki/read_wiki_page before raw notes');
    expect(runner).toContain('If the user asks about the latest or most recent note');
    expect(runner).toContain('use query "" with limit 1');
    expect(runner).toContain('Board API returned non-JSON');
    expect(runner).toContain("if (existsSync(file) && readFileSync(file, 'utf8').trim()) return file;");
  });

  it('redacts Board, AWS, and Codex secrets from persisted command strings', () => {
    const command = buildPiPromptCommand({
      boardApiBase: 'https://board.test',
      boardSessionId: 'sess1',
      boardToken: 'bridge-secret',
      boardOwner: 'user@example.com',
      prompt: 'hello',
      awsAccessKeyId: 'AKIA123',
      awsSecretAccessKey: 'aws-secret',
      awsSessionToken: 'session-secret',
      awsBearerTokenBedrock: 'bedrock-secret',
      openaiCodexOAuthJson: '{"access":"codex-secret","refresh":"refresh-secret","expires":4102444800000}',
    });
    const redacted = redactPiPromptCommand(command);

    expect(redacted).toContain("BOARD_AGENT_TOKEN='<redacted>'");
    expect(redacted).toContain("AWS_ACCESS_KEY_ID='<redacted>'");
    expect(redacted).toContain("AWS_SECRET_ACCESS_KEY='<redacted>'");
    expect(redacted).toContain("AWS_SESSION_TOKEN='<redacted>'");
    expect(redacted).toContain("AWS_BEARER_TOKEN_BEDROCK='<redacted>'");
    expect(redacted).toContain("OPENAI_CODEX_OAUTH_JSON='<redacted>'");
    expect(redacted).not.toContain('bridge-secret');
    expect(redacted).not.toContain('aws-secret');
    expect(redacted).not.toContain('bedrock-secret');
    expect(redacted).not.toContain('codex-secret');
    expect(redacted).not.toContain('refresh-secret');
  });
});
