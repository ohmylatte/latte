import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOLDER_LINK_WARNING, confirmFolderLink } from './folder-link';

/**
 * The folder link is the one place the app points an agent at a folder the
 * human already uses. The DOM gate test cannot reach this path in jsdom
 * (`isDesktop` is false and the picker is a native dialog), so the decision
 * itself — ask first, and a "no" is never a link — is pinned here.
 */
describe('folder-link confirmation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks the human with the exact consequences before linking', () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('window', { confirm });

    expect(confirmFolderLink()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(FOLDER_LINK_WARNING);
  });

  it('a declined confirmation is not a link: it returns false', () => {
    vi.stubGlobal('window', { confirm: vi.fn(() => false) });
    expect(confirmFolderLink()).toBe(false);
  });

  it('names every artifact the link writes, so the confirmation is informed', () => {
    for (const artifact of ['CLAUDE.md', 'AGENTS.md', 'README.md', '.latte/']) {
      expect(FOLDER_LINK_WARNING).toContain(artifact);
    }
    expect(FOLDER_LINK_WARNING).toContain('No copia nada');
    expect(FOLDER_LINK_WARNING).toContain('¿Elegimos la carpeta?');
  });
});
