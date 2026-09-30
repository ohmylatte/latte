import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * E4: MARCA → IDENTIDAD. La pantalla donde la persona trae el logo y los
 * manuales, le pide al equipo `IDENTIDAD.md` y aprueba. Aprobar es de la
 * persona: es el único botón primario. Nunca muestra una ruta.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { IdentityView } = await import('./IdentityView');
import type { BrandIdentityView } from '../shared/contracts';

afterEach(() => cleanup());

const view = (patch: Partial<BrandIdentityView> = {}): BrandIdentityView => ({
  brandId: 'b1', state: 'draft', hasIdentityDoc: false, approved: null, changedSinceApproval: false, revokedAt: null,
  files: [
    { id: 'logo-ayulem', name: 'logo ayulem.png', kind: 'logo', usable: true, bytes: 20_480, identityDoc: false },
    { id: 'manual', name: 'Manual_Logo_AYULEM-V1.pdf', kind: 'reference', usable: true, bytes: 3 * 1024 * 1024, identityDoc: false },
  ],
  ...patch,
});
const mount = (identity: BrandIdentityView | null, handlers: Record<string, unknown> = {}) =>
  render(createElement(IdentityView, { brandName: 'Ayulem', identity, busy: false, ...handlers }));

describe('E4: Marca → Identidad', () => {
  it('vacía: dice que los entregables salen neutros y ofrece traer archivos; no se puede aprobar nada', () => {
    ui.locale = 'es-AR';
    const onApprove = vi.fn();
    const { container } = mount(view({ state: 'empty', files: [] }), { onApprove, onAddFiles: vi.fn() });
    expect(container.querySelector('.identity-state')!.textContent).toContain('estilo neutro');
    expect(screen.getByRole('button', { name: 'Agregar archivos' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Aprobar' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('borrador: cada archivo por su nombre, sin rutas; falta IDENTIDAD.md y lo dice; aprobar y extraer llaman a sus handlers', () => {
    ui.locale = 'es-AR';
    const onApprove = vi.fn();
    const onExtract = vi.fn();
    const onRemoveFile = vi.fn();
    const { container } = mount(view(), { onApprove, onExtract, onRemoveFile });
    const names = [...container.querySelectorAll('.identity-file .coord-row-name')].map((n) => n.textContent);
    expect(names).toEqual(['logo ayulem.png', 'Manual_Logo_AYULEM-V1.pdf']);
    expect(container.textContent).not.toMatch(/assets[\\/]|brand-kits|[A-Z]:\\/);
    expect(container.querySelector('.identity-hint')!.textContent).toContain('IDENTIDAD.md');
    // Un solo botón primario: aprobar.
    expect(container.querySelectorAll('button.primary')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar' }));
    expect(onApprove).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Extraer identidad con el equipo' }));
    expect(onExtract).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sacar logo ayulem.png' }));
    expect(onRemoveFile).toHaveBeenCalledWith('logo-ayulem');
  });

  it('aprobada: dice la versión, ofrece revocar, y aprobar sólo vuelve si el borrador cambió', () => {
    ui.locale = 'es-AR';
    const approved = view({ state: 'approved', hasIdentityDoc: true, approved: { version: 2, approvedAt: '2026-09-25T12:00:00.000Z', fileCount: 3 } });
    const first = mount(approved, { onApprove: vi.fn(), onRevoke: vi.fn() });
    expect(first.container.querySelector('.identity-state')!.textContent).toContain('versión 2');
    expect((screen.getByRole('button', { name: 'Aprobar' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Revocar' })).toBeTruthy();
    cleanup();
    mount({ ...approved, changedSinceApproval: true }, { onApprove: vi.fn() });
    expect((screen.getByRole('button', { name: 'Aprobar' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('en inglés', () => {
    ui.locale = 'en-US';
    mount(view(), { onApprove: vi.fn(), onExtract: vi.fn(), onAddFiles: vi.fn() });
    expect(screen.getByRole('heading').textContent).toBe('Ayulem identity');
    expect(screen.getByRole('button', { name: 'Extract identity with the team' })).toBeTruthy();
  });

  it('sin handlers no ofrece botones que no hacen nada', () => {
    ui.locale = 'es-AR';
    const { container } = mount(view());
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});
