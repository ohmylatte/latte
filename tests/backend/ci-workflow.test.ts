import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(resolve(process.cwd(), 'package.json'));
const { JSON_SCHEMA, load } = require('js-yaml') as {
  JSON_SCHEMA: unknown;
  load(source: string, options?: { schema?: unknown }): unknown;
};

interface WorkflowStep {
  run?: string;
}

interface CiWorkflow {
  name?: string;
  on?: Record<string, unknown>;
  jobs?: {
    build?: {
      name?: string;
      'runs-on'?: string;
      strategy?: {
        'fail-fast'?: boolean;
        matrix?: {
          os?: string[];
        };
      };
      steps?: WorkflowStep[];
    };
  };
}

function readWorkflow(): CiWorkflow {
  const source = readFileSync(resolve(process.cwd(), '.github/workflows/ci-linux.yml'), 'utf8');
  return load(source, { schema: JSON_SCHEMA }) as CiWorkflow;
}

describe('CI workflow', () => {
  it('validates Linux and Windows without relying on local agent CLIs', () => {
    const workflow = readWorkflow();
    const job = workflow.jobs?.build;
    const runSteps = job?.steps?.flatMap((step) => step.run ?? []) ?? [];

    expect(workflow.name).toBe('CI');
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual([
      'pull_request',
      'push',
      'workflow_dispatch',
    ]);
    expect(job?.strategy?.['fail-fast']).toBe(false);
    expect(job?.strategy?.matrix?.os).toEqual(['ubuntu-24.04', 'windows-latest']);
    expect(job?.['runs-on']).toBe('${{ matrix.os }}');
    expect(job?.name).toContain('${{ matrix.os }}');
    expect(runSteps).toEqual([
      'npm ci',
      'npm run typecheck:all',
      'npm test',
      'npm run build',
    ]);
    expect(JSON.stringify(workflow)).not.toMatch(/smoke-opencode|\bopencode\b/i);
  });
});
