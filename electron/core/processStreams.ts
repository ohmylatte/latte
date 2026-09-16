export interface ErrorEventSource {
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

const guardedStreams = new WeakSet<ErrorEventSource>();

export function installProcessStreamErrorGuards(
  stdout: ErrorEventSource,
  stderr: ErrorEventSource,
): void {
  for (const stream of [stdout, stderr]) {
    if (guardedStreams.has(stream)) continue;
    stream.on('error', (error: unknown) => {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPIPE') return;
      throw error;
    });
    guardedStreams.add(stream);
  }
}
