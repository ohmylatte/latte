import { describe, expect, it } from 'vitest';
import { classifyInstallFailure, extractUrls, recognizeLoginUrl, redactHome, stripAnsi, Transcript } from '../../electron/runtime/setup/text';
import { RuntimeDetector } from '../../electron/runtime/detect';
import { expandCatalogPath } from '../../electron/runtime/runtime-install-catalog';
import { fakeRunner } from './helpers';

describe('setup text helpers', () => {
  it('strips escapes and prefers OSC 8 hyperlink targets for URLs', () => {
    const raw = '\u001b]8;;https://claude.ai/oauth/authorize?a=1&b=2\u0007click here\u001b]8;;\u0007\r\n';
    expect(stripAnsi(raw)).toBe('click here\r\n');
    expect(extractUrls(raw, 80)).toContain('https://claude.ai/oauth/authorize?a=1&b=2');
  });

  it('does not glue a short line to the next one', () => {
    expect(extractUrls('see https://x.ai/a\r\nnext line\r\n', 80)).toEqual(['https://x.ai/a']);
  });

  it('only recognizes https URLs on the allowlist', () => {
    const hosts = [/^claude\.ai$/i, /^(.+\.)?anthropic\.com$/i];
    expect(recognizeLoginUrl(['http://claude.ai/x', 'https://claude.ai.evil.com/x', 'https://console.anthropic.com/o'], hosts)).toBe('https://console.anthropic.com/o');
    expect(recognizeLoginUrl(['https://evil.com/?r=claude.ai'], hosts)).toBeNull();
  });

  it('classifies the Windows failures the brief names', () => {
    expect(classifyInstallFailure('cannot be loaded because running scripts is disabled on this system')).toBe('blocked_by_policy');
    expect(classifyInstallFailure('This program is blocked by group policy.')).toBe('blocked_by_policy');
    expect(classifyInstallFailure('Windows Defender: Threat detected')).toBe('blocked_by_antivirus');
    expect(classifyInstallFailure('curl: (6) Could not resolve host: claude.ai')).toBe('network');
    expect(classifyInstallFailure('all good?')).toBe('unknown');
  });

  it('keeps the transcript bounded, notes apart from output, and a short tail', () => {
    const t = new Transcript(50);
    t.append('x'.repeat(80));
    t.note('running scripts is disabled (a note, not output)');
    expect(t.toString().startsWith('[…]')).toBe(true);
    expect(t.output()).not.toContain('scripts');
    expect(t.tail(1).length).toBeLessThanOrEqual(301);
  });

  it('redacts the home directory and expands catalog paths without guessing', () => {
    expect(redactHome('C:\\Users\\Ana\\.local\\bin\\claude.exe', { USERPROFILE: 'C:\\Users\\ana' }, 'win32')).toBe('~\\.local\\bin\\claude.exe');
    expect(redactHome('/opt/x', { HOME: '/home/ana' }, 'linux')).toBe('/opt/x');
    expect(expandCatalogPath('%LOCALAPPDATA%\\hermes\\bin\\hermes.exe', { LOCALAPPDATA: 'C:\\L' }, 'win32')).toBe('C:\\L\\hermes\\bin\\hermes.exe');
    expect(expandCatalogPath('%LOCALAPPDATA%\\hermes', {}, 'win32')).toBeNull();
    expect(expandCatalogPath('~/.local/bin/claude', { HOME: '/home/ana' }, 'linux')).toBe('/home/ana/.local/bin/claude');
  });
});

describe('RuntimeDetector with an installed-by-Latte executable', () => {
  it('uses the pinned absolute path first, even when PATH has not refreshed', async () => {
    const runner = fakeRunner((file, args) => (file === 'where.exe' ? { code: 1 } : args[0] === '--version' ? { code: 0, stdout: '2.1.211 (Claude Code)\n' } : { code: 1 }));
    const pinned = 'C:\\Users\\ana\\.local\\bin\\claude.exe';
    const detector = new RuntimeDetector({ runner, terminalAvailability: () => ({ available: true }), platform: 'win32', env: {}, pinned: (p) => (p === 'claude' ? pinned : null), exists: (t) => t === pinned });
    expect(await detector.resolve('claude')).toEqual({ provider: 'claude', executable: pinned, version: '2.1.211 (Claude Code)' });
    expect(runner.calls.some((c) => c.file === 'where.exe')).toBe(false);
  });

  it('skips a pin whose file is gone, and falls back to the official install location after PATH', async () => {
    const runner = fakeRunner((file) => (file === 'where.exe' ? { code: 1 } : { code: 0, stdout: 'v1\n' }));
    const known = 'C:\\L\\hermes\\bin\\hermes.exe';
    const detector = new RuntimeDetector({ runner, terminalAvailability: () => ({ available: true }), platform: 'win32', env: {}, pinned: () => 'C:\\gone\\hermes.exe', exists: () => false, knownPaths: (p) => (p === 'hermes' ? [known] : []) });
    expect((await detector.resolve('hermes'))?.executable).toBe(known);
    expect(await detector.resolve('grok')).toBeNull();
  });
});
