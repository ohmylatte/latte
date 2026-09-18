import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { I18nProvider } from './i18n';
import { ResumenView, type ResumenViewProps } from './ResumenView';
import { EMPTY_USAGE, type Brand, type CoordinationDispatchLogEntryView, type CoordinationLogEntryView, type Work } from '../shared/contracts';

/**
 * The settle action on the in-flight dispatch row (autonomous-coordination
 * Phase 7 task 7.11): surfaces task 3.19's `settleCoordinationDispatch`,
 * never reinvents it. Only a `dispatched`/`running` bitácora row (the
 * dispatch actually in flight) gets the control — a `reported`/`failed`/
 * `pending_approval` row is already settled or not yet started.
 */

const brand = (patch: Partial<Brand> = {}): Brand => ({ id: 'b1', name: 'Casa Oliva', context: 'Tono cálido.', createdAt: '', archivedAt: null, ...patch });
const work = (patch: Partial<Work> = {}): Work => ({
  id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: 'Lanzar la campaña.', folder: null,
  expectedOutput: null, resultPath: null, updatedAt: '2026-09-01T00:00:00.000Z', ...patch,
});
const logEntry = (patch: Partial<CoordinationDispatchLogEntryView> = {}): CoordinationLogEntryView => ({
  id: 'log1', taskId: 'task1', memberId: 'm1', status: 'dispatched',
  createdAt: '2026-09-01T00:00:00.000Z', startedAt: '2026-09-01T00:00:00.000Z', settledAt: null, ...patch,
});

const base: ResumenViewProps = {
  brand: brand(), work: work(), documents: [], decisions: [], states: {}, checking: false,
  team: [], permissions: 'ask', live: false, brandContextDefined: true,
  formatDate: () => 'hace un rato', onOpenBrief: () => {},
};

const mount = (patch: Partial<ResumenViewProps> = {}) => render(<I18nProvider><ResumenView {...base} {...patch} /></I18nProvider>);

describe('settling the in-flight dispatch from the bitácora (task 7.11)', () => {
  it('renders no settle control when there is no in-flight dispatch', () => {
    const { container } = mount({ coordinationLog: [logEntry({ status: 'reported' })] });
    expect(container.querySelector('.resumen-bitacora-settle')).toBeNull();
  });

  it('renders no settle control when the caller has not wired an onSettleDispatch handler', () => {
    const { container } = mount({ coordinationLog: [logEntry({ status: 'dispatched' })] });
    expect(container.querySelector('.resumen-bitacora-settle')).toBeNull();
  });

  it('renders the settle control for a "dispatched" row', () => {
    const { container } = mount({ coordinationLog: [logEntry({ status: 'dispatched' })], onSettleDispatch: () => {} });
    expect(container.querySelector('.resumen-bitacora-settle')).not.toBeNull();
  });

  it('renders the settle control for a "running" row too', () => {
    const { container } = mount({ coordinationLog: [logEntry({ status: 'running' })], onSettleDispatch: () => {} });
    expect(container.querySelector('.resumen-bitacora-settle')).not.toBeNull();
  });

  it('calls onSettleDispatch with the taskId, "succeeded" and the entered summary', () => {
    const onSettleDispatch = vi.fn();
    vi.spyOn(window, 'prompt').mockReturnValue('Brief listo');
    const { container } = mount({ coordinationLog: [logEntry({ taskId: 'task-xyz', status: 'running' })], onSettleDispatch });
    fireEvent.click(container.querySelector('.resumen-bitacora-settle-succeeded')!);
    expect(onSettleDispatch).toHaveBeenCalledWith('task-xyz', 'succeeded', 'Brief listo');
    vi.restoreAllMocks();
  });

  it('calls onSettleDispatch with "failed" from the other button', () => {
    const onSettleDispatch = vi.fn();
    vi.spyOn(window, 'prompt').mockReturnValue('El runtime se cayó');
    const { container } = mount({ coordinationLog: [logEntry({ taskId: 'task-xyz', status: 'dispatched' })], onSettleDispatch });
    fireEvent.click(container.querySelector('.resumen-bitacora-settle-failed')!);
    expect(onSettleDispatch).toHaveBeenCalledWith('task-xyz', 'failed', 'El runtime se cayó');
    vi.restoreAllMocks();
  });

  it('does not settle when the summary prompt is cancelled — never a blank summary', () => {
    const onSettleDispatch = vi.fn();
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    const { container } = mount({ coordinationLog: [logEntry({ status: 'running' })], onSettleDispatch });
    fireEvent.click(container.querySelector('.resumen-bitacora-settle-succeeded')!);
    expect(onSettleDispatch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('a hire row (not a dispatch) never gets a settle control', () => {
    const { container } = mount({
      coordinationLog: [],
      coordinationHires: [{ memberId: 'm2', roleName: 'Copywriter', hiredAt: '2026-09-01T00:00:00.000Z' }],
      onSettleDispatch: () => {},
    });
    expect(container.querySelector('.resumen-bitacora-settle')).toBeNull();
  });
});
