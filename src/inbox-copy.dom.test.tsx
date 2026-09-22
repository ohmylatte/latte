import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { describeInboxEvent } = await import('./coordination/inbox');
import type { InboxEvent } from './coordination/inbox';
import { EMPTY_USAGE, type TeamMember } from '../shared/contracts';

const setLocale = (locale: 'es-AR' | 'en-US') => { ui.locale = locale; };

/**
 * B3.4: NINGÚN RENGLÓN DEL BUZÓN TERMINA EN DOS PUNTOS VACÍOS.
 *
 * La captura del dueño mostraba, literal, "reportó:" y después nada. El motor
 * puede cerrar un despacho sin `summaryPreview` —un adaptador que no devuelve
 * resumen, una fila vieja—, y el formato `'reportó: {text}'` con `{text}`
 * vacío produce una promesa rota: dos puntos que anuncian algo que no llega.
 *
 * Un hecho sin texto es un hecho igual: "reportó" lo dice entero. Los dos
 * puntos son del texto, no del verbo, así que se van con él.
 */

const member = (id: string, roleName: string, roleId = id): TeamMember => ({
  id, workId: 'w1', roleId, roleName, initial: roleName[0]!, avatar: null, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [member('cm', 'CM'), member('paid', 'Paid Media')];

const event = (kind: InboxEvent['kind'], text: string, extra: Partial<InboxEvent> = {}): InboxEvent =>
  ({ id: 'e1', memberId: 'cm', kind, at: '2026-09-01T10:00:00.000Z', text, ...extra });

const KINDS: InboxEvent['kind'][] = ['dispatched', 'reported', 'dispatchFailed', 'sent', 'received', 'ask', 'answer', 'hired'];

describe('B3.4: el buzón no promete un texto que no tiene', () => {
  for (const locale of ['es-AR', 'en-US'] as const) {
    describe(locale, () => {
      it('ningún hecho SIN texto termina en dos puntos, en ningún tipo', () => {
        setLocale(locale);
        for (const kind of KINDS) {
          const line = describeInboxEvent(event(kind, '', { otherMemberId: 'paid', otherRoleId: 'paid' }), team, []);
          expect(line.trim(), kind).not.toBe('');
          expect(line.trim().endsWith(':'), `${kind} termina en dos puntos vacíos: ${line}`).toBe(false);
          // Ni dos puntos seguidos de nada en el medio de la frase.
          expect(/:\s*$/.test(line), `${kind}: ${line}`).toBe(false);
        }
        setLocale('es-AR');
      });

      it('con texto, el texto SÍ aparece detrás de los dos puntos', () => {
        setLocale(locale);
        for (const kind of KINDS) {
          if (kind === 'hired') continue; // un alta no trae texto nunca
          const line = describeInboxEvent(event(kind, 'quedaron los 3 posts', { otherMemberId: 'paid', otherRoleId: 'paid' }), team, []);
          expect(line, kind).toContain('quedaron los 3 posts');
        }
        setLocale('es-AR');
      });
    });
  }

  it('"reportó" sin resumen se lee entero, sin dos puntos — el renglón de la captura', () => {
    setLocale('es-AR');
    expect(describeInboxEvent(event('reported', ''), team, [])).toBe('reportó');
    expect(describeInboxEvent(event('reported', 'listo'), team, [])).toBe('reportó: listo');
  });

  it('"despachó" sin prompt, lo mismo', () => {
    setLocale('es-AR');
    expect(describeInboxEvent(event('dispatched', ''), team, [])).toBe('despachó');
  });

  it('un mensaje sin cuerpo sigue nombrando al otro extremo', () => {
    setLocale('es-AR');
    const line = describeInboxEvent(event('sent', '', { otherMemberId: 'paid', otherRoleId: 'paid' }), team, []);
    expect(line).toContain('Paid Media');
    expect(line.endsWith(':')).toBe(false);
  });

  it('un alta no cambió: nunca tuvo texto ni dos puntos', () => {
    setLocale('es-AR');
    expect(describeInboxEvent(event('hired', ''), team, [])).toBe('se sumó al equipo');
  });
});
