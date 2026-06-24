import RUNTIME_VERSION_FILE from '../../sandbox-runtime/VERSION.txt?raw';

const RUNTIME_DIR = '/workspace/board-sandbox-runtime';
const PI_DIR = '/root/.pi';
const SESSION_DIR = `${PI_DIR}/sessions`;
const AGENT_DIR = `${PI_DIR}/agent`;
const RUNTIME_VERSION = RUNTIME_VERSION_FILE.trim();

const SECRET_ENV_KEYS = [
  'BOARD_AGENT_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'OPENAI_CODEX_OAUTH_JSON',
];

export function buildPiRuntimeBootstrapCommand(): string {
  return [
    `mkdir -p ${shellWord(SESSION_DIR)} ${shellWord(AGENT_DIR)}`,
    `test -f ${shellWord(`${RUNTIME_DIR}/pi-runner.js`)}`,
    `test \"$(cat ${shellWord(`${RUNTIME_DIR}/VERSION.txt`)} 2>/dev/null)\" = ${shellWord(RUNTIME_VERSION)}`,
  ].join(' && ');
}

export function buildPiPromptCommand(input: {
  boardApiBase: string;
  boardSessionId: string;
  boardToken: string;
  boardOwner: string;
  prompt: string;
  workdir?: string | null;
  awsRegion?: string | null;
  awsAccessKeyId?: string | null;
  awsSecretAccessKey?: string | null;
  awsSessionToken?: string | null;
  awsBearerTokenBedrock?: string | null;
  bedrockModelId?: string | null;
  llmProvider?: string | null;
  llmModel?: string | null;
  openaiCodexOAuthJson?: string | null;
  thinkingLevel?: string | null;
  readOnly?: boolean;
}): string {
  const env = [
    ['BOARD_API_BASE', input.boardApiBase],
    ['BOARD_AGENT_SESSION_ID', input.boardSessionId],
    ['BOARD_AGENT_TOKEN', input.boardToken],
    ['BOARD_AGENT_OWNER', input.boardOwner],
    ['PI_WORKDIR', input.workdir || '/workspace'],
    ['PI_SESSION_DIR', SESSION_DIR],
    ['PI_CODING_AGENT_DIR', AGENT_DIR],
    ['LLM_PROVIDER', input.llmProvider || 'amazon-bedrock'],
    ['LLM_MODEL', input.llmModel || input.bedrockModelId],
    ['OPENAI_CODEX_OAUTH_JSON', input.openaiCodexOAuthJson],
    ['AWS_REGION', input.awsRegion],
    ['AWS_ACCESS_KEY_ID', input.awsAccessKeyId],
    ['AWS_SECRET_ACCESS_KEY', input.awsSecretAccessKey],
    ['AWS_SESSION_TOKEN', input.awsSessionToken],
    ['AWS_BEARER_TOKEN_BEDROCK', input.awsBearerTokenBedrock],
    ['BEDROCK_MODEL_ID', input.bedrockModelId],
    ['PI_THINKING_LEVEL', input.thinkingLevel],
    ['BOARD_READONLY', input.readOnly ? '1' : undefined],
  ]
    .filter((item): item is [string, string] => typeof item[1] === 'string' && item[1].length > 0)
    .map(([key, value]) => `${key}=${shellWord(value)}`)
    .join(' ');
  return `${buildPiRuntimeBootstrapCommand()} && cd ${shellWord(RUNTIME_DIR)} && ${env} node pi-runner.js ${shellWord(input.prompt)}`;
}

export function redactPiPromptCommand(command: string): string {
  let out = command;
  for (const key of SECRET_ENV_KEYS) {
    out = out.replace(new RegExp(`${key}='[^']*'`, 'g'), `${key}='<redacted>'`);
  }
  return out;
}

function shellWord(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
