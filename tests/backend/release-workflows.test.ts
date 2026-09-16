import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const require = createRequire(resolve(process.cwd(), 'package.json'));
const { load } = require('js-yaml') as {
  load(source: string): unknown;
};

interface WorkflowStep {
  name?: string;
  uses?: string;
  env?: {
    GH_TOKEN?: string;
  };
  run?: string;
  with?: {
    path?: string;
  };
}

interface ReleaseWorkflow {
  concurrency?: unknown;
  on?: {
    push?: {
      tags?: string[];
    };
  };
  jobs?: {
    build?: {
      steps?: WorkflowStep[];
    };
  };
}

const workflows = [
  {
    platform: 'linux',
    file: '.github/workflows/release-linux.yml',
    assets: ['release/*.AppImage', 'release/*.deb', 'release/latest-linux.yml'],
    releaseAssets: 'release/*.AppImage release/*.deb release/latest-linux.yml',
    mockAssets: ['Latte.AppImage', 'latte.deb', 'latest-linux.yml'],
  },
  {
    platform: 'windows',
    file: '.github/workflows/release-windows.yml',
    assets: ['release/Latte-Setup.exe', 'release/latest.yml', 'release/*.exe.blockmap'],
    releaseAssets: 'release/Latte-Setup.exe release/latest.yml',
    mockAssets: ['Latte-Setup.exe', 'latest.yml'],
  },
  {
    platform: 'macos',
    file: '.github/workflows/release-macos.yml',
    assets: ['release/*.dmg', 'release/*.zip', 'release/latest-mac.yml'],
    releaseAssets: '"${assets[@]}"',
    mockAssets: ['Latte.dmg', 'Latte.zip', 'latest-mac.yml'],
  },
] as const;

const scenarios = [
  { scenario: 'existing', succeeds: true, expectedCreateCount: 0 },
  { scenario: 'create-wins', succeeds: true, expectedCreateCount: 1 },
  { scenario: 'create-loses', succeeds: true, expectedCreateCount: 1 },
  { scenario: 'never-visible', succeeds: false, expectedCreateCount: 1 },
] as const;

function readWorkflow(file: string): ReleaseWorkflow {
  return load(readFileSync(resolve(process.cwd(), file), 'utf8')) as ReleaseWorkflow;
}

function releaseScript(file: string): string {
  const workflow = readWorkflow(file);
  return (
    workflow.jobs?.build?.steps?.find(
      (step) => step.env?.GH_TOKEN && step.run?.includes('gh release'),
    )?.run ?? ''
  );
}

function runReleaseScript(
  script: string,
  scenario: (typeof scenarios)[number]['scenario'],
  mockAssets: readonly string[],
) {
  const directory = mkdtempSync(join(tmpdir(), 'latte-release-workflow-'));
  const binDirectory = join(directory, 'bin');
  const logFile = join(directory, 'gh.log');
  mkdirSync(binDirectory);
  mkdirSync(join(directory, 'release'));
  for (const asset of mockAssets) writeFileSync(join(directory, 'release', asset), 'asset');

  writeFileSync(
    join(binDirectory, 'gh'),
    `#!/usr/bin/env bash
set -u
scenario="$MOCK_GH_SCENARIO"
log="$MOCK_GH_LOG"
action="$2"
printf '%s\\n' "$action" >> "$log"
case "$action" in
  view)
    case "$scenario" in
      existing) exit 0 ;;
      create-wins) test -f "$MOCK_GH_STATE" ;;
      create-loses)
        views_file="$MOCK_GH_STATE.views"
        views=0
        test ! -f "$views_file" || views="$(<"$views_file")"
        views=$((views + 1))
        printf '%s' "$views" > "$views_file"
        test "$views" -ge 2
        ;;
      never-visible) exit 1 ;;
    esac
    ;;
  create)
    if [ "$scenario" = create-wins ]; then
      : > "$MOCK_GH_STATE"
      exit 0
    fi
    exit 1
    ;;
  upload)
    shift 3
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --repo) shift 2 ;;
        --clobber) shift ;;
        *) test -e "$1" || exit 64; shift ;;
      esac
    done
    exit 0
    ;;
  *) exit 65 ;;
esac
`,
  );
  writeFileSync(join(binDirectory, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(binDirectory, 'gh'), 0o755);
  chmodSync(join(binDirectory, 'sleep'), 0o755);

  try {
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
        GITHUB_REF_NAME: 'v0.2.0',
        GITHUB_REPOSITORY: 'ohmylatte/latte',
        GITHUB_SHA: 'deadbeef',
        MOCK_GH_LOG: logFile,
        MOCK_GH_SCENARIO: scenario,
        MOCK_GH_STATE: join(directory, 'visible'),
        signed: 'true',
      },
      // Windows process creation and bash/shebang startup can exceed 5s in hosted CI;
      // keep the harness bounded while allowing that platform-specific overhead.
      timeout: process.platform === 'win32' ? 30_000 : 5_000,
    });
    const calls = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    return { calls, result };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe('release workflows', () => {
  it.each(workflows)('has valid bash syntax in every $platform run block', ({ file }) => {
    const scripts = readWorkflow(file).jobs?.build?.steps?.flatMap((step) => step.run ?? []) ?? [];

    for (const script of scripts) {
      const result = spawnSync('bash', ['-n'], { encoding: 'utf8', input: script });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it.each(workflows)('uses a bounded race-safe $platform draft release protocol', ({ file, releaseAssets }) => {
    const workflow = readWorkflow(file);
    const script = releaseScript(file);
    const initialView = script.indexOf('if ! gh release view "$tag"');
    const create = script.indexOf('if ! gh release create "$tag" \\');
    const retry = script.indexOf('for attempt in {1..10}; do');
    const upload = script.indexOf(`gh release upload "$tag" ${releaseAssets}`);

    expect(workflow.concurrency).toBeUndefined();
    expect(script).not.toBe('');
    expect(initialView).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(initialView);
    expect(script).not.toMatch(/gh release create "\$tag"[^\n]*(?:release\/|"\$\{assets\[@\]\}")/);
    expect(script).toContain('echo "::warning::No se pudo crear la release; puede haberla creado otro workflow."');
    expect(retry).toBeGreaterThan(create);
    expect(script).toMatch(
      /if gh release view "\$tag" --repo "\$GITHUB_REPOSITORY" >\/dev\/null 2>&1; then\s+break\s+fi/,
    );
    expect(script).toContain('if [ "$attempt" -eq 10 ]; then');
    expect(script).toContain('echo "::error::La release $tag no apareció después de 10 intentos."');
    expect(script).toMatch(/if \[ "\$attempt" -eq 10 \]; then\s+echo [^\n]+\s+exit 1\s+fi\s+sleep 2/);
    expect(upload).toBeGreaterThan(retry);
    expect(script).toMatch(
      new RegExp(`done\\s+gh release upload "\\$tag" ${releaseAssets.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]* --clobber`),
    );
  });

  it.each(workflows.flatMap((workflow) => scenarios.map((scenario) => ({ ...workflow, ...scenario }))))(
    '$platform release shell handles $scenario without uploading early',
    ({ file, scenario, succeeds, expectedCreateCount, mockAssets }) => {
      const { calls, result } = runReleaseScript(releaseScript(file), scenario, mockAssets);
      const uploadCount = calls.filter((call) => call === 'upload').length;
      const createCount = calls.filter((call) => call === 'create').length;

      expect(result.signal).toBeNull();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(succeeds ? 0 : 1);
      expect(createCount).toBe(expectedCreateCount);
      expect(uploadCount).toBe(succeeds ? 1 : 0);
      if (succeeds) expect(calls.lastIndexOf('view')).toBeLessThan(calls.indexOf('upload'));
    },
  );

  it('uploads only generated Windows release assets', () => {
    const script = releaseScript('.github/workflows/release-windows.yml');
    const uploadCommand = script.split('\n').find((line) => line.includes('gh release upload')) ?? '';

    expect(uploadCommand).toContain('release/Latte-Setup.exe');
    expect(uploadCommand).toContain('release/latest.yml');
    expect(uploadCommand).not.toContain('exe.blockmap');
  });

  it.each(workflows)('retains the $platform tag trigger and action artifacts', ({ file, assets }) => {
    const workflow = readWorkflow(file);
    const upload = workflow.jobs?.build?.steps?.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    const uploadedAssets = upload?.with?.path
      ?.split('\n')
      .map((asset) => asset.trim())
      .filter(Boolean);

    expect(workflow.on?.push?.tags).toEqual(['v*']);
    expect(uploadedAssets).toEqual(assets);
  });
});
