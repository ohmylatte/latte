import { describe, expect, it } from 'vitest';
import { nowLine, type NowLineInput } from './now-line';
import type { CoordinationAskView, CoordinationRunTaskView, CoordinationRunView } from '../../shared/contracts';

/**
 * O1: LA LÍNEA "AHORA".
 *
 * Lo que vio el dueño: "2 de 3 listas · 0 en curso · 2/3 despachos", la
 * tercera tarea sin empezar, y ninguna frase que dijera qué pasa ahora ni qué
 * se espera de él. "Literal no sé si terminaron, si tengo que hacer algo."
 *
 * La línea sale de UNA función pura, con un orden que ES la regla: lo que te
 * espera gana sobre el coordinador en pausa, que gana sobre lo que falta, que
 * gana sobre quién trabaja, que gana sobre "nada te espera". Un run terminado
 * no tiene línea: su subtítulo ya dice "Terminamos · 3 de 3".
 */

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 3, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true, suspendReason: null, request: null, active: true,
  createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:00:00.000Z', lastEventAt: '2026-09-24T10:00:00.000Z',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
});

const task = (id: string, status: CoordinationRunTaskView['status'], patch: Partial<CoordinationRunTaskView> = {}): CoordinationRunTaskView => ({
  id, roleId: 'paid', spec: `Tarea ${id}`, status, inPlan: true, dependsOn: [], attempts: 0, assignedMemberId: null, ...patch,
});

const ask = (id: string, memberId: string, patch: Partial<CoordinationAskView> = {}): CoordinationAskView => ({
  id, runId: 'run1', taskId: null, memberId, question: '¿Cuál?', answer: null,
  deadlineAt: '2026-09-24T12:00:00.000Z', answeredAt: null, createdAt: '2026-09-24T10:30:00.000Z', ...patch,
});

const input = (patch: Partial<NowLineInput> = {}): NowLineInput => ({
  run: run(), tasks: [], asks: [], coordinatorPaused: false, coordinatorWaiting: 0, coordinatorUnread: 0, ...patch,
});

describe('O1: cada rama de la línea "Ahora"', () => {
  it('1. una pregunta abierta: quién te espera', () => {
    expect(nowLine(input({ asks: [ask('a1', 'paid')] }))).toEqual({ kind: 'waiting', memberIds: ['paid'] });
  });

  it('1. una pregunta nativa o un permiso del coordinador también te esperan', () => {
    expect(nowLine(input({ coordinatorWaiting: 1 }))).toEqual({ kind: 'waiting', memberIds: ['coord'] });
  });

  it('1. varios esperan: cada uno una vez, en orden', () => {
    const line = nowLine(input({ asks: [ask('a1', 'paid'), ask('a2', 'strategist'), ask('a3', 'paid')], coordinatorWaiting: 1 }));
    expect(line).toEqual({ kind: 'waiting', memberIds: ['paid', 'strategist', 'coord'] });
  });

  it('1. una pregunta ya contestada no espera a nadie', () => {
    const line = nowLine(input({ asks: [ask('a1', 'paid', { answer: 'Sí', answeredAt: '2026-09-24T10:40:00.000Z' })] }));
    expect(line?.kind).not.toBe('waiting');
  });

  it('2. el coordinador en pausa con run activo, con lo que tiene sin leer', () => {
    expect(nowLine(input({ coordinatorPaused: true, coordinatorUnread: 1 }))).toEqual({ kind: 'coordinatorPaused', memberId: 'coord', unread: 1 });
  });

  it('2. el motivo del run alcanza aunque el equipo todavía no haya refrescado su estado', () => {
    const line = nowLine(input({ run: run({ status: 'suspended', suspendReason: 'coordinator_paused' }) }));
    expect(line).toEqual({ kind: 'coordinatorPaused', memberId: 'coord', unread: 0 });
  });

  it('3. falta una tarea y nadie la tiene: sin despachar', () => {
    const line = nowLine(input({
      run: run({ tasksDone: 2, tasksPending: 1 }),
      tasks: [task('t1', 'done'), task('t2', 'done'), task('t3', 'ready', { spec: 'Calendario de octubre' })],
    }));
    expect(line).toEqual({ kind: 'missing', taskId: 't3', title: 'Calendario de octubre', noBudget: false });
  });

  it('3. con el presupuesto agotado lo dice: sin despachos disponibles', () => {
    const line = nowLine(input({
      run: run({ tasksDone: 2, tasksFailed: 1, tasksPending: 1 }),
      tasks: [task('t4', 'ready')],
    }));
    expect(line).toMatchObject({ kind: 'missing', noBudget: true });
  });

  it('3. una suspensión por tope también es "sin despachos disponibles"', () => {
    const line = nowLine(input({ run: run({ status: 'suspended', suspendReason: 'max_dispatches' }), tasks: [task('t1', 'ready')] }));
    expect(line).toMatchObject({ kind: 'missing', noBudget: true });
  });

  it('3. una tarea pendiente de una dependencia en curso NO falta: alguien la tiene', () => {
    const line = nowLine(input({
      tasks: [task('t1', 'running', { assignedMemberId: 'paid' }), task('t2', 'pending', { dependsOn: ['t1'] })],
    }));
    expect(line?.kind).toBe('working');
  });

  it('3. una tarea pendiente cuyas dependencias ya terminaron sí falta', () => {
    const line = nowLine(input({ tasks: [task('t1', 'done'), task('t2', 'pending', { dependsOn: ['t1'] })] }));
    expect(line).toMatchObject({ kind: 'missing', taskId: 't2' });
  });

  it('4. uno trabaja: quién y en qué', () => {
    const line = nowLine(input({ tasks: [task('t1', 'running', { assignedMemberId: 'paid', spec: 'Piezas Meta' })] }));
    expect(line).toEqual({ kind: 'working', workers: [{ memberId: 'paid', roleId: 'paid' }], title: 'Piezas Meta' });
  });

  it('4. varios trabajan: cada uno una vez', () => {
    const line = nowLine(input({
      tasks: [
        task('t1', 'running', { assignedMemberId: 'paid' }),
        task('t2', 'dispatched', { assignedMemberId: 'cm', roleId: 'cm' }),
        task('t3', 'running', { assignedMemberId: 'paid' }),
      ],
    }));
    expect(line).toMatchObject({ kind: 'working', workers: [{ memberId: 'paid', roleId: 'paid' }, { memberId: 'cm', roleId: 'cm' }] });
  });

  it('5. nada tuyo, nadie en vuelo, nada que falte: nada te espera', () => {
    expect(nowLine(input({ tasks: [task('t1', 'done')] }))).toEqual({ kind: 'calm' });
  });

  it('6. terminado: no hay línea, el subtítulo ya lo dice', () => {
    expect(nowLine(input({ run: run({ status: 'done', active: false }), asks: [ask('a1', 'paid')], coordinatorPaused: true }))).toBeNull();
  });
});

describe('O1: la prioridad es la regla', () => {
  const everything = input({
    asks: [ask('a1', 'paid')],
    coordinatorPaused: true,
    coordinatorUnread: 2,
    tasks: [task('t1', 'running', { assignedMemberId: 'cm' }), task('t2', 'ready')],
  });

  it('lo que te espera gana sobre todo lo demás', () => {
    expect(nowLine(everything)?.kind).toBe('waiting');
  });

  it('sin nada tuyo, el coordinador en pausa gana sobre lo que falta y sobre quién trabaja', () => {
    expect(nowLine({ ...everything, asks: [] })?.kind).toBe('coordinatorPaused');
  });

  it('sin pausa, lo que falta gana sobre quién trabaja', () => {
    expect(nowLine({ ...everything, asks: [], coordinatorPaused: false })?.kind).toBe('missing');
  });

  it('sin nada que falte, quién trabaja gana sobre "nada te espera"', () => {
    expect(nowLine({ ...everything, asks: [], coordinatorPaused: false, tasks: [task('t1', 'running', { assignedMemberId: 'cm' })] })?.kind).toBe('working');
  });

  it('la tarea de una pregunta abierta no "falta": te espera a vos', () => {
    const line = nowLine(input({ asks: [ask('a1', 'paid', { taskId: 't2' })], tasks: [task('t2', 'blocked')] }));
    expect(line?.kind).toBe('waiting');
  });
});
