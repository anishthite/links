import type { ExecResult, Sandbox } from '@cloudflare/sandbox';

import type { AgentSessionStatus } from '../../src/lib/types';

export const CLOUDFLARE_SANDBOX_PROVIDER = 'cloudflare-sandbox';
export const SANDBOX_CWD = '/workspace';
const COMMAND_TIMEOUT_MS = 600_000;

export type CloudflareSandboxSession = {
  providerSessionId: string;
  status: AgentSessionStatus;
  previewUrl: string | null;
  cwd: string | null;
  errorMessage?: string | null;
};

export type CloudflareSandboxCommandResult = {
  command: string;
  stdout: string;
  parsed: unknown;
  debug?: CloudflareSandboxCommandDebug;
};

export type CloudflareSandboxCommandDebug = {
  request: { sandboxId: string; command: string; cwd: string; timeout: number; stream?: boolean };
  response?: ExecResult;
};

export type CloudflareSandboxStreamEvent =
  | { stream: 'stdout' | 'stderr'; text: string }
  | { stream: 'exit'; code: number };

export class CloudflareSandboxCommandError extends Error {
  constructor(message: string, readonly debug: CloudflareSandboxCommandDebug) {
    super(message);
    this.name = 'CloudflareSandboxCommandError';
  }
}

export function cloudflareSandboxErrorDebug(err: unknown): CloudflareSandboxCommandDebug | null {
  return err instanceof CloudflareSandboxCommandError ? err.debug : null;
}

export class CloudflareSandboxClient {
  constructor(private readonly binding: DurableObjectNamespace<Sandbox<unknown>>) {}

  static fromEnv(env: { Sandbox?: DurableObjectNamespace<Sandbox<unknown>> }): CloudflareSandboxClient | null {
    return env.Sandbox ? new CloudflareSandboxClient(env.Sandbox) : null;
  }

  async createSession(input: { name: string; title: string | null }): Promise<CloudflareSandboxSession> {
    await (await this.sandbox(input.name)).exec('mkdir -p /workspace', { cwd: SANDBOX_CWD, timeout: 60_000 });
    return normalizeSession(input.name, 'ready');
  }

  async getSession(providerSessionId: string): Promise<CloudflareSandboxSession> {
    return normalizeSession(providerSessionId, 'ready');
  }

  async deleteSession(providerSessionId: string): Promise<void> {
    await (await this.sandbox(providerSessionId)).destroy();
  }

  async runCommand(providerSessionId: string, command: string): Promise<CloudflareSandboxCommandResult> {
    const request = { sandboxId: providerSessionId, command: redactCommandForDebug(command), cwd: SANDBOX_CWD, timeout: COMMAND_TIMEOUT_MS };
    const result = await (await this.sandbox(providerSessionId)).exec(command, { cwd: SANDBOX_CWD, timeout: COMMAND_TIMEOUT_MS });
    const debug = { request, response: result };
    if (!result.success) throw new CloudflareSandboxCommandError(`Cloudflare Sandbox command failed: ${result.exitCode} ${result.stderr.slice(0, 240)}`, debug);
    return { command, stdout: `${result.stdout}${result.stderr}`, parsed: result, debug };
  }

  async streamCommand(providerSessionId: string, command: string, onEvent: (event: CloudflareSandboxStreamEvent) => void | Promise<void>): Promise<CloudflareSandboxCommandResult> {
    const request = { sandboxId: providerSessionId, command: redactCommandForDebug(command), cwd: SANDBOX_CWD, timeout: COMMAND_TIMEOUT_MS, stream: true };
    let stdout = '';
    let stderr = '';
    const pending: Promise<void>[] = [];
    const result = await (await this.sandbox(providerSessionId)).exec(command, {
      cwd: SANDBOX_CWD,
      timeout: COMMAND_TIMEOUT_MS,
      stream: true,
      onOutput: (stream, data) => {
        if (stream === 'stdout') stdout += data;
        else stderr += data;
        pending.push(Promise.resolve(onEvent({ stream, text: data })));
      },
    });
    await Promise.all(pending);
    await onEvent({ stream: 'exit', code: result.exitCode });
    const debug = { request, response: result };
    if (!result.success) throw new CloudflareSandboxCommandError(`Cloudflare Sandbox command failed: ${result.exitCode} ${result.stderr.slice(0, 240)}`, debug);
    return { command, stdout: stdout || `${result.stdout}${stderr}`, parsed: result, debug };
  }

  private async sandbox(id: string): Promise<Sandbox<unknown>> {
    const { getSandbox } = await import('@cloudflare/sandbox');
    return getSandbox(this.binding, id, {
      // ponytail: RPC is the future, but today its control-connection upgrade is
      // the failing path. HTTP is deprecated soon; switch back after CF fixes it.
      transport: 'http',
      enableDefaultSession: false,
      sleepAfter: '15m',
      normalizeId: true,
      containerTimeouts: { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 180_000 },
    });
  }
}


function normalizeSession(providerSessionId: string, status: AgentSessionStatus): CloudflareSandboxSession {
  return { providerSessionId, status, previewUrl: null, cwd: SANDBOX_CWD, errorMessage: null };
}

function redactCommandForDebug(command: string): string {
  return command
    .replace(/(BOARD_AGENT_TOKEN=)'[^']*'/g, "$1'<redacted>'")
    .replace(/(AWS_ACCESS_KEY_ID=)'[^']*'/g, "$1'<redacted>'")
    .replace(/(AWS_SECRET_ACCESS_KEY=)'[^']*'/g, "$1'<redacted>'")
    .replace(/(AWS_SESSION_TOKEN=)'[^']*'/g, "$1'<redacted>'")
    .replace(/(AWS_BEARER_TOKEN_BEDROCK=)'[^']*'/g, "$1'<redacted>'")
    .replace(/(OPENAI_CODEX_OAUTH_JSON=)'[^']*'/g, "$1'<redacted>'");
}
