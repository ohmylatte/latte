/**
 * Conexiones MCP (esquema 13). Aditivo: ninguna tabla existente se altera.
 * Registrado desde `schema.ts` igual que generation/branding/learning/coordination.
 *
 * Brief `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`, 4.3.
 *
 * **Dos tablas, no una.** `connection_tokens` está separada a propósito: un
 * export o un backup que copie tablas puede EXCLUIR una tabla entera, que es
 * una decisión que se toma una vez y se ve en el código; filtrar una columna
 * de una tabla que por lo demás sí se exporta es una decisión que se olvida.
 * Nada más vive ahí adentro que el blob cifrado y cuándo se escribió.
 *
 * **El alcance es una columna, no una deducción** (decisión A del brief). Una
 * conexión global tiene `brand_id NULL`; una de marca lo tiene obligatorio, y
 * el `CHECK` lo hace cumplir la base, no la aplicación. El índice único usa
 * `IFNULL(brand_id, '')` porque en SQLite dos NULL nunca chocan en un índice
 * único: sin esa envoltura, dos conexiones globales con el mismo nombre
 * convivirían y la resolución marca→global tendría dos candidatas para el
 * mismo servidor.
 */
export const CONNECTIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connections (
  id              TEXT PRIMARY KEY,
  -- Slug estable: es lo que namespacea el servidor MCP inyectado en cada miembro.
  name            TEXT NOT NULL,
  label           TEXT NOT NULL DEFAULT '',
  url             TEXT NOT NULL,
  transport       TEXT NOT NULL DEFAULT 'http' CHECK (transport IN ('http')),
  auth_kind       TEXT NOT NULL DEFAULT 'oauth' CHECK (auth_kind IN ('oauth','header','none')),
  -- Presente sólo para los servidores que no hacen registro dinámico; cuando existe se saltea el DCR.
  client_id       TEXT,
  -- Lo que el servidor dice de la cuenta (mail, cuenta publicitaria). Nunca un secreto.
  identity        TEXT,
  scope           TEXT NOT NULL CHECK (scope IN ('global','brand')),
  brand_id        TEXT REFERENCES brands(id) ON DELETE CASCADE,
  state           TEXT NOT NULL DEFAULT 'disconnected' CHECK (state IN ('connected','expired','error','disconnected')),
  state_detail    TEXT NOT NULL DEFAULT '',
  member_override TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK ((scope = 'brand' AND brand_id IS NOT NULL) OR (scope = 'global' AND brand_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_server ON connections(scope, IFNULL(brand_id, ''), name);
CREATE INDEX IF NOT EXISTS idx_connections_brand ON connections(brand_id, name);

CREATE TABLE IF NOT EXISTS connection_tokens (
  connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  -- safeStorage.encryptString(JSON) en base64. Jamás se lee desde la UI ni se loguea.
  blob          TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
`;

/** Tablas que un export o un backup lógico NO puede tocar: secretos del proveedor. */
export const CONNECTION_SECRET_TABLES = ['connection_tokens'] as const;
