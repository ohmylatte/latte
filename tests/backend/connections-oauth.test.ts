/**
 * El módulo OAuth contra el servidor de juguete (G2 del brief
 * `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`).
 *
 * Todo hermético, en `127.0.0.1`, con el AS y el recurso protegido de
 * `tests/fakes/toyOAuth.ts`. **Ningún login se hace con una cuenta real**: los
 * casos de Meta y theagentcy están modelados como opciones del juguete, tal
 * como se midieron en la sección 3 del documento.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  authorizeUrl,
  createPkce,
  createState,
  discoverAuthServer,
  isExpired,
  refreshTokens,
  registerClient,
  resolveClientId,
  revokeTokens,
  statesMatch,
  wellKnownCandidates,
} from '../../electron/connections/oauth';
import { runConnectionLogin, type LoginWindowOpener } from '../../electron/connections/login';
import { startLoopbackCallback } from '../../electron/connections/loopback';
import { startToyOAuth, type ToyOAuthServer } from '../fakes/toyOAuth';

const servers: ToyOAuthServer[] = [];
const toy = async (options: Parameters<typeof startToyOAuth>[0] = {}): Promise<ToyOAuthServer> => {
  const server = await startToyOAuth(options);
  servers.push(server);
  return server;
};

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

/**
 * La "ventana" de los tests: sigue el 302 del `/authorize` hasta el loopback,
 * que es exactamente lo que hace un navegador y nada más. No hay nadie
 * escribiendo una contraseña porque el juguete no pide ninguna.
 */
const followingWindow: LoginWindowOpener = async (url) => {
  void fetch(url, { redirect: 'follow' }).catch(() => { /* el loopback ya respondió */ });
  return { close: () => {} };
};

/** Una ventana que la persona cierra sin hacer nada. */
const closingWindow: LoginWindowOpener = async (_url, hooks) => {
  setTimeout(() => hooks.onClosed(), 0);
  return { close: () => {} };
};

describe('descubrimiento', () => {
  it('prueba la forma path-aware ANTES que la genérica', async () => {
    const server = await toy();
    await discoverAuthServer(server.resourceUrl);
    const wellKnowns = server.hits.filter((h) => h.includes('.well-known'));
    // El primero que se pide es el del recurso protegido CON el path.
    expect(wellKnowns[0]).toBe('GET /.well-known/oauth-protected-resource/api/mcp');
    expect(wellKnowns.some((h) => h === 'GET /.well-known/oauth-authorization-server/api/mcp')).toBe(true);
  });

  it('descubre un servidor que SÓLO responde path-aware (el caso Meta)', async () => {
    const server = await toy({ pathAwareOnly: true });
    const discovery = await discoverAuthServer(server.resourceUrl);
    expect(discovery.authorizationEndpoint).toBe(`${server.origin}/authorize`);
    expect(discovery.tokenEndpoint).toBe(`${server.origin}/token`);
    expect(discovery.resource).toBe(server.resourceUrl);
    expect(discovery.codeChallengeMethods).toContain('S256');
  });

  it('empieza por el 401 y su `WWW-Authenticate`', async () => {
    const server = await toy();
    await discoverAuthServer(server.resourceUrl);
    expect(server.hits[0]).toBe('POST /api/mcp');
  });

  it('una URL que no es un servidor MCP falla con un código propio', async () => {
    // `pathAwareOnly` es lo que hace honesto este caso: sin el genérico, una
    // ruta equivocada no tiene ningún well-known del que colgarse.
    const server = await toy({ pathAwareOnly: true });
    await expect(discoverAuthServer(`${server.origin}/no-existe`)).rejects.toMatchObject({ code: 'CONNECTION_DISCOVERY_FAILED' });
  });

  it('los candidatos no se repiten cuando la URL no tiene path', () => {
    expect(wellKnownCandidates('https://ejemplo.test', '/.well-known/oauth-authorization-server'))
      .toEqual(['https://ejemplo.test/.well-known/oauth-authorization-server']);
    expect(wellKnownCandidates('https://ejemplo.test/api/mcp', '/.well-known/oauth-authorization-server'))
      .toEqual([
        'https://ejemplo.test/.well-known/oauth-authorization-server/api/mcp',
        'https://ejemplo.test/.well-known/oauth-authorization-server',
      ]);
  });
});

describe('registro dinámico de cliente', () => {
  it('registra con `token_endpoint_auth_method: none` y PKCE', async () => {
    const server = await toy();
    const discovery = await discoverAuthServer(server.resourceUrl);
    const registered = await registerClient(discovery, 'http://127.0.0.1:1234/callback');
    expect(registered?.clientId).toMatch(/^cli_/);
    expect(server.registered[0]).toMatchObject({ authMethod: 'none', redirectUris: ['http://127.0.0.1:1234/callback'] });
  });

  it('un servidor que publica el endpoint y rechaza todo cae al `clientId` guardado', async () => {
    const server = await toy({ refuseRegistration: true });
    const discovery = await discoverAuthServer(server.resourceUrl);
    expect(await registerClient(discovery, 'http://127.0.0.1:1234/callback')).toBeNull();
    const resolved = await resolveClientId(discovery, 'http://127.0.0.1:1234/callback', 'app-de-gabriel');
    expect(resolved).toEqual({ clientId: 'app-de-gabriel', fromRegistration: false });
  });

  it('y si tampoco hay `clientId`, lo pide con un código propio', async () => {
    const server = await toy({ refuseRegistration: true });
    const discovery = await discoverAuthServer(server.resourceUrl);
    await expect(resolveClientId(discovery, 'http://127.0.0.1:1234/callback', null))
      .rejects.toMatchObject({ code: 'CONNECTION_CLIENT_ID_REQUIRED' });
  });

  it('sin `registration_endpoint` es el mismo camino', async () => {
    const server = await toy({ noRegistrationEndpoint: true });
    const discovery = await discoverAuthServer(server.resourceUrl);
    expect(discovery.registrationEndpoint).toBeNull();
    await expect(resolveClientId(discovery, 'http://127.0.0.1:1234/callback', null))
      .rejects.toMatchObject({ code: 'CONNECTION_CLIENT_ID_REQUIRED' });
  });

  it('un `clientId` guardado GANA: no se registra de nuevo', async () => {
    const server = await toy();
    const discovery = await discoverAuthServer(server.resourceUrl);
    await resolveClientId(discovery, 'http://127.0.0.1:1234/callback', 'ya-lo-tengo');
    expect(server.registered).toHaveLength(0);
  });
});

describe('PKCE y state', () => {
  it('el challenge es S256 del verifier, y la URL lo lleva', async () => {
    const server = await toy();
    const discovery = await discoverAuthServer(server.resourceUrl);
    const pkce = createPkce();
    const url = new URL(authorizeUrl({ discovery, clientId: 'c', redirectUri: 'http://127.0.0.1:1/callback', challenge: pkce.challenge, state: 's' }));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge);
    expect(url.searchParams.get('resource')).toBe(server.resourceUrl);
    expect(url.searchParams.get('response_type')).toBe('code');
    // El verifier no viaja NUNCA en el `/authorize`: ese es el punto de PKCE.
    expect(url.toString()).not.toContain(pkce.verifier);
  });

  it('dos verifiers seguidos son distintos', () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier);
    expect(createState()).not.toBe(createState());
  });

  it('`statesMatch` rechaza el vacío y el distinto', () => {
    expect(statesMatch('abc', 'abc')).toBe(true);
    expect(statesMatch('abc', 'abd')).toBe(false);
    expect(statesMatch('abc', 'abcd')).toBe(false);
    expect(statesMatch('', '')).toBe(false);
  });
});

describe('loopback', () => {
  it('con puerto efímero arma el redirect ya con el puerto resuelto', async () => {
    const loopback = await startLoopbackCallback();
    try {
      expect(loopback.redirectUri).toBe(`http://127.0.0.1:${loopback.port}/callback`);
      expect(loopback.port).toBeGreaterThan(0);
    } finally {
      loopback.close();
    }
  });

  it('recibe el código y contesta una página, y una ruta que no es /callback da 404', async () => {
    const loopback = await startLoopbackCallback();
    try {
      const wrong = await fetch(`http://127.0.0.1:${loopback.port}/otra`);
      expect(wrong.status).toBe(404);
      const response = await fetch(`${loopback.redirectUri}?code=abc&state=xyz`);
      expect(response.status).toBe(200);
      expect(await loopback.received).toMatchObject({ code: 'abc', state: 'xyz', error: null });
    } finally {
      loopback.close();
    }
  });

  it('un puerto ocupado NO se cambia por otro en silencio', async () => {
    const first = await startLoopbackCallback();
    try {
      await expect(startLoopbackCallback({ preferredPort: first.port })).rejects.toThrow();
    } finally {
      first.close();
    }
  });

  it('sólo el primer redirect cuenta', async () => {
    const loopback = await startLoopbackCallback();
    try {
      await fetch(`${loopback.redirectUri}?code=primero&state=s`);
      await fetch(`${loopback.redirectUri}?code=segundo&state=s`);
      expect((await loopback.received).code).toBe('primero');
    } finally {
      loopback.close();
    }
  });
});

describe('el login completo', () => {
  it('descubre, registra, abre la ventana y canjea el código', async () => {
    const server = await toy();
    const outcome = await runConnectionLogin({ resourceUrl: server.resourceUrl }, { openLoginWindow: followingWindow });
    expect(outcome.clientIdFromRegistration).toBe(true);
    expect(outcome.tokens.accessToken).toMatch(/^at_/);
    expect(outcome.tokens.refreshToken).toMatch(/^rt_/);
    expect(outcome.tokens.resource).toBe(server.resourceUrl);
    expect(outcome.tokens.clientId).toBe(server.registered[0].clientId);
    expect(outcome.tokens.expiresAt).toBeTruthy();
    // Y el token sirve de verdad contra el recurso protegido.
    const used = await fetch(server.resourceUrl, { method: 'POST', headers: { Authorization: `Bearer ${outcome.tokens.accessToken}` } });
    expect(used.status).toBe(200);
  });

  it('el redirect que vuelve con otro `state` no se usa', async () => {
    const server = await toy();
    // La "ventana" vuelve al loopback por su cuenta, con un state inventado.
    const forging: LoginWindowOpener = async (url) => {
      const redirectUri = new URL(url).searchParams.get('redirect_uri')!;
      void fetch(`${redirectUri}?code=robado&state=otro-state`).catch(() => {});
      return { close: () => {} };
    };
    await expect(runConnectionLogin({ resourceUrl: server.resourceUrl }, { openLoginWindow: forging }))
      .rejects.toMatchObject({ code: 'CONNECTION_STATE_MISMATCH' });
  });

  it('cerrar la ventana es una cancelación, no un error del proveedor', async () => {
    const server = await toy();
    await expect(runConnectionLogin({ resourceUrl: server.resourceUrl }, { openLoginWindow: closingWindow }))
      .rejects.toMatchObject({ code: 'CONNECTION_LOGIN_CANCELLED' });
  });

  it('una ventana que nunca vuelve se corta por tiempo y suelta el puerto', async () => {
    const server = await toy();
    let port = 0;
    const spy: LoginWindowOpener = async (url) => {
      port = Number(new URL(new URL(url).searchParams.get('redirect_uri')!).port);
      return { close: () => {} };
    };
    const immediate = (fn: () => void): { cancel: () => void } => { const h = setTimeout(fn, 1); return { cancel: () => clearTimeout(h) }; };
    await expect(runConnectionLogin({ resourceUrl: server.resourceUrl }, { openLoginWindow: spy, setTimer: immediate, timeoutMs: 1 }))
      .rejects.toMatchObject({ code: 'CONNECTION_LOGIN_TIMEOUT' });
    // El puerto quedó libre: se puede volver a atar.
    const again = await startLoopbackCallback({ preferredPort: port });
    again.close();
  });

  it('un puerto pre-registrado ocupado falla antes de abrir ninguna ventana', async () => {
    const server = await toy();
    const busy = await startLoopbackCallback();
    let opened = false;
    const watching: LoginWindowOpener = async () => { opened = true; return { close: () => {} }; };
    try {
      await expect(runConnectionLogin({ resourceUrl: server.resourceUrl, preferredPort: busy.port }, { openLoginWindow: watching }))
        .rejects.toThrow();
      expect(opened).toBe(false);
    } finally {
      busy.close();
    }
  });

  it('con un servidor sin DCR y sin `clientId`, ni siquiera abre la ventana', async () => {
    const server = await toy({ refuseRegistration: true });
    let opened = false;
    const watching: LoginWindowOpener = async () => { opened = true; return { close: () => {} }; };
    await expect(runConnectionLogin({ resourceUrl: server.resourceUrl }, { openLoginWindow: watching }))
      .rejects.toMatchObject({ code: 'CONNECTION_CLIENT_ID_REQUIRED' });
    expect(opened).toBe(false);
  });
});

describe('refresh y revocación', () => {
  it('renueva y el token nuevo sirve; el viejo ya no', async () => {
    const server = await toy();
    const { tokens } = await runConnectionLogin({ resourceUrl: server.resourceUrl }, { openLoginWindow: followingWindow });
    const renewed = await refreshTokens(tokens);
    expect(renewed.accessToken).not.toBe(tokens.accessToken);
    expect(renewed.clientId).toBe(tokens.clientId);
    expect((await fetch(server.resourceUrl, { method: 'POST', headers: { Authorization: `Bearer ${renewed.accessToken}` } })).status).toBe(200);
    expect((await fetch(server.resourceUrl, { method: 'POST', headers: { Authorization: `Bearer ${tokens.accessToken}` } })).status).toBe(401);
  });

  it('un servidor que no quiere renovar da un error legible, no un 500', async () => {
    const server = await toy({ refuseRefresh: true });
    const { tokens } = await runConnectionLogin({ resourceUrl: server.resourceUrl }, { openLoginWindow: followingWindow });
    await expect(refreshTokens(tokens)).rejects.toMatchObject({ code: 'CONNECTION_TOKEN_REFUSED' });
  });

  it('sin refresh token no se intenta siquiera', async () => {
    const server = await toy();
    const { tokens } = await runConnectionLogin({ resourceUrl: server.resourceUrl }, { openLoginWindow: followingWindow });
    const hitsBefore = server.hits.length;
    await expect(refreshTokens({ ...tokens, refreshToken: null })).rejects.toMatchObject({ code: 'CONNECTION_TOKEN_REFUSED' });
    expect(server.hits.length).toBe(hitsBefore);
  });

  it('revoca sólo si el servidor publica cómo', async () => {
    const withRevocation = await toy({ revocation: true });
    const a = await runConnectionLogin({ resourceUrl: withRevocation.resourceUrl }, { openLoginWindow: followingWindow });
    expect(a.tokens.revocationEndpoint).toBe(`${withRevocation.origin}/revoke`);
    expect(await revokeTokens(a.tokens)).toBe(true);
    expect((await fetch(withRevocation.resourceUrl, { method: 'POST', headers: { Authorization: `Bearer ${a.tokens.accessToken}` } })).status).toBe(401);

    const without = await toy();
    const b = await runConnectionLogin({ resourceUrl: without.resourceUrl }, { openLoginWindow: followingWindow });
    expect(b.tokens.revocationEndpoint).toBeNull();
    const hitsBefore = without.hits.length;
    expect(await revokeTokens(b.tokens)).toBe(false);
    expect(without.hits.length).toBe(hitsBefore);
  });

  it('`isExpired` usa el margen de cinco minutos', () => {
    const now = Date.parse('2026-09-23T10:00:00.000Z');
    const base = { accessToken: 'a', refreshToken: null, tokenType: 'Bearer', scope: null, clientId: null, issuer: null, tokenEndpoint: null, revocationEndpoint: null, resource: null };
    expect(isExpired({ ...base, expiresAt: '2026-09-23T10:10:00.000Z' }, now)).toBe(false);
    expect(isExpired({ ...base, expiresAt: '2026-09-23T10:04:00.000Z' }, now)).toBe(true);
    // Sin vencimiento declarado no se adivina ninguno: el 401 del gateway lo dirá.
    expect(isExpired({ ...base, expiresAt: null }, now)).toBe(false);
  });
});
