import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { installProcessStreamErrorGuards } from '../../electron/core/processStreams';

describe('process stream error guards', () => {
  it.each(['stdout', 'stderr'])('ignores EPIPE errors from %s', (streamName) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    installProcessStreamErrorGuards(stdout, stderr);

    const stream = streamName === 'stdout' ? stdout : stderr;
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => stream.emit('error', error)).not.toThrow();
  });

  it('rethrows non-EPIPE errors', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    installProcessStreamErrorGuards(stdout, stderr);

    const error = Object.assign(new Error('stream failed'), { code: 'EIO' });
    expect(() => stdout.emit('error', error)).toThrow(error);
  });

  it('installs only one guard per stream when called twice', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();

    installProcessStreamErrorGuards(stdout, stderr);
    installProcessStreamErrorGuards(stdout, stderr);

    expect(stdout.listenerCount('error')).toBe(1);
    expect(stderr.listenerCount('error')).toBe(1);
  });

  it('wires the guards before main startup can log or take the app lock', () => {
    const mainSource = readFileSync('electron/main.ts', 'utf8');
    const guardCall = mainSource.indexOf('installProcessStreamErrorGuards(process.stdout, process.stderr);');
    const firstConsoleCall = mainSource.indexOf('console.');
    const lockCall = mainSource.indexOf('app.requestSingleInstanceLock()');

    expect(guardCall).toBeGreaterThan(-1);
    expect(guardCall).toBeLessThan(firstConsoleCall);
    expect(guardCall).toBeLessThan(lockCall);
  });
});
