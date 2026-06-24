import { getSandbox } from '@cloudflare/sandbox';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CloudflareSandboxClient } from '../server/lib/cloudflare-sandbox';

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
  Sandbox: class Sandbox {},
}));

const binding = {} as DurableObjectNamespace<never>;

function mockSandbox(methods: { exec?: ReturnType<typeof vi.fn>; destroy?: ReturnType<typeof vi.fn> }) {
  const sandbox = {
    exec: methods.exec ?? vi.fn(),
    destroy: methods.destroy ?? vi.fn(),
  };
  vi.mocked(getSandbox).mockReturnValue(sandbox as never);
  return sandbox;
}

describe('CloudflareSandboxClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a sandbox by touching the workspace', async () => {
    const sandbox = mockSandbox({ exec: vi.fn(async () => ({ success: true, exitCode: 0, stdout: '', stderr: '', command: 'mkdir -p /workspace', duration: 1, timestamp: 't' })) });
    const client = new CloudflareSandboxClient(binding as never);

    const session = await client.createSession({ name: 'board-123', title: 'board sandbox' });

    expect(session).toMatchObject({ providerSessionId: 'board-123', status: 'ready', cwd: '/workspace' });
    expect(getSandbox).toHaveBeenCalledWith(binding, 'board-123', expect.objectContaining({ transport: 'http', enableDefaultSession: false, sleepAfter: '15m' }));
    expect(sandbox.exec).toHaveBeenCalledWith('mkdir -p /workspace', { cwd: '/workspace', timeout: 60_000 });
  });

  it('runs commands through the SDK', async () => {
    mockSandbox({ exec: vi.fn(async () => ({ success: true, exitCode: 0, stdout: 'ok\n', stderr: '', command: 'pwd', duration: 1, timestamp: 't' })) });
    const client = new CloudflareSandboxClient(binding as never);

    const result = await client.runCommand('board-123', 'pwd');

    expect(result.stdout).toBe('ok\n');
    expect(result.debug?.request).toMatchObject({ sandboxId: 'board-123', command: 'pwd', cwd: '/workspace' });
  });

  it('streams command output callbacks', async () => {
    const exec = vi.fn(async (_command, options) => {
      options.onOutput('stdout', 'he');
      options.onOutput('stderr', 'warn\n');
      options.onOutput('stdout', 'llo\n');
      return { success: true, exitCode: 0, stdout: 'hello\n', stderr: 'warn\n', command: 'printf hello', duration: 1, timestamp: 't' };
    });
    mockSandbox({ exec });
    const client = new CloudflareSandboxClient(binding as never);
    const events: unknown[] = [];

    const result = await client.streamCommand('board-123', 'printf hello', (event) => events.push(event));

    expect(result.stdout).toBe('hello\n');
    expect(exec).toHaveBeenCalledWith('printf hello', expect.objectContaining({ cwd: '/workspace', stream: true }));
    expect(events).toEqual([
      { stream: 'stdout', text: 'he' },
      { stream: 'stderr', text: 'warn\n' },
      { stream: 'stdout', text: 'llo\n' },
      { stream: 'exit', code: 0 },
    ]);
  });

  it('throws on non-zero exit', async () => {
    mockSandbox({ exec: vi.fn(async () => ({ success: false, exitCode: 2, stdout: '', stderr: 'nope', command: 'false', duration: 1, timestamp: 't' })) });
    const client = new CloudflareSandboxClient(binding as never);

    await expect(client.runCommand('board-123', 'false')).rejects.toThrow('Cloudflare Sandbox command failed: 2 nope');
  });

  it('destroys sandboxes on delete', async () => {
    const destroy = vi.fn(async () => undefined);
    mockSandbox({ destroy });
    const client = new CloudflareSandboxClient(binding as never);

    await client.deleteSession('board-123');

    expect(destroy).toHaveBeenCalledOnce();
  });
});
