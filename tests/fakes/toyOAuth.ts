/**
 * Servidor de juguete: un recurso protegido MCP + su authorization server,
 * herméticos, en `127.0.0.1` y sin una sola dependencia.
 *
 * Es el `toy-mcp.js` del apéndice del brief
 * (`docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`, sección 7)
 * portado a `tests/fakes/` como pide 4.3. Modela lo que se MIDIÓ contra los
 * servidores reales, no lo que dice la especificación:
 *
 * - los well-known responden en forma **path-aware** y, opcionalmente, sólo en
 *   esa forma (el caso Meta de la sección 3: el genérico da 404, así que un
 *   cliente que pruebe sólo la forma genérica no descubre nada);
 * - el `registration_endpoint` se publica **siempre**, pero puede rechazar
 *   todo registro con el mismo cuerpo que devolvió Meta
 *   (`invalid_client_metadata` · "Dynamic registration is not available for
 *   this client."), que es el caso que obliga a caer al `clientId` guardado;
 * - PKCE `S256` se verifica de verdad: un `code_verifier` que no corresponde
 *   al challenge no canjea nada.
 *
 * Ningún login real: acá no hay cuentas de nadie.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface ToyOAuthOptions {
  /** Ruta del servidor MCP protegido. Con path para ejercitar el descubrimiento path-aware. */
  resourcePath?: string;
  /** Como Meta: los well-known genéricos devuelven 404 y sólo responde la forma path-aware. */
  pathAwareOnly?: boolean;
  /** Como Meta: publica `registration_endpoint` pero rechaza todo registro. */
  refuseRegistration?: boolean;
  /** No publicar `registration_endpoint` en absoluto. */
  noRegistrationEndpoint?: boolean;
  /** Publicar `revocation_endpoint`. */
  revocation?: boolean;
  /** Segundos de vida del access token. */
  expiresIn?: number;
  /** El refresh falla con `invalid_grant`: el camino "no hay refresh posible" del gateway. */
  refuseRefresh?: boolean;
}

export interface ToyOAuthServer {
  origin: string;
  /** La URL del servidor MCP protegido: lo que la persona pega en "Agregar conexión". */
  resourceUrl: string;
  close(): Promise<void>;
  /** Todo lo que llegó, en orden: `${method} ${path}`. El log del apéndice, como assertion. */
  readonly hits: string[];
  /** Los `client_id` que emitió el registro dinámico. */
  readonly registered: Array<{ clientId: string; redirectUris: string[]; authMethod: string }>;
  /** Access tokens vivos → el refresh que les corresponde. */
  readonly issued: Map<string, { refreshToken: string; clientId: string }>;
  /** Invalida un access token sin tocar su refresh: el 401 a mitad de run. */
  expire(accessToken: string): void;
}

const b64url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface PendingCode {
  challenge: string;
  method: string;
  redirectUri: string;
  clientId: string;
  resource: string | null;
}

export async function startToyOAuth(options: ToyOAuthOptions = {}): Promise<ToyOAuthServer> {
  const resourcePath = options.resourcePath ?? '/api/mcp';
  const expiresIn = options.expiresIn ?? 3600;
  const hits: string[] = [];
  const registered: ToyOAuthServer['registered'] = [];
  const issued = new Map<string, { refreshToken: string; clientId: string }>();
  const refreshes = new Map<string, string>();
  const codes = new Map<string, PendingCode>();
  const dead = new Set<string>();
  let origin = '';

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
    res.end(text);
  };

  const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

  const mint = (clientId: string): Record<string, unknown> => {
    const accessToken = `at_${randomUUID()}`;
    const refreshToken = `rt_${randomUUID()}`;
    issued.set(accessToken, { refreshToken, clientId });
    refreshes.set(refreshToken, accessToken);
    return { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: expiresIn, scope: 'mcp' };
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      hits.push(`${req.method} ${path}`);

      // --- El recurso protegido: 401 con WWW-Authenticate, la puerta de entrada del descubrimiento.
      if (path === resourcePath) {
        const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
        if (!auth || !issued.has(auth) || dead.has(auth)) {
          const metadata = `${origin}/.well-known/oauth-protected-resource${resourcePath}`;
          res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${metadata}"`, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        json(res, 200, { jsonrpc: '2.0', id: 1, result: { ok: true } });
        return;
      }

      // --- RFC 9728: metadata del recurso protegido, path-aware primero.
      if (path === `/.well-known/oauth-protected-resource${resourcePath}`
        || (!options.pathAwareOnly && path === '/.well-known/oauth-protected-resource')) {
        json(res, 200, {
          resource: `${origin}${resourcePath}`,
          authorization_servers: [origin],
          scopes_supported: ['mcp'],
          bearer_methods_supported: ['header'],
        });
        return;
      }

      // --- RFC 8414: metadata del authorization server, con inserción de path.
      if (path === `/.well-known/oauth-authorization-server${resourcePath}`
        || (!options.pathAwareOnly && path === '/.well-known/oauth-authorization-server')) {
        json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          ...(options.noRegistrationEndpoint ? {} : { registration_endpoint: `${origin}/register` }),
          ...(options.revocation ? { revocation_endpoint: `${origin}/revoke` } : {}),
          scopes_supported: ['mcp'],
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
        return;
      }

      // --- RFC 7591: registro dinámico de cliente.
      if (path === '/register' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { redirect_uris?: string[]; token_endpoint_auth_method?: string };
        if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
          json(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must contain at least one URI.' });
          return;
        }
        if (options.refuseRegistration) {
          // El cuerpo exacto que devolvió Meta, medido en la sección 3.
          json(res, 400, { error: 'invalid_client_metadata', error_description: 'Dynamic registration is not available for this client.' });
          return;
        }
        const clientId = `cli_${randomBytes(6).toString('hex')}`;
        registered.push({ clientId, redirectUris: body.redirect_uris, authMethod: body.token_endpoint_auth_method ?? '' });
        json(res, 201, { client_id: clientId, redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' });
        return;
      }

      // --- /authorize: valida PKCE y redirige al loopback con code + state.
      if (path === '/authorize') {
        const clientId = url.searchParams.get('client_id') ?? '';
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        const state = url.searchParams.get('state') ?? '';
        const challenge = url.searchParams.get('code_challenge') ?? '';
        const method = url.searchParams.get('code_challenge_method') ?? '';
        if (!clientId || !redirectUri || !challenge || method !== 'S256') {
          json(res, 400, { error: 'invalid_request', error_description: 'PKCE S256 es obligatorio.' });
          return;
        }
        const code = `code_${randomBytes(8).toString('hex')}`;
        codes.set(code, { challenge, method, redirectUri, clientId, resource: url.searchParams.get('resource') });
        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        if (state) target.searchParams.set('state', state);
        res.writeHead(302, { Location: target.toString() });
        res.end();
        return;
      }

      if (path === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        const grant = form.get('grant_type');
        if (grant === 'authorization_code') {
          const pending = codes.get(form.get('code') ?? '');
          if (!pending) { json(res, 400, { error: 'invalid_grant' }); return; }
          codes.delete(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          const computed = b64url(createHash('sha256').update(verifier).digest());
          if (computed !== pending.challenge) { json(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' }); return; }
          if (form.get('redirect_uri') !== pending.redirectUri) { json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' }); return; }
          json(res, 200, mint(pending.clientId));
          return;
        }
        if (grant === 'refresh_token') {
          const refreshToken = form.get('refresh_token') ?? '';
          const previous = refreshes.get(refreshToken);
          if (!previous || options.refuseRefresh) { json(res, 400, { error: 'invalid_grant' }); return; }
          const clientId = issued.get(previous)?.clientId ?? '';
          issued.delete(previous);
          dead.delete(previous);
          refreshes.delete(refreshToken);
          json(res, 200, mint(clientId));
          return;
        }
        json(res, 400, { error: 'unsupported_grant_type' });
        return;
      }

      if (path === '/revoke' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        const token = form.get('token') ?? '';
        issued.delete(token);
        refreshes.delete(token);
        res.writeHead(200); res.end();
        return;
      }

      json(res, 404, { error: 'not_found' });
    })().catch(() => { try { res.writeHead(500); res.end(); } catch { /* ya cerrado */ } });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    resourceUrl: `${origin}${resourcePath}`,
    hits,
    registered,
    issued,
    expire: (accessToken) => { dead.add(accessToken); },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
