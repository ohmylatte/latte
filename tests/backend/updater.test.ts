import { describe, expect, it } from 'vitest';
import type { UpdateState, UpdateUnsupportedKind } from '../../shared/contracts';
import { UpdateController, type UpdateActivity, type UpdaterEngine } from '../../electron/updater/controller';
import { decideUpdaterAvailability } from '../../electron/updater/engine';
import { attachCloseGuard, attachQuitGuard } from '../../electron/windowClose';

const SOURCE_UPDATER_REASON = 'Estás usando Latte desde el código fuente. Las actualizaciones automáticas vienen con el instalador.';

describe('Updater availability follows the installed artifact', () => {
  it.each([
    {
      name: 'a packaged Linux AppImage',
      input: { isPackaged: true, devServerUrl: null, platform: 'linux', appImage: '/tmp/Latte.AppImage' },
      enabled: true,
    },
    {
      name: 'packaged Windows',
      input: { isPackaged: true, devServerUrl: null, platform: 'win32', appImage: undefined },
      enabled: true,
    },
    {
      name: 'packaged macOS',
      input: { isPackaged: true, devServerUrl: null, platform: 'darwin', appImage: undefined },
      enabled: true,
    },
  ])('enables updates for $name', ({ input, enabled }) => {
    expect(decideUpdaterAvailability(input)).toEqual({ enabled, reason: '' });
  });

  it.each([undefined, ''])('disables updates for a packaged Linux .deb install when APPIMAGE is %s', (appImage) => {
    const result = decideUpdaterAvailability({
      isPackaged: true,
      devServerUrl: null,
      platform: 'linux',
      appImage,
    });

    expect(result.enabled).toBe(false);
    expect(result.unsupportedKind).toBe('manual-install');
    expect(result.reason).toContain('.deb');
    expect(result.reason).toContain('no se actualiza automáticamente');
    expect(result.reason).toContain('reinstal');
  });

  it.each([
    { name: 'an unpackaged build', isPackaged: false, devServerUrl: null },
    { name: 'the dev server', isPackaged: true, devServerUrl: 'http://localhost:5173' },
  ])('keeps the existing source reason for $name', ({ isPackaged, devServerUrl }) => {
    expect(decideUpdaterAvailability({
      isPackaged,
      devServerUrl,
      platform: 'linux',
      appImage: '/tmp/Latte.AppImage',
    })).toEqual({ enabled: false, reason: SOURCE_UPDATER_REASON, unsupportedKind: 'source' });
  });
});

/** An update server we drive by hand: nothing here touches the network. */
function fakeEngine() {
  const listeners = {
    available: [] as ((version: string) => void)[],
    notAvailable: [] as (() => void)[],
    progress: [] as ((percent: number) => void)[],
    downloaded: [] as ((version: string) => void)[],
    error: [] as ((message: string) => void)[],
  };
  const calls = { checks: 0, downloads: 0 };
  let checkFails: string | null = null;
  const engine: UpdaterEngine = {
    onAvailable: (l) => { listeners.available.push(l); },
    onNotAvailable: (l) => { listeners.notAvailable.push(l); },
    onProgress: (l) => { listeners.progress.push(l); },
    onDownloaded: (l) => { listeners.downloaded.push(l); },
    onError: (l) => { listeners.error.push(l); },
    checkForUpdates: async () => {
      calls.checks += 1;
      if (checkFails) throw new Error(checkFails);
    },
    downloadUpdate: async () => { calls.downloads += 1; },
  };
  return {
    engine,
    calls,
    failNextCheck: (message: string) => { checkFails = message; },
    stopFailing: () => { checkFails = null; },
    emitAvailable: (version: string) => listeners.available.forEach((l) => l(version)),
    emitNotAvailable: () => listeners.notAvailable.forEach((l) => l()),
    emitProgress: (percent: number) => listeners.progress.forEach((l) => l(percent)),
    emitDownloaded: (version: string) => listeners.downloaded.forEach((l) => l(version)),
    emitError: (message: string) => listeners.error.forEach((l) => l(message)),
  };
}

interface SetupOptions {
  withEngine?: boolean;
  unsupportedKind?: UpdateUnsupportedKind;
  unsaved?: boolean;
  activity?: UpdateActivity;
  confirm?: boolean;
  installThrows?: boolean;
}

function setup(options: SetupOptions = {}) {
  const fake = fakeEngine();
  const states: UpdateState[] = [];
  const asked: Array<{ activity: UpdateActivity; version: string }> = [];
  let installs = 0;
  let unsaved = options.unsaved === true;
  let installThrows = options.installThrows === true;
  const controller = new UpdateController({
    engine: options.withEngine === false ? null : fake.engine,
    unsupportedReason: 'Latte corre desde el código fuente.',
    unsupportedKind: options.unsupportedKind,
    emit: (state) => states.push(state),
    hasUnsavedWork: () => unsaved,
    activity: () => options.activity ?? { chats: 0, terminals: 0 },
    confirmInstall: (activity, version) => { asked.push({ activity, version }); return options.confirm !== false; },
    beginInstall: () => {
      installs += 1;
      if (installThrows) throw new Error('quitAndInstall exploded');
    },
  });
  return {
    controller,
    fake,
    states,
    asked,
    installs: () => installs,
    setUnsaved: (value: boolean) => { unsaved = value; },
    setInstallThrows: (value: boolean) => { installThrows = value; },
  };
}

describe('An update is offered, never imposed', () => {
  it('starts idle and reports a new version without downloading anything', async () => {
    const { controller, fake } = setup();
    expect(controller.current().phase).toBe('idle');

    await controller.check();
    expect(fake.calls.checks).toBe(1);
    expect(controller.current().phase).toBe('checking');

    fake.emitAvailable('0.2.0');
    expect(controller.current()).toMatchObject({ phase: 'available', version: '0.2.0' });
    // Finding a version must not start a transfer on its own.
    expect(fake.calls.downloads).toBe(0);
  });

  it('goes back to idle when there is nothing new', async () => {
    const { controller, fake } = setup();
    await controller.check();
    fake.emitNotAvailable();
    expect(controller.current().phase).toBe('idle');
  });

  it('downloads only when asked, and reports progress', async () => {
    const { controller, fake } = setup();
    await controller.check();
    fake.emitAvailable('0.2.0');

    await controller.download();
    expect(fake.calls.downloads).toBe(1);
    expect(controller.current()).toMatchObject({ phase: 'downloading', version: '0.2.0', percent: 0 });

    fake.emitProgress(42.6);
    expect(controller.current().percent).toBe(43);
    // Progress outside the range is clamped, never shown as 1200%.
    fake.emitProgress(1200);
    expect(controller.current().percent).toBe(100);

    fake.emitDownloaded('0.2.0');
    expect(controller.current()).toMatchObject({ phase: 'ready', version: '0.2.0', percent: 100 });
  });

  it('never checks or downloads without an engine', async () => {
    const { controller, fake } = setup({ withEngine: false, unsupportedKind: 'source' });
    expect(controller.current()).toMatchObject({
      phase: 'unsupported',
      message: 'Latte corre desde el código fuente.',
      unsupportedKind: 'source',
    });
    await controller.check();
    await controller.download();
    expect(fake.calls).toEqual({ checks: 0, downloads: 0 });
    expect(controller.install()).toEqual({ status: 'not-ready' });
  });

  it('owns manual-install classification in the initial unsupported state', () => {
    const { controller } = setup({ withEngine: false, unsupportedKind: 'manual-install' });

    expect(controller.current()).toMatchObject({
      phase: 'unsupported',
      unsupportedKind: 'manual-install',
    });
  });

  it('does not carry unsupported classification into supported phases', async () => {
    const { controller, fake, states } = setup({ unsupportedKind: 'manual-install' });

    await controller.check();
    fake.emitAvailable('0.2.0');

    expect(controller.current()).not.toHaveProperty('unsupportedKind');
    expect(states.every((state) => !Object.hasOwn(state, 'unsupportedKind'))).toBe(true);
  });
});

describe('Installing asks first and protects the work', () => {
  it.each(['event', 'later-event', 'throw', 'event-and-throw'] as const)(
    'restores both close guards and permits a real retry after %s', async (failure) => {
      const fake = fakeEngine();
      let unsaved = false;
      let quitting = false;
      let attempts = 0;
      let rollbacks = 0;
      let stops = 0;
      let questions = 0;
      let closeListener = (_event: { preventDefault(): void }) => {};
      let quitListener = (_event: { preventDefault(): void }) => {};
      const guard = attachCloseGuard({
        on: (_event, listener) => { closeListener = listener; },
        close: () => {},
      }, {
        hasUnsavedWork: () => unsaved,
        confirm: () => { questions += 1; return false; },
      });
      attachQuitGuard({ on: (_event, listener) => { quitListener = listener; } }, {
        hasUnsavedWork: () => unsaved,
        confirm: () => { questions += 1; return false; },
        isDecided: () => quitting,
        decide: () => { quitting = true; guard.allowClose(); },
        stop: () => { stops += 1; },
      });
      const controller = new UpdateController({
        engine: fake.engine,
        emit: () => {},
        hasUnsavedWork: () => unsaved,
        activity: () => ({ chats: 0, terminals: 0 }),
        confirmInstall: () => true,
        beginInstall: () => {
          attempts += 1;
          quitting = true;
          guard.allowClose();
          if (attempts > 1) return;
          if (failure === 'event' || failure === 'event-and-throw') fake.emitError('installer failed');
          if (failure === 'throw' || failure === 'event-and-throw') throw new Error('installer failed');
        },
        installFailed: () => {
          rollbacks += 1;
          quitting = false;
          guard.requireConfirmation();
        },
      });
      fake.emitDownloaded('0.2.0');
      expect(controller.install()).toEqual({ status: failure === 'later-event' ? 'installing' : 'not-ready' });
      if (failure === 'later-event') {
        await Promise.resolve();
        fake.emitError('installer failed');
      }
      expect(controller.current().phase).toBe('error');
      expect(rollbacks).toBe(1);
      expect(quitting).toBe(false);
      unsaved = true;
      let prevented = 0;
      closeListener({ preventDefault: () => { prevented += 1; } });
      quitListener({ preventDefault: () => { prevented += 1; } });
      expect(prevented).toBe(2);
      expect(questions).toBe(2);
      expect(stops).toBe(0);
      await controller.download();
      fake.emitDownloaded('0.2.0');
      expect(controller.install()).toEqual({ status: 'unsaved' });
      unsaved = false;
      expect(controller.install()).toEqual({ status: 'installing' });
      expect(attempts).toBe(2);
      quitListener({ preventDefault: () => { throw new Error('confirmed retry was vetoed'); } });
      expect(stops).toBe(1);
      expect(questions).toBe(2);
    },
  );

  async function ready(options: SetupOptions = {}) {
    const s = setup(options);
    await s.controller.check();
    s.fake.emitAvailable('0.2.0');
    await s.controller.download();
    s.fake.emitDownloaded('0.2.0');
    return s;
  }

  it('refuses to install while a document has unsaved changes', async () => {
    const s = await ready({ unsaved: true });
    expect(s.controller.install()).toEqual({ status: 'unsaved' });
    // Refused before anything was asked: the user is sent back to the editor,
    // not offered a button that loses the document.
    expect(s.asked).toEqual([]);
    expect(s.installs()).toBe(0);
    // The update is still there, waiting.
    expect(s.controller.current().phase).toBe('ready');
  });

  it('installs once the work is saved', async () => {
    const s = await ready({ unsaved: true });
    expect(s.controller.install()).toEqual({ status: 'unsaved' });
    s.setUnsaved(false);
    expect(s.controller.install()).toEqual({ status: 'installing' });
    expect(s.installs()).toBe(1);
  });

  it('says what is running before restarting, and stops when the user cancels', async () => {
    const s = await ready({ activity: { chats: 2, terminals: 1 }, confirm: false });
    expect(s.controller.install()).toEqual({ status: 'cancelled' });
    expect(s.asked).toEqual([{ activity: { chats: 2, terminals: 1 }, version: '0.2.0' }]);
    expect(s.installs()).toBe(0);
    // Cancelling leaves a working app with the update still available.
    expect(s.controller.current().phase).toBe('ready');
  });

  it('refuses to install before the download is finished', async () => {
    const s = setup();
    await s.controller.check();
    s.fake.emitAvailable('0.2.0');
    expect(s.controller.install()).toEqual({ status: 'not-ready' });
    await s.controller.download();
    expect(s.controller.install()).toEqual({ status: 'not-ready' });
    expect(s.installs()).toBe(0);
  });

  it('leaves a usable app behind when the restart itself fails', async () => {
    const s = await ready({ installThrows: true });
    expect(s.controller.install()).toEqual({ status: 'not-ready' });
    expect(s.controller.current().phase).toBe('error');
    // And it can be tried again rather than being stuck "installing".
    s.setInstallThrows(false);
    s.fake.emitDownloaded('0.2.0');
    expect(s.controller.install()).toEqual({ status: 'installing' });
    expect(s.installs()).toBe(2);
  });
});

describe('Failures are reported in words the user can act on', () => {
  it('turns a connection failure into an explanation, and retries', async () => {
    const { controller, fake } = setup();
    fake.failNextCheck('getaddrinfo ENOTFOUND github.com');
    await controller.check();
    expect(controller.current().phase).toBe('error');
    expect(controller.current().message).toContain('conexión');

    // Retrying after a failed check goes back to checking, not to a download.
    fake.stopFailing();
    await controller.download();
    expect(fake.calls.downloads).toBe(0);
    expect(fake.calls.checks).toBe(2);
    expect(controller.current().phase).toBe('checking');
  });

  it('keeps the offered version so a failed download can be retried', async () => {
    const { controller, fake } = setup();
    await controller.check();
    fake.emitAvailable('0.2.0');
    await controller.download();
    fake.emitError('sha512 checksum mismatch');
    expect(controller.current()).toMatchObject({ phase: 'error', version: '0.2.0' });
    expect(controller.current().message).toContain('no coincide');

    await controller.download();
    expect(fake.calls.downloads).toBe(2);
    expect(controller.current().phase).toBe('downloading');
  });

  it('ignores a late "available" that would rewind a finished download', async () => {
    const { controller, fake } = setup();
    await controller.check();
    fake.emitAvailable('0.2.0');
    await controller.download();
    fake.emitDownloaded('0.2.0');

    fake.emitAvailable('0.2.0');
    fake.emitNotAvailable();
    expect(controller.current().phase).toBe('ready');
  });

  it('emits every state change so the renderer can follow along', async () => {
    const { controller, fake, states } = setup();
    await controller.check();
    fake.emitAvailable('0.2.0');
    await controller.download();
    fake.emitProgress(50);
    fake.emitDownloaded('0.2.0');
    expect(states.map((s) => s.phase)).toEqual(['checking', 'available', 'downloading', 'downloading', 'ready']);
  });
});
