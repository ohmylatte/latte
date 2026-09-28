import type { InstallFailureCode } from '../../../shared/contracts';

/* eslint-disable no-control-regex */
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ESC = /\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

/** Terminal output as plain text: escapes and control characters out, line breaks kept. */
export function stripAnsi(text: string): string {
  return text.replace(OSC8, '').replace(OSC, '').replace(CSI, '').replace(ESC, '').replace(CONTROL, '');
}

/** The targets of OSC 8 hyperlinks: the complete URL even when the visible text wraps. */
export function hyperlinkTargets(raw: string): string[] {
  return [...raw.matchAll(OSC8)].map((m) => m[1]).filter((u) => u.length > 0);
}

/**
 * Everything a hidden process printed, ANSI stripped and bounded (the tail is
 * kept: the end is what explains a failure). This is the "Ver detalle" text.
 */
export class Transcript {
  private text = '';
  /** What the processes printed, without Latte's own notes: the only input a failure is classified from. */
  private printed = '';
  private dropped = false;
  constructor(private readonly maxChars = 200_000) {}

  append(chunk: string): void {
    const clean = stripAnsi(chunk).replace(/\r\n?/g, '\n');
    this.printed = bounded(this.printed + clean, this.maxChars);
    this.push(clean);
  }

  note(line: string): void {
    this.push(`${this.text.length > 0 && !this.text.endsWith('\n') ? '\n' : ''}[latte] ${line}\n`);
  }

  /** Process output only (no `[latte]` notes, which name the command and would match their own patterns). */
  output(): string {
    return this.printed;
  }

  toString(): string {
    return this.dropped ? `[…]\n${this.text}` : this.text;
  }

  private push(clean: string): void {
    this.text += clean;
    if (this.text.length > this.maxChars) {
      this.text = bounded(this.text, this.maxChars);
      this.dropped = true;
    }
  }

  /** The last non-empty lines, short: the technical `detail` of a failure. Never the whole dump. */
  tail(lines = 3, maxChars = 300): string {
    const picked = this.text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).slice(-lines).join(' · ');
    return picked.length > maxChars ? `…${picked.slice(picked.length - maxChars)}` : picked;
  }
}

function bounded(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

const URL_CHARS =/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;

/**
 * Every https URL in terminal output. A PTY wraps a long OAuth URL at the
 * column width, so a line exactly `cols` wide that ends inside a URL is joined
 * with the next one. OSC 8 targets come first: they are never wrapped.
 */
export function extractUrls(raw: string, cols: number): string[] {
  const found = new Set<string>(hyperlinkTargets(raw).filter((u) => /^https:\/\//i.test(u)));
  const lines = stripAnsi(raw).replace(/\r\n?/g, '\n').split('\n');
  let joined = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    joined += line;
    const wrapped = line.length >= cols && i + 1 < lines.length && URL_CHARS.test(line.slice(-1)) && URL_CHARS.test(lines[i + 1].slice(0, 1));
    if (!wrapped) joined += '\n';
  }
  for (const match of joined.matchAll(/https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g)) {
    found.add(match[0].replace(/[.,;:)\]'"]+$/, ''));
  }
  return [...found];
}

/** First URL whose host is on the runtime's allowlist. Anything else is never opened. */
export function recognizeLoginUrl(urls: readonly string[], hosts: readonly RegExp[]): string | null {
  for (const candidate of urls) {
    let host: string;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'https:') continue;
      host = parsed.hostname;
    } catch {
      continue;
    }
    if (hosts.some((h) => h.test(host))) return candidate;
  }
  return null;
}

/**
 * What went wrong, from what the installer printed. Order matters: a policy
 * block also mentions "access", and an antivirus block also fails to run.
 * Unknown stays unknown: guessing a cause would send the person the wrong way.
 */
export function classifyInstallFailure(text: string): InstallFailureCode {
  if (/execution[_ ]?polic|running scripts is disabled|PSSecurityException|UnauthorizedAccess|AuthorizationManager|blocked by (?:group|your organization'?s?) polic|AppLocker|Software Restriction|This program is blocked/i.test(text)) return 'blocked_by_policy';
  if (/virus|malware|Defender|threat (?:was )?detected|potentially unwanted|quarantin|SmartScreen|operation did not complete successfully because the file contains/i.test(text)) return 'blocked_by_antivirus';
  if (/could not resolve host|getaddrinfo|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|remote name could not be resolved|unable to connect to the remote server|underlying connection was closed|SSL|TLS|certificate|curl: \((?:5|6|7|28|35|56|60)\)|network is unreachable|proxy/i.test(text)) return 'network';
  return 'unknown';
}

/** A path with the home directory as `~`, so a support report does not carry the person's user name. */
export function redactHome(target: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
  if (!home) return target;
  const same = platform === 'win32' ? target.toLowerCase().startsWith(home.toLowerCase()) : target.startsWith(home);
  return same ? `~${target.slice(home.length)}` : target;
}
