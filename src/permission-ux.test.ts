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
    expect(pane.indexOf('{beforeComposer}')).toBeGreaterThan(pane.indexOf('conversation-new-messages'));
    expect(pane.indexOf('{beforeComposer}')).toBeLessThan(pane.indexOf('<form className="prompt-form"'));
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

  it('offers chat attachments and tells the agent which imported files to use', () => {
    const pane = fs.readFileSync('src/ChatPane.tsx', 'utf8');
    expect(pane).toContain('onAttachFiles?: () => Promise<string[]>');
    expect(pane).toContain('Adjuntar archivos al trabajo');
    expect(pane).toContain('Están disponibles en la carpeta de este trabajo');
  });
});
