import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHttpListen } from '../../electron/coordination/mcpTransport';

// The ONE place a real socket is legitimate in this suite: `mcpServer.ts`
// deliberately left `listen` as an injected dependency with no default (task
// 6.19/6.20), so hub wiring (task 6.28+) supplies the real `node:http`
// implementation. Every other coordination test injects a fake `listen` and
// stays socket-free; this file proves the real one actually binds loopback
// and round-trips a request/response through `handleMcpRequest`'s own shape.

describe('createHttpListen — the real node:http glue (task 6.28)', () => {
  it('binds 127.0.0.1 on an OS-assigned port and delivers a real request to the listener', async () => {
    const listen = createHttpListen();
    const received: { authorization?: string; body: string } = { body: '' };
    const handle = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', ((c: Buffer) => chunks.push(c)) as never);
      req.on('end', (() => {
        received.authorization = req.headers.authorization;
        received.body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }) as never);
    });
    try {
      expect(handle.port).toBeGreaterThan(0);
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: handle.port, method: 'POST', headers: { authorization: 'Bearer tok_abc' } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.on('error', reject);
        req.end('{"hello":"world"}');
      });
      expect(JSON.parse(body)).toEqual({ ok: true });
      expect(received.authorization).toBe('Bearer tok_abc');
      expect(received.body).toBe('{"hello":"world"}');
    } finally {
      handle.close();
    }
  });

  it('close() actually releases the port (a second listen can bind a fresh one without hanging)', async () => {
    const listen = createHttpListen();
    const first = await listen(() => {});
    first.close();
    const second = await listen(() => {});
    expect(second.port).toBeGreaterThan(0);
    second.close();
  });
});
