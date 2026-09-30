import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeSetupEvent } from '../shared/contracts';
import { browserAPI, enableRuntimeSetupPreviewDemo } from './browser-api';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('web preview: onboarding sin terminal', () => {
  let off: (() => void) | null = null;
  afterEach(() => { off?.(); off = null; });

  it('is honest by default: nothing installable, the official guide as plan B', async () => {
    const catalog = await browserAPI.runtimeSetupCatalog();
    expect(catalog.every((c) => !c.canInstall && c.guideUrl.startsWith('https://'))).toBe(true);
    expect(await browserAPI.detectRuntime('claude')).toEqual({ state: 'not_found', canInstall: false, guideUrl: 'https://code.claude.com/docs/en/setup' });
    await expect(browserAPI.startRuntimeInstall('claude')).rejects.toThrow();
    expect((await browserAPI.diagnoseRuntimes()).runtimes.every((r) => !r.installed)).toBe(true);
  });

  it('plays the full happy sequence behind the named demo helper', async () => {
    off = enableRuntimeSetupPreviewDemo('success', 0);
    const events: RuntimeSetupEvent[] = [];
    const unsubscribe = browserAPI.onRuntimeSetupEvent((e) => events.push(e));
    const install = await browserAPI.startRuntimeInstall('claude');
    await tick(20);
    expect(events.filter((e) => e.jobId === install.jobId).map((e) => e.state.state)).toEqual(['detecting', 'installing', 'installing', 'installed']);
    const login = await browserAPI.startBrowserLogin('claude', 'system');
    await tick(20);
    expect(events.filter((e) => e.jobId === login.jobId).map((e) => e.state.state)).toEqual(['starting', 'browser_opened', 'waiting', 'waiting', 'connected']);
    expect(await browserAPI.getRuntimeSetupTranscript(login.jobId)).toContain('[preview]');
    unsubscribe();
  });

  it('can end in each plan-B state', async () => {
    off = enableRuntimeSetupPreviewDemo('blocked_by_policy', 0);
    const job = await browserAPI.startRuntimeInstall('grok');
    await tick(20);
    expect((await browserAPI.getRuntimeSetupJob(job.jobId)).state).toMatchObject({ state: 'failed', code: 'blocked_by_policy' });
  });
});
