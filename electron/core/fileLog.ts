import fs from 'node:fs';
import path from 'node:path';

/**
 * El tope antes de rotar. Dos megas es lo que entra en un rato largo de uso y
 * lo que alguien puede abrir en un editor sin pensarlo.
 */
export const FILE_LOG_MAX_BYTES = 2 * 1024 * 1024;

export interface FileLogOptions {
  maxBytes?: number;
  appendFileSyncImpl?: typeof fs.appendFileSync;
  statSyncImpl?: typeof fs.statSync;
  renameSyncImpl?: typeof fs.renameSync;
  mkdirSyncImpl?: typeof fs.mkdirSync;
  now?: () => Date;
}

/**
 * Un sink de archivo para las lineas de log del backend.
 *
 * La consola del proceso principal NO existe en la app empaquetada: un
 * `console.log` ahi no lo lee nadie nunca. Cuando un miembro falla un turno,
 * lo unico que queda para diagnosticar es lo que se escribio en disco.
 *
 * Rotacion de una sola generacion: al pasar el tope, el archivo pasa a `.1` y
 * se empieza de nuevo. Sin dependencias y sin timers.
 *
 * Todo va adentro de un `try/catch`: un log que tira no puede tirar la app. Un
 * disco lleno, un permiso denegado o una carpeta que alguien borro a mano
 * hacen que se pierda la linea, nunca que se caiga el proceso.
 */
export function createFileLog(file: string, options: FileLogOptions = {}): (line: string) => void {
  const maxBytes = options.maxBytes ?? FILE_LOG_MAX_BYTES;
  const appendFileSync = options.appendFileSyncImpl ?? fs.appendFileSync;
  const statSync = options.statSyncImpl ?? fs.statSync;
  const renameSync = options.renameSyncImpl ?? fs.renameSync;
  const mkdirSync = options.mkdirSyncImpl ?? fs.mkdirSync;
  const now = options.now ?? (() => new Date());
  let directoryReady = false;

  const rotate = (): void => {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      return; // Todavia no existe: nada que rotar.
    }
    if (size < maxBytes) return;
    renameSync(file, `${file}.1`);
  };

  return (line: string): void => {
    try {
      if (!directoryReady) {
        mkdirSync(path.dirname(file), { recursive: true });
        directoryReady = true;
      }
      rotate();
      appendFileSync(file, `${now().toISOString()} ${line.trimEnd()}\n`, 'utf8');
    } catch {
      // A proposito: ver el docstring.
    }
  };
}
