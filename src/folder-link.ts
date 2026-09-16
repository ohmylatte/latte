/**
 * The one confirmation before Latte points a work at a folder the person
 * already uses. Two callers show it: the workspace's "Vincular carpeta" action
 * and the first-run gate's start CTA. It lives here so the two can never drift
 * into promising different things.
 */
export const FOLDER_LINK_WARNING = [
  'Latte va a trabajar directamente en la carpeta que elijas. No copia nada.',
  '',
  'Dentro de esa carpeta va a crear o actualizar:',
  '  CLAUDE.md y AGENTS.md (contexto para los agentes)',
  '  README.md y .latte/ (versiones)',
  '',
  'Los agentes que abras van a tener esa carpeta como espacio de trabajo.',
  '',
  '¿Elegimos la carpeta?',
].join('\n');

/**
 * True when the human accepted linking a folder. A declined confirmation means
 * no folder was picked and nothing was written: the caller keeps the work.
 */
export function confirmFolderLink(): boolean {
  return window.confirm(FOLDER_LINK_WARNING);
}
