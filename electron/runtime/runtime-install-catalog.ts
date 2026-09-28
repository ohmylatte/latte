import { RUNTIME_GUIDE_URLS, type Provider, type SetupPrereq } from '../../shared/contracts';

/**
 * THE one place where Latte keeps how each agent CLI is installed, found and
 * logged in (brief 2026-09-27, "Instaladores que cambian"). Nothing else in
 * the code knows an installer URL.
 *
 * Every install command is copied from the runtime's OFFICIAL docs and carries
 * the date it was checked and the page it came from. An entry with
 * `verified: false` is never executed: the engine answers
 * `failed{code:'unverified_installer'}` and the UI offers the official guide.
 * Before changing a command, re-read the source page and move `verifiedAt`.
 */

export type SetupOs = 'win32' | 'darwin' | 'linux';

export interface InstallCommand {
  /**
   * The exact one-liner the docs give. On Windows it runs as
   * `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <script>`
   * (Bypass scoped to that one process); elsewhere as `/bin/bash -c <script>`.
   * Never string-built from input: these are constants.
   */
  script: string;
  verified: boolean;
  verifiedAt: string;
  source: string;
  note?: string;
  /** CPU architectures the official installer supports on this OS; absent = all. */
  arch?: readonly string[];
}

export interface PrereqRequirement {
  prereq: SetupPrereq;
  /** false = recommended: never blocks the install; installed only when the person says yes. */
  required: boolean;
}

export interface LoginSpec {
  /** Latte drives it through the system browser. false = straight to the embedded terminal (the CLI needs choices first). */
  browser: boolean;
  /** Arguments for the hidden PTY. Codex does not use a PTY: its app-server returns the URL (`account/login/start`). */
  args: readonly string[];
  /** Hosts a captured login URL may point at. A URL outside this list is never opened. */
  urlHosts: readonly RegExp[];
  /** Output meaning "the CLI opened the browser by itself" (so Latte does not open a second tab). */
  openedByRuntime?: RegExp;
  /** Output meaning the login finished; the runtime's status check still confirms it. */
  success?: RegExp;
  verified: boolean;
  source: string;
  note: string;
}

export interface RuntimeCatalogEntry {
  runtime: Provider;
  /** Official docs page shown as plan B ("Probá con la guía oficial"). */
  guideUrl: string;
  /** Executable base name looked up on PATH. */
  command: string;
  install: Partial<Record<SetupOs, InstallCommand>>;
  /** Where the official installer leaves the executable, per OS, with `~` = home and `%VAR%` = env. Checked without PATH. */
  paths: Partial<Record<SetupOs, readonly string[]>>;
  prereqs: Partial<Record<SetupOs, readonly PrereqRequirement[]>>;
  /** Arguments that print the version (verify step). */
  versionArgs: readonly string[];
  login: LoginSpec | null;
}

const CLAUDE_SETUP = RUNTIME_GUIDE_URLS.claude;
const CLAUDE_AUTH = 'https://code.claude.com/docs/en/authentication';
const CODEX_README = RUNTIME_GUIDE_URLS.codex;
const OPENCODE_DOCS = RUNTIME_GUIDE_URLS.opencode;
const GROK_DOCS = RUNTIME_GUIDE_URLS.grok;
const HERMES_INSTALL = RUNTIME_GUIDE_URLS.hermes;
const CHECKED = '2026-09-28';

export const RUNTIME_INSTALL_CATALOG: Readonly<Record<Provider, RuntimeCatalogEntry>> = {
  claude: {
    runtime: 'claude',
    guideUrl: CLAUDE_SETUP,
    command: 'claude',
    install: {
      win32: { script: 'irm https://claude.ai/install.ps1 | iex', verified: true, verifiedAt: CHECKED, source: CLAUDE_SETUP },
      darwin: { script: 'curl -fsSL https://claude.ai/install.sh | bash', verified: true, verifiedAt: CHECKED, source: CLAUDE_SETUP },
      linux: { script: 'curl -fsSL https://claude.ai/install.sh | bash', verified: true, verifiedAt: CHECKED, source: CLAUDE_SETUP },
    },
    // Uninstall section of the setup page: `$env:USERPROFILE\.local\bin\claude.exe`, `~/.local/bin/claude`.
    paths: { win32: ['%USERPROFILE%\\.local\\bin\\claude.exe'], darwin: ['~/.local/bin/claude'], linux: ['~/.local/bin/claude'] },
    // "Installing Git for Windows is optional. It enables the Bash tool" (setup page, 2026-09-28).
    // The brief assumed it was required; the docs say otherwise, so it never blocks.
    prereqs: { win32: [{ prereq: 'git_for_windows', required: false }] },
    versionArgs: ['--version'],
    login: {
      browser: true,
      args: ['auth', 'login'],
      urlHosts: [/^claude\.ai$/i, /^(.+\.)?claude\.com$/i, /^(.+\.)?anthropic\.com$/i],
      openedByRuntime: /opening browser|opened (?:your |the )?browser/i,
      success: /login successful/i,
      verified: false,
      source: CLAUDE_AUTH,
      note: 'The docs describe `claude` + browser prompt ("press c to copy the login URL", "Login successful"). `claude auth login|status|logout` is what Latte already runs (hub.ts, accounts.ts); its exact URL line is not documented, so URL capture is best effort and falls back to the embedded terminal.',
    },
  },
  codex: {
    runtime: 'codex',
    guideUrl: CODEX_README,
    command: 'codex',
    install: {
      win32: { script: 'irm https://chatgpt.com/codex/install.ps1 | iex', verified: true, verifiedAt: CHECKED, source: CODEX_README, note: 'README: powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"' },
      darwin: { script: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', verified: true, verifiedAt: CHECKED, source: CODEX_README },
      linux: { script: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', verified: true, verifiedAt: CHECKED, source: CODEX_README },
    },
    // Not documented: found after install through the fresh user PATH instead.
    paths: {},
    prereqs: {},
    versionArgs: ['--version'],
    login: {
      browser: true,
      args: [],
      urlHosts: [/^(.+\.)?openai\.com$/i, /^(.+\.)?chatgpt\.com$/i],
      verified: true,
      source: CODEX_README,
      note: 'Latte logs in through the Codex app-server (`account/login/start` returns `authUrl`), not a PTY.',
    },
  },
  opencode: {
    runtime: 'opencode',
    guideUrl: OPENCODE_DOCS,
    command: 'opencode',
    install: {
      // No one-line script for Windows in the docs: npm is one of the listed options, and it needs Node.
      win32: { script: 'npm install -g opencode-ai', verified: true, verifiedAt: CHECKED, source: OPENCODE_DOCS, note: 'Docs list choco, scoop, npm and mise for Windows; npm is the one Latte can run.' },
      darwin: { script: 'curl -fsSL https://opencode.ai/install | bash', verified: true, verifiedAt: CHECKED, source: OPENCODE_DOCS },
      linux: { script: 'curl -fsSL https://opencode.ai/install | bash', verified: true, verifiedAt: CHECKED, source: OPENCODE_DOCS },
    },
    paths: { win32: ['%APPDATA%\\npm\\opencode.cmd'], darwin: ['~/.opencode/bin/opencode', '~/bin/opencode'], linux: ['~/.opencode/bin/opencode', '~/bin/opencode'] },
    prereqs: { win32: [{ prereq: 'node', required: true }] },
    versionArgs: ['--version'],
    // OpenCode's providers log in through Ajustes → Proveedores (`startProviderOAuth`), not here.
    login: null,
  },
  grok: {
    runtime: 'grok',
    guideUrl: GROK_DOCS,
    command: 'grok',
    install: {
      win32: { script: 'irm https://x.ai/cli/install.ps1 | iex', verified: true, verifiedAt: CHECKED, source: GROK_DOCS },
      darwin: { script: 'curl -fsSL https://x.ai/cli/install.sh | bash', verified: true, verifiedAt: CHECKED, source: GROK_DOCS },
      linux: { script: 'curl -fsSL https://x.ai/cli/install.sh | bash', verified: true, verifiedAt: CHECKED, source: GROK_DOCS },
    },
    paths: {},
    prereqs: {},
    versionArgs: ['--version'],
    login: {
      browser: true,
      args: ['login'],
      urlHosts: [/^(.+\.)?x\.ai$/i, /^(.+\.)?grok\.com$/i, /^(.+\.)?x\.com$/i],
      openedByRuntime: /opening (?:your )?browser|opened (?:your |the )?browser/i,
      verified: false,
      source: GROK_DOCS,
      note: 'Docs: "On first launch, Grok opens a browser for authentication". `grok login` is what Latte already runs (measured on 1.0.41); the URL line is not documented.',
    },
  },
  hermes: {
    runtime: 'hermes',
    guideUrl: HERMES_INSTALL,
    command: 'hermes',
    install: {
      win32: { script: 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)', verified: true, verifiedAt: CHECKED, source: HERMES_INSTALL, note: 'Windows can bootstrap Git itself (docs).' },
      darwin: { script: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash', verified: true, verifiedAt: CHECKED, source: HERMES_INSTALL, arch: ['arm64'], note: 'Apple Silicon only: Intel macOS is unsupported (docs).' },
      linux: { script: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash', verified: true, verifiedAt: CHECKED, source: HERMES_INSTALL },
    },
    // The docs name the folder (`%LOCALAPPDATA%\hermes\bin\`), not the file: both shim kinds are tried.
    paths: { win32: ['%LOCALAPPDATA%\\hermes\\bin\\hermes.exe', '%LOCALAPPDATA%\\hermes\\bin\\hermes.cmd'], darwin: ['~/.local/bin/hermes'], linux: ['~/.local/bin/hermes'] },
    prereqs: {},
    versionArgs: ['--version'],
    login: {
      browser: false,
      args: ['model'],
      urlHosts: [],
      verified: false,
      source: HERMES_INSTALL,
      note: '`hermes model` asks for a provider and a model first (interactive), so it goes straight to the embedded terminal.',
    },
  },
};

/** Official pages for the prerequisites, and the one Latte can install itself. */
export const PREREQ_CATALOG: Readonly<Record<SetupPrereq, { guideUrl: string; install: { win32?: { file: 'winget'; args: readonly string[]; verified: boolean; verifiedAt: string; source: string } } }>> = {
  git_for_windows: {
    guideUrl: 'https://git-scm.com/install/windows',
    // `winget install --id Git.Git -e --source winget`, as git-scm.com shows it; the agreement flags only keep it non-interactive.
    install: { win32: { file: 'winget', args: ['install', '--id', 'Git.Git', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], verified: true, verifiedAt: CHECKED, source: 'https://git-scm.com/install/windows' } },
  },
  winget: { guideUrl: 'https://learn.microsoft.com/windows/package-manager/winget/', install: {} },
  node: { guideUrl: 'https://nodejs.org/en/download', install: {} },
};

export function setupOs(platform: NodeJS.Platform): SetupOs | null {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : null;
}

/** `~` and `%VAR%` expanded for this machine; null when a variable is missing (never guessed). */
export function expandCatalogPath(template: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
  let missing = false;
  let out = template.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, name: string) => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    const value = key ? env[key] : undefined;
    if (!value) { missing = true; return ''; }
    return value;
  });
  if (out.startsWith('~')) {
    if (!home) return null;
    out = home + out.slice(1);
  }
  if (platform === 'win32') out = out.replace(/\//g, '\\');
  return missing ? null : out;
}
