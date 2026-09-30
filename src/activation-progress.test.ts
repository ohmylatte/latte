import { describe, expect, it } from 'vitest';
import { activationSteps, type ActivationSignals } from './activation-progress';

const base: ActivationSignals = {
  briefSent: false, agentWorking: false, pendingApprovals: 0, resultReady: false, hasVerification: false, verified: false,
};

describe('activationSteps: la escalera de negocio de una conversación', () => {
  it('sin verificación aplicable, son cuatro casilleros: brief, working, approval, result', () => {
    const steps = activationSteps(base);
    expect(steps.map((s) => s.id)).toEqual(['brief', 'working', 'approval', 'result']);
  });

  it('con `hasVerification`, agrega el quinto casillero al final', () => {
    const steps = activationSteps({ ...base, hasVerification: true });
    expect(steps.map((s) => s.id)).toEqual(['brief', 'working', 'approval', 'result', 'verified']);
  });

  it('nada mandado todavía: ningún casillero está "current" (nada arrancó)', () => {
    const steps = activationSteps(base);
    expect(steps.every((s) => s.tone === 'pending')).toBe(true);
  });

  it('el brief se mandó: ese casillero es el "current", el resto pending', () => {
    const steps = activationSteps({ ...base, briefSent: true });
    expect(steps.map((s) => s.tone)).toEqual(['current', 'pending', 'pending', 'pending']);
  });

  it('el agente está respondiendo: brief pasa a done, working es el current', () => {
    const steps = activationSteps({ ...base, briefSent: true, agentWorking: true });
    expect(steps.map((s) => s.tone)).toEqual(['done', 'current', 'pending', 'pending']);
  });

  it('hay un permiso o pregunta pendiente: la aprobación es el current, working ya pasó', () => {
    const steps = activationSteps({ ...base, briefSent: true, pendingApprovals: 1 });
    expect(steps.map((s) => s.tone)).toEqual(['done', 'done', 'current', 'pending']);
  });

  it('el resultado está listo: los tres primeros quedan done y el resultado es el último, done', () => {
    const steps = activationSteps({ ...base, briefSent: true, resultReady: true });
    expect(steps.map((s) => s.tone)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('con verificación aplicable, el resultado listo (sin verificar) es el current y verificado queda pending', () => {
    const steps = activationSteps({ ...base, briefSent: true, resultReady: true, hasVerification: true });
    expect(steps.map((s) => s.tone)).toEqual(['done', 'done', 'done', 'current', 'pending']);
  });

  it('verificado: los cinco casilleros quedan done', () => {
    const steps = activationSteps({ ...base, briefSent: true, resultReady: true, hasVerification: true, verified: true });
    expect(steps.every((s) => s.tone === 'done')).toBe(true);
  });

  it('nunca inventa "trabajando" sin un brief mandado, aunque el resto de señales estén prendidas', () => {
    const steps = activationSteps({ ...base, agentWorking: true, pendingApprovals: 2, resultReady: true });
    // `working` exige `briefSent`; sin eso, ninguna conversación empezó de verdad.
    const working = steps.find((s) => s.id === 'working')!;
    expect(working.tone).not.toBe('done');
  });
});
