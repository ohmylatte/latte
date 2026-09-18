import { describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
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

  // --- Task 12: hardening the real socket glue --------------------------------

  describe('hardening (task 12)', () => {
    it('12b: close() forcibly ends a still-open keep-alive connection instead of leaving it bound', async () => {
      const listen = createHttpListen();
      // Deliberately never responds — this is the exact shape of a
      // keep-alive connection sitting idle when `close()` is called: without
      // `closeAllConnections()`, `server.close()` alone waits forever for
      // sockets like this one to end on their own, so `stopIfIdle` would
      // report not-listening while this old port keeps serving, and a later
      // `ensureStarted` would bind a second port with no record of the
      // first.
      const handle = await listen(() => {});
      const socket = net.createConnection({ host: '127.0.0.1', port: handle.port });
      socket.on('error', () => {}); // a forced close legitimately raises ECONNRESET here — not the thing under test
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('error', reject);
      });
      socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
      await new Promise((resolve) => setTimeout(resolve, 20)); // let the server actually accept it first

      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      handle.close();

      await Promise.race([
        closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('keep-alive socket was not forced closed within 1s — close() is not calling closeAllConnections()')), 1000)),
      ]);
    });

    // 12a: a real post-bind `http.Server` "error" event (EMFILE on accept, a
    // genuinely errored socket at the accept layer) cannot be forced
    // deterministically from a black-box unit test without OS-level fault
    // injection — there is no handle to the underlying `http.Server` outside
    // this module to `.emit('error', ...)` on, and no reachable API forces
    // one. Per this task's own fallback allowance, this is a source-level
    // assertion instead: it proves a PERMANENT handler (not the one-shot
    // `reject` used before bind) is attached after bind completes, which is
    // exactly what is missing today — `removeListener('error', reject)`
    // leaves nothing listening, so any post-bind server error becomes an
    // uncaught exception that takes down the whole Electron main process.
    it('12a [source-level fallback — see comment above]: a PERMANENT error handler is attached after the one-shot bind listener is removed', () => {
      const source = fs.readFileSync(path.resolve(__dirname, '../../electron/coordination/mcpTransport.ts'), 'utf8');
      const afterRemove = source.slice(source.indexOf("removeListener('error', reject)"));
      expect(afterRemove).toMatch(/server\.on\(\s*['"]error['"]/);
    });

    it('12a: createHttpListen accepts an optional log callback, and still round-trips a real request when one is supplied', async () => {
      const logLines: string[] = [];
      const listen = createHttpListen((line) => logLines.push(line));
      const handle = await listen((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      try {
        const body = await new Promise<string>((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port: handle.port, method: 'POST' }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          });
          req.on('error', reject);
          req.end('{}');
        });
        expect(JSON.parse(body)).toEqual({ ok: true });
        expect(logLines).toHaveLength(0); // nothing errored, so nothing should have logged
      } finally {
        handle.close();
      }
    });

    it('createHttpListen() with NO argument still compiles and works — bootstrap.ts calls it with zero args and may not be edited', async () => {
      const listen = createHttpListen();
      const handle = await listen(() => {});
      expect(handle.port).toBeGreaterThan(0);
      handle.close();
    });
  });
});
