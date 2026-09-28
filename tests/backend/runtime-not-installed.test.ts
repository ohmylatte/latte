import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeBackend, type TestBackend } from './helpers';

/**
 * Brief 2026-09-27: "no está instalado o no está en el PATH" was a dead end.
 * A missing runtime is now a CODE the renderer turns into "Lo instalamos por vos".
 */
describe('a runtime that is not installed', () => {
  let b: TestBackend;
  beforeEach(async () => { b = await makeBackend(); });
  afterEach(() => b.cleanup());

  it('is listed with code not_installed and no PATH jargon', async () => {
    const runtimes = await b.service.listAgentRuntimes();
    for (const runtime of runtimes) {
      expect(runtime).toMatchObject({ installed: false, code: 'not_installed' });
      expect(runtime.detail).not.toMatch(/PATH/);
    }
    const status = await b.service.runtimeStatus();
    expect(status.every((s) => s.code === 'not_installed' && !/PATH/.test(s.detail))).toBe(true);
  });

  it('refuses a login or a terminal with the NOT_INSTALLED error code', async () => {
    await expect(b.service.startAccountLogin('claude', 'system')).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
    const brand = await b.service.createBrand('B');
    const work = await b.service.createWork(brand.id, 'W');
    await expect(b.service.startAgent(work.id, 'claude')).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
  });

  it('ends a browser login as failed{not_installed} through the service', async () => {
    const job = await b.service.startBrowserLogin('claude', 'system');
    const last = await b.service.getRuntimeSetupJob(job.jobId);
    expect(last).toMatchObject({ kind: 'login', done: true, state: { state: 'failed', code: 'not_installed' } });
  });

  it('answers the diagnostic without anything installed', async () => {
    const diagnostic = await b.service.diagnoseRuntimes();
    expect(diagnostic.runtimes.map((r) => [r.runtime, r.installed])).toEqual([['claude', false], ['codex', false], ['opencode', false], ['grok', false], ['hermes', false]]);
    expect(diagnostic.report).toContain('installed=no');
  });
});
