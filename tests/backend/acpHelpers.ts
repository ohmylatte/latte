import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatEvent } from '../../shared/contracts';
import { AcpChatAdapter, type AcpAdapterDeps } from '../../electron/agents/acp/acpAdapter';
import type { AcpProfile } from '../../electron/agents/acp/profiles';

export const FAKE_ACP = path.resolve(__dirname, 'fakeAcp.ts');

export async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Lo que el fake anotó: su arranque y cada mensaje que le llegó. */
export function readFakeLog(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

export function fakeRequests(file: string, method: string): Array<Record<string, unknown>> {
  return readFakeLog(file)
    .filter((e) => e.kind === 'in' && (e.message as { method?: string }).method === method)
    .map((e) => ((e.message as { params?: Record<string, unknown> }).params ?? {}));
}

/** Un perfil que habla ACP estándar y nada más: el que usan los tests del núcleo. */
export function standardProfile(overrides: Partial<AcpProfile> = {}): AcpProfile {
  return {
    runtime: 'grok',
    label: 'Fake',
    args: ['acp'],
    startupTimeoutMs: 8_000,
    env: (ctx) => ({ FAKE_ACCOUNT_HOME: ctx.accountHome }),
    questions: null,
    permissionTimeoutMs: null,
    confirmsMcpInjection: false,
    mcpToolName: (server, tool) => `mcp__${server}__${tool}`,
    ...overrides,
  };
}

export interface FakeAcpSetup {
  dir: string;
  log: string;
  state: string;
  flavor?: 'standard' | 'grok' | 'hermes';
  extraEnv?: Record<string, string>;
}

export function makeFakeAcpAdapter(events: ChatEvent[], setup: FakeAcpSetup, deps: Partial<AcpAdapterDeps> = {}): AcpChatAdapter {
  fs.mkdirSync(setup.state, { recursive: true });
  return new AcpChatAdapter({
    profile: standardProfile(),
    resolveExecutable: async () => ({ executable: process.execPath, version: '1.0.0' }),
    emit: (e) => events.push(e),
    accountHome: (accountId) => (accountId && accountId !== 'system' ? path.join(setup.dir, 'accounts', accountId) : null),
    // `node <args>` pasa a ser `node fakeAcp.ts <args>`.
    spawnImpl: ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => spawn(file, [FAKE_ACP, ...args], options)) as typeof spawn,
    platform: 'linux',
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      FAKE_ACP_LOG: setup.log,
      FAKE_ACP_STATE: setup.state,
      FAKE_ACP_FLAVOR: setup.flavor ?? 'standard',
      NODE_NO_WARNINGS: '1',
      ...(setup.extraEnv ?? {}),
    },
    ...deps,
  });
}
