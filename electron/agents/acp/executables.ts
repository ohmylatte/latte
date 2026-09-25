import fs from 'node:fs';
import path from 'node:path';

/**
 * El ejecutable de Hermes que Latte lanza: el `hermes.exe` del venv, nunca el
 * `hermes.cmd` que el instalador pone en el PATH. El `.cmd` es un wrapper que
 * necesita un shell (y Node 24 avisa DEP0190 al pasarle uno) y no aporta nada:
 * sólo reenvía a ese mismo `.exe` (brief 2026-09-25, sección 4).
 *
 * `%LOCALAPPDATA%\hermes\bin\hermes.cmd` → `%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe`.
 * Si el `.exe` no está donde el instalador lo deja, `null`: mejor "no está
 * instalado" que arrancar por un shell.
 */
export function resolveHermesExecutable(found: string, exists: (file: string) => boolean = fs.existsSync): string | null {
  const ext = path.win32.extname(found).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return found;
  const root = path.win32.dirname(path.win32.dirname(found));
  const candidate = path.win32.join(root, 'hermes-agent', 'venv', 'Scripts', 'hermes.exe');
  return exists(candidate) ? candidate : null;
}
