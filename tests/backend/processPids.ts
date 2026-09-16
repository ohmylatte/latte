import type { ChildProcess } from 'node:child_process';

export interface ProcessPids {
  child: number;
  grandchild: number;
}

export function parseProcessPids(output: string): ProcessPids {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('Invalid PID announcement: malformed JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid PID announcement: expected an object');
  }

  const { child, grandchild } = parsed as Record<string, unknown>;
  if (!isSafePid(child) || !isSafePid(grandchild)) {
    throw new Error('Invalid PID announcement: expected finite positive integer PIDs');
  }

  return { child, grandchild };
}

export function waitForProcessPids(child: ChildProcess, timeoutMs: number): Promise<ProcessPids> {
  return new Promise((resolve, reject) => {
    const stdout = child.stdout;
    if (!stdout) {
      reject(new Error('Invalid PID announcement: child stdout is unavailable'));
      return;
    }

    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(
      () => settle(() => reject(new Error('timed out waiting for child PIDs'))),
      timeoutMs,
    );

    const cleanup = (): void => {
      clearTimeout(timer);
      stdout.removeListener('data', onData);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    };
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      const output = Buffer.concat(chunks).toString('utf8');
      const newlineIndex = output.indexOf('\n');
      if (newlineIndex < 0) return;
      const line = output.slice(0, newlineIndex);
      try {
        const pids = parseProcessPids(line);
        settle(() => resolve(pids));
      } catch (error) {
        settle(() => reject(error));
      }
    };
    const onError = (error: Error): void => settle(() => reject(error));
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle(() => reject(new Error(`child exited before announcing PIDs (${code ?? signal})`)));
    };

    stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

export function isSafePid(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value > 0;
}
