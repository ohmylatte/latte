import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { API_ARITY, API_METHODS, channelFor, type IpcEnvelope } from '../../electron/ipc/channels';
import { registerIpc, toFailure } from '../../electron/ipc/register';
import { NotFoundError, ValidationError } from '../../electron/core/errors';
import type { BackendApi } from '../../electron/services/latteService';

function preloadMethods(): string[] {
  const source = fs.readFileSync(path.resolve(__dirname, '../../electron/preload.cjs'), 'utf8');
  const match = source.match(/const METHODS = \[([\s\S]*?)\];/);
  if (!match) throw new Error('METHODS array not found in preload.cjs');
  return [...match[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
}

describe('IPC surface', () => {
  it('preload exposes exactly the methods the main process registers', () => {
    expect(preloadMethods()).toEqual([...API_METHODS]);
    expect(Object.keys(API_ARITY).sort()).toEqual([...API_METHODS].sort());
    expect(API_METHODS).toContain('listProfiles');
    expect(API_METHODS).toContain('saveProfile');
    expect(API_METHODS).toContain('prepareGeneration');
    expect(API_METHODS).toContain('featureFlags');
    expect(API_METHODS).toContain('archiveBrand');
    expect(API_METHODS).toContain('restoreBrand');
    expect(API_METHODS).toContain('listArchivedBrands');
    expect(API_METHODS).toContain('listBrandDocuments');
    expect(API_METHODS).toContain('listBrandDecisions');
    expect(API_ARITY.listBrandDocuments).toBe(1);
    expect(API_ARITY.listBrandDecisions).toBe(1);
    expect(API_ARITY.featureFlags).toBe(0);
    expect(API_ARITY.saveProfile).toBe(2);
    expect(API_ARITY.prepareGeneration).toBe(1);
    expect(API_ARITY.setWorkBrandChoice).toBe(3);
    expect(API_ARITY.archiveBrand).toBe(1);
    expect(API_ARITY.restoreBrand).toBe(1);
    expect(API_ARITY.listArchivedBrands).toBe(0);
    expect(API_ARITY.listBrands).toBe(0);
    expect(API_METHODS).toContain('loginMcpServer');
    expect(API_METHODS).toContain('authenticateClaudeMcp');
    expect(API_ARITY.loginMcpServer).toBe(2);
    expect(API_ARITY.authenticateClaudeMcp).toBe(2);
    expect(API_METHODS).toContain('getBrand');
    expect(API_ARITY.getBrand).toBe(1);
    expect(API_METHODS).toContain('listBrandContextProposals');
    expect(API_METHODS).toContain('saveBrandContext');
    expect(API_METHODS).toContain('clearBrandContext');
    expect(API_METHODS).toContain('approveBrandContextProposal');
    expect(API_METHODS).toContain('rejectBrandContextProposal');
    expect(API_METHODS).toContain('requestBrandContextDraft');
    expect(API_METHODS).toContain('brandContextStatus');
    expect(API_METHODS).toContain('listBrandContextRevisions');
    expect(API_METHODS).toContain('restoreBrandContextRevision');
    expect(API_ARITY.listBrandContextProposals).toBe(1);
    expect(API_ARITY.saveBrandContext).toBe(3);
    expect(API_ARITY.clearBrandContext).toBe(2);
    expect(API_ARITY.approveBrandContextProposal).toBe(3);
    expect(API_ARITY.rejectBrandContextProposal).toBe(1);
    expect(API_ARITY.requestBrandContextDraft).toBe(1);
    expect(API_ARITY.brandContextStatus).toBe(1);
    expect(API_ARITY.listBrandContextRevisions).toBe(1);
    expect(API_ARITY.restoreBrandContextRevision).toBe(3);
    expect(API_METHODS).toContain('getOnboardingComplete');
    expect(API_METHODS).toContain('setOnboardingComplete');
    expect(API_METHODS).toContain('getOnboardingDraft');
    expect(API_METHODS).toContain('setOnboardingDraft');
    expect(API_METHODS).toContain('clearOnboardingDraft');
    expect(API_ARITY.getOnboardingComplete).toBe(0);
    expect(API_ARITY.setOnboardingComplete).toBe(1);
    expect(API_ARITY.getOnboardingDraft).toBe(0);
    expect(API_ARITY.setOnboardingDraft).toBe(1);
    expect(API_ARITY.clearOnboardingDraft).toBe(0);
  });

  it('preload never exposes a generic invoke or Node globals', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../electron/preload.cjs'), 'utf8');
    expect(source).not.toMatch(/exposeInMainWorld\(\s*['"](?!latte['"])/);
    expect(source).not.toMatch(/invoke:\s*\(/);
    expect(source).toMatch(/contextBridge\.exposeInMainWorld\('latte'/);
    expect(source).not.toMatch(/require\((?!'electron')/);
  });
});

describe('registerIpc', () => {
  function setup(trusted = true) {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<IpcEnvelope<unknown>>>();
    const removed: string[] = [];
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const api = new Proxy({} as BackendApi, {
      get: (_t, prop: string) => async (...args: unknown[]) => {
        calls.push({ method: prop, args });
        if (prop === 'listBrands') return [{ id: 'brd_x' }];
        if (prop === 'snapshot') throw new NotFoundError('Work', String(args[0]));
        if (prop === 'createBrand') throw new ValidationError('Brand name cannot be empty');
        if (prop === 'exportWork') throw new Error('disk on fire at C:\\secret\\path');
        return null;
      },
    });
    const logs: string[] = [];
    const unregister = registerIpc({
      ipcMain: {
        handle: (channel, handler) => { handlers.set(channel, handler as never); },
        removeHandler: (channel) => { removed.push(channel); },
      },
      api,
      isTrustedSender: () => trusted,
      log: (m) => logs.push(m),
    });
    const event = { sender: { id: 1 } as WebContents } as IpcMainInvokeEvent;
    const call = (method: (typeof API_METHODS)[number], ...args: unknown[]) => handlers.get(channelFor(method))!(event, ...args);
    return { handlers, removed, calls, call, unregister, logs };
  }

  it('registers one channel per method and unregisters all of them', () => {
    const { handlers, removed, unregister } = setup();
    expect([...handlers.keys()].sort()).toEqual(API_METHODS.map(channelFor).sort());
    unregister();
    expect(removed.sort()).toEqual(API_METHODS.map(channelFor).sort());
  });

  it('wraps successes and typed failures in envelopes', async () => {
    const { call } = setup();
    expect(await call('listBrands')).toEqual({ ok: true, value: [{ id: 'brd_x' }] });
    expect(await call('snapshot', 'wrk_1')).toEqual({ ok: false, code: 'NOT_FOUND', message: 'Work not found: wrk_1' });
    expect(await call('createBrand', '')).toEqual({ ok: false, code: 'VALIDATION', message: 'Brand name cannot be empty' });
  });

  it('logs internal errors and returns a generic code', async () => {
    const { call, logs } = setup();
    const result = await call('exportWork', 'wrk_1');
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: 'INTERNAL' });
    expect(logs[0]).toContain('exportWork failed');
  });

  it('refuses untrusted senders and extra arguments', async () => {
    const untrusted = setup(false);
    expect(await untrusted.call('listBrands')).toEqual({ ok: false, code: 'FORBIDDEN', message: 'Untrusted IPC sender' });
    expect(untrusted.calls).toEqual([]);

    const trusted = setup(true);
    expect(await trusted.call('listBrands', 'unexpected')).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(trusted.calls).toEqual([]);
  });

  it('maps TypeError and RangeError to validation failures', () => {
    expect(toFailure('writeAgent', new TypeError('bad'))).toEqual({ ok: false, code: 'VALIDATION', message: 'bad' });
    expect(toFailure('writeAgent', new RangeError('big'))).toEqual({ ok: false, code: 'VALIDATION', message: 'big' });
  });
});
