import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canChangePermission } from './permission-ux';

describe('work permission UX', () => {
  it('keeps all three modes reversible on desktop and blocks the web preview', () => {
    expect(canChangePermission('ask', 'auto', false, true)).toBe(true);
    expect(canChangePermission('auto', 'ask', false, true)).toBe(true);
    expect(canChangePermission('folder', 'auto', true, true)).toBe(false);
    expect(canChangePermission('ask', 'auto', false, false)).toBe(false);
  });

  it('places the permission control next to the conversation composer', () => {
    const pane = fs.readFileSync('src/ChatPane.tsx', 'utf8');
    // Las TRES anclas, verificadas antes de compararlas. Un `indexOf` que no
    // encuentra devuelve -1, y `posición > -1` es verdadero para cualquier
    // posición: si el aviso de mensajes nuevos desaparecía o se renombraba,
    // este test seguía verde sin haber comparado nada real.
    const unread = pane.indexOf('conversation-new-messages');
    const slot = pane.indexOf('{beforeComposer}');
    // El composer se extrajo a `ChatComposer` —es el MISMO que usa el modo
    // Equipo, y dos copias son dos comportamientos que se separan—, asi que el
    // ancla es donde se monta, no el `<form>` que ahora vive en el otro lado.
    const composer = pane.indexOf('<ChatComposer');
    expect(unread).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(-1);
    expect(composer).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(unread);
    expect(slot).toBeLessThan(composer);
  });

  it('uses a mutation-specific pending state instead of the global busy state', () => {
    const app = fs.readFileSync('src/App.tsx', 'utf8');
    expect(app).toContain('permissionBusy={permissionBusy}');
    expect(app).not.toContain('mode={props.permissions} busy={busy}');
  });

  it('keeps work permissions collapsed until the person explicitly opens them', () => {
    const panel = fs.readFileSync('src/TeamPanel.tsx', 'utf8');
    expect(panel).toContain("<details className={'folder-trust mode-' + mode}>");
    expect(panel).not.toContain("open={mode === 'auto'}");
  });

  // Antes este test exigía las DOS frases en castellano incrustadas en el
  // componente («Adjuntar archivos al trabajo» y «Están disponibles en la
  // carpeta de este trabajo»), y así clavaba el bug: copy fija en el JSX y un
  // envío automático al adjuntar. Ahora el copy vive en los diccionarios y el
  // adjunto deja el borrador escrito; lo que se verifica es eso.
  it('offers chat attachments with copy from the dictionaries and without sending on its own', () => {
    const pane = fs.readFileSync('src/ChatPane.tsx', 'utf8');
    // El composer vive en su propio archivo desde que el modo Equipo usa el
    // MISMO: lo que se vigila --copy de los diccionarios, adjuntar que no
    // manda-- se mudo con el, y sigue siendo uno solo para las dos pantallas.
    const composer = fs.readFileSync('src/ChatComposer.tsx', 'utf8');
    expect(pane).toContain('onAttachFiles?: () => Promise<string[]>');
    expect(composer).toContain("t('chat.attach.label')");
    expect(composer).toContain("t('chat.attach.note'");
    expect(composer).not.toContain('Adjuntar archivos al trabajo');
    // El unico `sendChat` es el del boton de enviar: adjuntar no manda. Y el
    // panel no tiene ninguno propio: si lo tuviera, seria un segundo composer.
    expect(composer.match(/api\.sendChat\(/g)).toHaveLength(1);
    expect(pane).not.toContain('api.sendChat(');
  });
});
