import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { RunOutput } from './coordination/TeamOutcome';
import { MemberDetail } from './coordination/MemberDetail';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationLogEntryView, CoordinationRunView, TeamMember } from '../shared/contracts';

/**
 * UN MIEMBRO QUE YA NO ESTÁ NO TIENE INICIALES.
 *
 * `memberDisplayName` termina la cadena en "miembro que ya no está", que es un
 * hecho y no un relleno. Pero el avatar tomaba ESA FRASE como si fuera un
 * nombre y sacaba sus iniciales: un círculo con "MQ" adentro, que parece una
 * persona con nombre y no lo es. Dos superficies lo mostraban así — lo que
 * produjo el equipo, y el encabezado del hilo de alguien que se borró.
 *
 * Quien no existe se dibuja con un avatar neutro: sin iniciales, con el ícono
 * de una persona tachada, y el nombre accesible sigue siendo la frase.
 */

const member = (id: string, roleName: string, roleId = id): TeamMember => ({
  id, workId: 'w1', roleId, roleName, initial: roleName[0]!, avatar: null, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [member('cm', 'Community Manager', 'community-manager')];

const run: CoordinationRunView = {
  id: 'run1', workId: 'w1', status: 'done', coordinatorMemberId: 'cm',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: false, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 1, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0,
};

const report = (id: string, memberId: string): CoordinationLogEntryView => ({
  id, taskId: 't-' + id, memberId, status: 'reported', outcome: 'succeeded',
  promptPreview: 'Escribir los posts', summaryPreview: 'Quedaron los tres posts',
  createdAt: '2026-09-01T10:00:00.000Z', startedAt: '2026-09-01T10:00:00.000Z', settledAt: '2026-09-01T12:00:00.000Z',
});

const GONE = 'miembro que ya no está';
const avatarIn = (el: Element | null) => el!.querySelector('.coord-av') as HTMLElement;

describe('el avatar de quien ya no está en el equipo', () => {
  it('en "Lo que produjo el equipo" no lleva iniciales, lleva el ícono neutro', () => {
    const { container } = render(<RunOutput run={run} team={team} log={[report('d1', 'mem_borrado'), report('d2', 'cm')]} formatTime={(v) => v} />);
    const rows = [...container.querySelectorAll('.coord-output-row')];
    expect(rows).toHaveLength(2);
    const gone = avatarIn(rows[0]!);
    expect(gone.getAttribute('aria-label')).toBe(GONE);
    expect(gone.querySelector('.av-initial')).toBeNull();
    expect(gone.textContent).toBe('');
    expect(gone.querySelector('svg')).not.toBeNull();
    // Y quien SÍ está sigue teniendo su cara: esto no apaga a nadie más.
    const alive = avatarIn(rows[1]!);
    expect(alive.getAttribute('aria-label')).toBe('Community Manager');
    expect(alive.getAttribute('data-avatar')).not.toBe('gone');
  });

  it('en el encabezado del hilo tampoco', () => {
    const { container } = render(<MemberDetail memberId="mem_borrado" team={team} events={[]}
      signal={{ dot: 'idle', line: 'Sin novedades', at: null, asks: 0, urgent: false }} />);
    const avatar = container.querySelector('.coord-detail-head .coord-av') as HTMLElement;
    expect(avatar.getAttribute('aria-label')).toBe(GONE);
    expect(avatar.querySelector('.av-initial')).toBeNull();
    expect(avatar.textContent).toBe('');
    expect(avatar.getAttribute('data-avatar')).toBe('gone');
  });
});
