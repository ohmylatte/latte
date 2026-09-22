/**
 * El cliente OAuth de Latte, genérico: descubrimiento, registro dinámico,
 * PKCE, canje, refresh y revocación. **Nada de theagentcy ni de Meta
 * hardcodeado** (brief `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`,
 * 4.3): lo único que este módulo sabe es la URL del servidor MCP.
 *
 * Sin Electron y sin `node:http`: todo entra por `fetch`, así que las reglas se
 * prueban contra el servidor de juguete de `tests/fakes/toyOAuth.ts` sin
 * levantar una ventana ni un proceso.
 *
 * El descubrimiento es **path-aware primero y genérico después**, en los dos
 * escalones, porque así se midió contra los servidores reales (sección 3): los
 * well-known de Meta sólo responden en forma path-aware y el genérico da 404,
 * de modo que un cliente que probara sólo la forma genérica no descubre nada.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ClientIdRequiredError, DiscoveryFailedError, TokenExchangeError } from './errors';
import type { ConnectionTokens } from '../storage/connectionsRepository';

// --- El puerto HTTP, tan chico como haga falta -------------------------------

export interface HttpResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: 'follow' | 'manual' | 'error';
}

export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponseLike>;

/** El `fetch` del proceso principal. Se resuelve tarde para que un test lo pueda reemplazar sin tocar el global. */
export const defaultFetch: FetchLike = (url, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(url, init);

// --- Descubrimiento ----------------------------------------------------------

export interface DiscoveredAuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Null cuando el servidor no publica registro dinámico: hay que traer un `clientId`. */
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  scopesSupported: string[];
  codeChallengeMethods: string[];
  /** El recurso RFC 8707 por el que se piden los tokens: la URL del servidor MCP, normalizada por su propia metadata. */
  resource: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

async function readJson(fetchFn: FetchLike, url: string): Promise<Record<string, unknown> | null> {
  let response: HttpResponseLike;
  try {
    response = await fetchFn(url, { method: 'GET', headers: { Accept: 'application/json' } });
  } catch {
    // Un DNS que no resuelve o un socket que se cae no es distinto de un 404
    // para quien está probando candidatos: se pasa al siguiente.
    return null;
  }
  if (response.status !== 200) return null;
  try {
    const parsed: unknown = JSON.parse(await response.text());
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * `resource_metadata="..."` del `WWW-Authenticate`, que es el camino corto y
 * el único que no adivina nada. Tolera comillas y parámetros en cualquier
 * orden, porque la cabecera la escribe el servidor y cada uno la escribe
 * distinto.
 */
export function resourceMetadataFrom(header: string | null): string | null {
  if (!header) return null;
  const match = /resource_metadata\s*=\s*(?:"([^"]+)"|([^\s,]+))/i.exec(header);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/**
 * Las dos formas de un well-known, en el orden que importa: **primero con el
 * path insertado** (RFC 8414 §3.1, y lo único que responde Meta), después la
 * genérica. Duplicados fuera: cuando la URL no tiene path, las dos son la misma.
 */
export function wellKnownCandidates(base: string, suffix: string, extraPath = ''): string[] {
  const url = new URL(base);
  const ownPath = url.pathname.replace(/\/+$/, '');
  const candidates = [
    ownPath ? `${url.origin}${suffix}${ownPath}` : '',
    extraPath ? `${url.origin}${suffix}${extraPath.replace(/\/+$/, '')}` : '',
    `${url.origin}${suffix}`,
  ].filter((c) => c.length > 0);
  return [...new Set(candidates)];
}

/**
 * De la URL de un servidor MCP a todo lo que hace falta para loguearse.
 *
 * Paso 1: un `initialize` sin credenciales, que es lo que un cliente MCP hace
 * igual, para leer el `WWW-Authenticate`. Paso 2: la metadata del recurso
 * protegido (RFC 9728), que nombra a su authorization server. Paso 3: la
 * metadata del AS (RFC 8414). Si el paso 1 o el 2 no dan nada, se sigue con el
 * origen del propio recurso como issuer: un servidor puede ser las dos cosas.
 */
export async function discoverAuthServer(resourceUrl: string, fetchFn: FetchLike = defaultFetch): Promise<DiscoveredAuthServer> {
  const resourcePath = new URL(resourceUrl).pathname.replace(/\/+$/, '');
  let headerMetadata: string | null = null;
  try {
    const probe = await fetchFn(resourceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Latte', version: '1' } } }),
    });
    headerMetadata = resourceMetadataFrom(probe.headers.get('www-authenticate'));
  } catch {
    // El sondeo es una comodidad, no un requisito: si el servidor no contesta
    // acá, los well-known todavía pueden responder.
  }

  const prmCandidates = [
    ...(headerMetadata ? [headerMetadata] : []),
    ...wellKnownCandidates(resourceUrl, '/.well-known/oauth-protected-resource'),
  ];
  let issuer: string | null = null;
  let resource = resourceUrl;
  for (const candidate of [...new Set(prmCandidates)]) {
    const prm = await readJson(fetchFn, candidate);
    if (!prm) continue;
    issuer = asStrings(prm.authorization_servers)[0] ?? null;
    resource = asString(prm.resource) ?? resourceUrl;
    if (issuer) break;
  }
  // Sin metadata de recurso, el propio servidor es el candidato a issuer: es lo
  // que hace un MCP que implementa las dos mitades en el mismo origen.
  issuer = issuer ?? new URL(resourceUrl).origin;

  const asCandidates = wellKnownCandidates(issuer, '/.well-known/oauth-authorization-server', resourcePath)
    .concat(wellKnownCandidates(issuer, '/.well-known/openid-configuration', resourcePath));
  for (const candidate of asCandidates) {
    const metadata = await readJson(fetchFn, candidate);
    if (!metadata) continue;
    const authorizationEndpoint = asString(metadata.authorization_endpoint);
    const tokenEndpoint = asString(metadata.token_endpoint);
    if (!authorizationEndpoint || !tokenEndpoint) continue;
    return {
      issuer: asString(metadata.issuer) ?? issuer,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint: asString(metadata.registration_endpoint),
      revocationEndpoint: asString(metadata.revocation_endpoint),
      scopesSupported: asStrings(metadata.scopes_supported),
      codeChallengeMethods: asStrings(metadata.code_challenge_methods_supported),
      resource,
    };
  }
  throw new DiscoveryFailedError(`No se pudo averiguar cómo se entra a ${resourceUrl}: el servidor no publicó metadata de OAuth, ni con el path ni sin él.`);
}

// --- Registro dinámico (RFC 7591) -------------------------------------------

export interface RegistrationResult {
  clientId: string;
  clientSecret: string | null;
}

/**
 * `token_endpoint_auth_method: 'none'` siempre: Latte es un cliente **público**
 * (corre en la máquina de la persona, no hay dónde esconder un secreto) y PKCE
 * es lo que sostiene el flujo. Los tres servidores medidos publican `none`
 * entre sus métodos.
 *
 * Devuelve `null` cuando el servidor rechaza el registro — que es un caso
 * ESPERADO, no un fallo: Meta publica el endpoint y lo rechaza todo. Quien
 * llama cae al `clientId` de la conexión.
 */
export async function registerClient(
  discovery: DiscoveredAuthServer,
  redirectUri: string,
  fetchFn: FetchLike = defaultFetch,
  clientName = 'Latte',
): Promise<RegistrationResult | null> {
  if (!discovery.registrationEndpoint) return null;
  let response: HttpResponseLike;
  try {
    response = await fetchFn(discovery.registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(discovery.scopesSupported.length > 0 ? { scope: discovery.scopesSupported.join(' ') } : {}),
      }),
    });
  } catch {
    return null;
  }
  if (response.status !== 200 && response.status !== 201) return null;
  try {
    const parsed: unknown = JSON.parse(await response.text());
    if (!isRecord(parsed)) return null;
    const clientId = asString(parsed.client_id);
    return clientId ? { clientId, clientSecret: asString(parsed.client_secret) } : null;
  } catch {
    return null;
  }
}

/** El `client_id` con el que se va a pedir el código: el registrado recién, o el que ya traía la conexión. */
export async function resolveClientId(
  discovery: DiscoveredAuthServer,
  redirectUri: string,
  existingClientId: string | null,
  fetchFn: FetchLike = defaultFetch,
  clientName = 'Latte',
): Promise<{ clientId: string; fromRegistration: boolean }> {
  // Un `clientId` guardado GANA sobre el registro: es la app propia de la
  // persona, y volver a registrar cada vez crearía un cliente nuevo por login.
  if (existingClientId) return { clientId: existingClientId, fromRegistration: false };
  const registered = await registerClient(discovery, redirectUri, fetchFn, clientName);
  if (registered) return { clientId: registered.clientId, fromRegistration: true };
  throw new ClientIdRequiredError(`${new URL(discovery.issuer).host} no registra clientes por su cuenta: hace falta el id de cliente de una app propia para conectarlo.`);
}

// --- PKCE --------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
}

const base64url = (buffer: Buffer): string => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** S256 SIEMPRE. `plain` no se implementa: un servidor que sólo acepte `plain` no se conecta, y eso es correcto. */
export function createPkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function createState(): string {
  return base64url(randomBytes(24));
}

/** Comparación en tiempo constante del `state`: lo que vuelve del navegador llega de afuera. */
export function statesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function authorizeUrl(input: {
  discovery: DiscoveredAuthServer;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const url = new URL(input.discovery.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // RFC 8707: por QUÉ recurso se pide el token. Sin esto, un AS que sirve a
  // varios recursos emite un token que el servidor MCP rechaza.
  url.searchParams.set('resource', input.discovery.resource);
  if (input.discovery.scopesSupported.length > 0) url.searchParams.set('scope', input.discovery.scopesSupported.join(' '));
  return url.toString();
}

// --- Canje, refresh y revocación --------------------------------------------

async function postForm(fetchFn: FetchLike, endpoint: string, form: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  });
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (response.status !== 200 || !isRecord(parsed)) {
    const detail = isRecord(parsed) ? (asString(parsed.error_description) ?? asString(parsed.error) ?? '') : '';
    throw new TokenExchangeError(`El servidor rechazó el pedido de credenciales (${response.status})${detail ? `: ${detail}` : ''}.`);
  }
  return parsed;
}

function tokensFrom(
  payload: Record<string, unknown>,
  discovery: Pick<DiscoveredAuthServer, 'issuer' | 'tokenEndpoint' | 'revocationEndpoint' | 'resource'>,
  clientId: string,
  now: number,
  previousRefresh: string | null,
): ConnectionTokens {
  const accessToken = asString(payload.access_token);
  if (!accessToken) throw new TokenExchangeError('El servidor respondió sin `access_token`.');
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : Number(payload.expires_in);
  return {
    accessToken,
    // Un refresh que no vuelve NO borra el que había: varios AS omiten
    // `refresh_token` en la respuesta de refresh porque el viejo sigue valiendo.
    refreshToken: asString(payload.refresh_token) ?? previousRefresh,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(now + expiresIn * 1000).toISOString() : null,
    tokenType: asString(payload.token_type) ?? 'Bearer',
    scope: asString(payload.scope),
    clientId,
    issuer: discovery.issuer,
    tokenEndpoint: discovery.tokenEndpoint,
    revocationEndpoint: discovery.revocationEndpoint,
    resource: discovery.resource,
  };
}

export async function exchangeCode(input: {
  discovery: DiscoveredAuthServer;
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  fetchFn?: FetchLike;
  now?: () => number;
}): Promise<ConnectionTokens> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier,
    resource: input.discovery.resource,
  });
  const payload = await postForm(input.fetchFn ?? defaultFetch, input.discovery.tokenEndpoint, form);
  return tokensFrom(payload, input.discovery, input.clientId, (input.now ?? Date.now)(), null);
}

/** Margen del brief: se considera vencido cinco minutos antes, para no salir a usar un token que muere en vuelo. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function isExpired(tokens: ConnectionTokens, now = Date.now(), marginMs = REFRESH_MARGIN_MS): boolean {
  if (!tokens.expiresAt) return false;
  const at = Date.parse(tokens.expiresAt);
  return Number.isFinite(at) && at - marginMs <= now;
}

export async function refreshTokens(
  tokens: ConnectionTokens,
  fetchFn: FetchLike = defaultFetch,
  now: () => number = Date.now,
): Promise<ConnectionTokens> {
  if (!tokens.refreshToken) throw new TokenExchangeError('Esta conexión no tiene con qué renovarse: hay que volver a entrar.');
  if (!tokens.tokenEndpoint) throw new TokenExchangeError('Esta conexión no recuerda a dónde pedir credenciales nuevas: hay que volver a entrar.');
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    ...(tokens.clientId ? { client_id: tokens.clientId } : {}),
    ...(tokens.resource ? { resource: tokens.resource } : {}),
  });
  const payload = await postForm(fetchFn, tokens.tokenEndpoint, form);
  return tokensFrom(
    payload,
    { issuer: tokens.issuer ?? '', tokenEndpoint: tokens.tokenEndpoint, revocationEndpoint: tokens.revocationEndpoint, resource: tokens.resource ?? '' },
    tokens.clientId ?? '',
    now(),
    tokens.refreshToken,
  );
}

/**
 * Revocación al desconectar, **sólo si el servidor la publica** (RFC 7009).
 * Nunca falla hacia afuera: que el proveedor no quiera revocar no puede
 * impedir que Latte borre lo suyo, que es lo que la persona pidió.
 */
export async function revokeTokens(tokens: ConnectionTokens, fetchFn: FetchLike = defaultFetch): Promise<boolean> {
  if (!tokens.revocationEndpoint) return false;
  const attempts = [
    tokens.refreshToken ? { token: tokens.refreshToken, token_type_hint: 'refresh_token' } : null,
    { token: tokens.accessToken, token_type_hint: 'access_token' },
  ].filter((a): a is { token: string; token_type_hint: string } => a != null);
  let any = false;
  for (const attempt of attempts) {
    try {
      const form = new URLSearchParams({ ...attempt, ...(tokens.clientId ? { client_id: tokens.clientId } : {}) });
      const response = await fetchFn(tokens.revocationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      if (response.status >= 200 && response.status < 300) any = true;
    } catch {
      // Ídem: no hay nada que hacer y no es asunto de la persona.
    }
  }
  return any;
}
