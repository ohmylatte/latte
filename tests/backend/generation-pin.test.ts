import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashGenerationContext } from '../../electron/generation/canon';
import { pinGeneration, readPinSourceBytes } from '../../electron/generation/pin';
import { LattePaths, WORK_FILES } from '../../electron/core/paths';
import { WorkspaceFiles } from '../../electron/workspace/workspace';
import type { GenerationContext } from '../../shared/generationContracts';
import { makeTempDir, removeDir } from './helpers';

const H = (ch: string) => ch.repeat(64);

function context(): GenerationContext {
  return {
    schemaVersion: 1,
    workId: 'wrk_pin',
    brandId: 'brd_pin',
    brandContext: { kitId: 'gen_cccccccccccccccccccc', version: 1, hash: H('c') },
    skillRefs: [],
  };
}

describe('generation pin', () => {
  let dir: string;
  afterEach(() => { if (dir) removeDir(dir); });

  it('writes context.json and real asset copies, never a symlink', () => {
    dir = makeTempDir();
    const workDir = path.join(dir, 'work');
    fs.mkdirSync(workDir);
    const sealed = hashGenerationContext(context());
    const result = pinGeneration({
      workDir,
      generationId: 'gen_cccccccccccccccccccc',
      context: sealed.context,
      snapshot: null,
      contextHash: sealed.hash,
      assets: [{ id: 'logo-main', bytes: Buffer.from('PNG-BYTES') }],
    });
    const contextFile = path.join(result.directory, 'context.json');
    const assetFile = path.join(result.directory, 'assets', 'logo-main');
    expect(fs.existsSync(contextFile)).toBe(true);
    expect(fs.readFileSync(assetFile, 'utf8')).toBe('PNG-BYTES');
    expect(fs.lstatSync(assetFile).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(contextFile).isSymbolicLink()).toBe(false);
    expect(JSON.parse(fs.readFileSync(contextFile, 'utf8')).contextHash).toBe(sealed.hash);
  });

  it('rejects a second pin of the same id and traversal in a source path', () => {
    dir = makeTempDir();
    const workDir = path.join(dir, 'work');
    fs.mkdirSync(workDir);
    const sealed = hashGenerationContext(context());
    const once = { workDir, generationId: 'gen_cccccccccccccccccccc', context: sealed.context, snapshot: null, contextHash: sealed.hash };
    pinGeneration(once);
    expect(() => pinGeneration(once)).toThrow(/VERSION_CONFLICT|already exists/);
    expect(() => readPinSourceBytes(workDir, '../outside')).toThrow();
  });

  it('syncSideFiles does not delete .latte/generations', () => {
    dir = makeTempDir();
    const paths = new LattePaths(dir);
    const files = new WorkspaceFiles(paths);
    files.ensureWork('brd_pin', 'wrk_pin', '# brief\n');
    const workDir = files.workDir('brd_pin', 'wrk_pin');
    const sealed = hashGenerationContext(context());
    pinGeneration({
      workDir,
      generationId: 'gen_cccccccccccccccccccc',
      context: sealed.context,
      snapshot: null,
      contextHash: sealed.hash,
    });
    const pinned = path.join(workDir, WORK_FILES.metaDir, WORK_FILES.generationsDir, 'gen_cccccccccccccccccccc', 'context.json');
    expect(fs.existsSync(pinned)).toBe(true);

    files.writeInstructions('brd_pin', 'wrk_pin', '<!-- latte:managed -->\n# rewritten\n', [
      { path: `${WORK_FILES.metaDir}/${WORK_FILES.contextDir}/brand.md`, content: 'brand' },
    ]);
    // A stale side file in context/ would be removed; the pin must remain.
    expect(fs.existsSync(pinned)).toBe(true);
    expect(fs.readFileSync(pinned, 'utf8')).toContain(sealed.hash);
    expect(WORK_FILES.generationsDir).toBe('generations');
    expect(WORK_FILES.generationsDir).not.toBe(WORK_FILES.contextDir);
    expect(WORK_FILES.generationsDir).not.toBe(WORK_FILES.skillsDir);
    expect(WORK_FILES.generationsDir).not.toBe(WORK_FILES.snapshotsDir);
  });
});
