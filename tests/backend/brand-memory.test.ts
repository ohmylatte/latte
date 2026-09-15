import { describe, expect, it } from 'vitest';
import type { Brand, Decision, FunnelStage, Work } from '../../shared/contracts';
import {
  ARTIFACT_EXCERPT_CHARS,
  BRAND_MEMORY_FILE,
  INHERITED_ARTIFACTS_INLINE_MAX,
  INHERITED_DECISIONS_INLINE_MAX,
  collectBrandMemory,
  isPlaceholderBrief,
  renderBrandMemory,
  type BrandMemoryWorkSource,
} from '../../electron/workspace/brandMemory';
import { renderInstructionBundle } from '../../electron/workspace/instructions';

const brand: Brand = { id: 'brd_bruma', name: 'Bruma Café', context: 'Tono directo, sin muletillas.', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null };
const otherBrand: Brand = { id: 'brd_rival', name: 'Rival', context: 'Nunca mezclar.', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null };

function work(id: string, brandId: string, title: string, updatedAt: string, resultPath: string | null = null): Work {
  return { id, brandId, title, brief: `# ${title}\n\n`, folder: null, resultPath, updatedAt } as Work;
}

function decision(partial: Partial<Decision> & Pick<Decision, 'id' | 'workId' | 'text' | 'status' | 'createdAt'>): Decision {
  return {
    rationale: '',
    alternativesRejected: [],
    evidenceRefs: [],
    source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null },
    clientRequestId: null,
    fingerprint: '',
    decidedAt: partial.status === 'approved' ? partial.createdAt : null,
    ...partial,
  };
}

function source(w: Work, decisions: Decision[], documents: BrandMemoryWorkSource['documents']): BrandMemoryWorkSource {
  return { work: w, decisions, documents };
}

const onboarding = work('wrk_onboard', brand.id, 'Onboarding', '2026-02-01T00:00:00.000Z');
const paid = work('wrk_paid', brand.id, 'Paid Media Q2', '2026-03-01T00:00:00.000Z');
const rivalWork = work('wrk_rival', otherBrand.id, 'Campaña rival', '2026-02-15T00:00:00.000Z');

const audienceDecision = decision({
  id: 'dec_aud',
  workId: onboarding.id,
  text: 'Audiencia primaria: mujeres 25-40 en CABA.',
  status: 'approved',
  createdAt: '2026-02-02T00:00:00.000Z',
  rationale: 'Entrevistas de onboarding.',
});
const pendingDecision = decision({
  id: 'dec_pend',
  workId: onboarding.id,
  text: 'Probar radio AM.',
  status: 'pending',
  createdAt: '2026-02-03T00:00:00.000Z',
});
const rejectedDecision = decision({
  id: 'dec_rej',
  workId: onboarding.id,
  text: 'Descartar influencer de mascotas.',
  status: 'rejected',
  createdAt: '2026-02-04T00:00:00.000Z',
});
const rivalDecision = decision({
  id: 'dec_secret',
  workId: rivalWork.id,
  text: 'SECRET_RIVAL_BUDGET_900k',
  status: 'approved',
  createdAt: '2026-02-10T00:00:00.000Z',
});
const localDecision = decision({
  id: 'dec_local',
  workId: paid.id,
  text: 'Pausar Advantage+ esta semana.',
  status: 'approved',
  createdAt: '2026-03-02T00:00:00.000Z',
});

const funnel: FunnelStage[] = ['consideration', 'conversion'];
const strategyDoc = {
  kind: 'strategy',
  title: 'Embudo de marca',
  fileName: 'strategy.md',
  status: 'review',
  funnelStages: funnel,
  content: '# Embudo de marca\n\nTOFU awareness, MOFU consideration, BOFU conversion con cupón de primera compra.',
};
const emptyBriefDoc = {
  kind: 'brief',
  title: 'Onboarding',
  fileName: 'brief.md',
  status: 'draft',
  funnelStages: [] as FunnelStage[],
  content: '# Onboarding\n\n',
};

describe('isPlaceholderBrief', () => {
  it('treats the createWork default brief as empty', () => {
    expect(isPlaceholderBrief('brief', 'Onboarding', '# Onboarding\n\n')).toBe(true);
    expect(isPlaceholderBrief('brief', 'Onboarding', '# Onboarding')).toBe(true);
    expect(isPlaceholderBrief('strategy', 'Onboarding', '# Onboarding\n\n')).toBe(false);
    expect(isPlaceholderBrief('brief', 'Onboarding', '# Onboarding\n\nPosicionamiento definido.')).toBe(false);
  });
});

describe('collectBrandMemory', () => {
  it('inherits approved decisions and artifacts from other works of the same brand, with origin', () => {
    const snapshot = collectBrandMemory({
      brand,
      currentWorkId: paid.id,
      sources: [
        source(onboarding, [audienceDecision, pendingDecision, rejectedDecision], [emptyBriefDoc, strategyDoc]),
        source(paid, [localDecision], []),
      ],
    });
    expect(snapshot.priorWorks.map((w) => w.id)).toEqual([onboarding.id]);
    expect(snapshot.decisions).toHaveLength(1);
    expect(snapshot.decisions[0]).toMatchObject({
      id: audienceDecision.id,
      workId: onboarding.id,
      workTitle: 'Onboarding',
      text: audienceDecision.text,
    });
    expect(snapshot.decisions.map((d) => d.text).join(' ')).not.toContain('radio AM');
    expect(snapshot.decisions.map((d) => d.text).join(' ')).not.toContain('influencer');
    expect(snapshot.decisions.map((d) => d.text).join(' ')).not.toContain(localDecision.text);
    expect(snapshot.artifacts).toHaveLength(1);
    expect(snapshot.artifacts[0]).toMatchObject({
      workId: onboarding.id,
      workTitle: 'Onboarding',
      fileName: 'strategy.md',
      funnelStages: funnel,
    });
    expect(snapshot.artifacts[0].excerpt).toContain('TOFU awareness');
  });

  it('drops sources from another brand even if the caller mixed them in', () => {
    const snapshot = collectBrandMemory({
      brand,
      currentWorkId: paid.id,
      sources: [
        source(onboarding, [audienceDecision], [strategyDoc]),
        source(rivalWork, [rivalDecision], [{
          kind: 'strategy',
          title: 'Plan rival',
          fileName: 'rival.md',
          status: 'approved',
          funnelStages: ['conversion'],
          content: 'SECRET_RIVAL_BUDGET_900k en el documento.',
        }]),
      ],
    });
    expect(snapshot.priorWorks.map((w) => w.id)).toEqual([onboarding.id]);
    expect(JSON.stringify(snapshot)).not.toContain('SECRET_RIVAL_BUDGET_900k');
    expect(JSON.stringify(snapshot)).not.toContain(rivalWork.id);
  });

  it('keeps a linked result as a pointer and excerpts long documents', () => {
    const withResult = work('wrk_old', brand.id, 'Propuesta', '2026-01-20T00:00:00.000Z', 'propuesta.pdf');
    const long = 'Pieza '.repeat(200);
    const snapshot = collectBrandMemory({
      brand,
      currentWorkId: paid.id,
      sources: [source(withResult, [], [{
        kind: 'copy',
        title: 'Landing',
        fileName: 'landing.md',
        status: 'approved',
        funnelStages: ['conversion'],
        content: long,
      }])],
    });
    expect(snapshot.artifacts.some((a) => a.kind === 'result' && a.fileName === 'propuesta.pdf' && a.workId === withResult.id)).toBe(true);
    const landing = snapshot.artifacts.find((a) => a.fileName === 'landing.md');
    expect(landing?.excerptTruncated).toBe(true);
    expect(landing?.excerpt.length).toBe(ARTIFACT_EXCERPT_CHARS);
  });
});

describe('renderBrandMemory', () => {
  it('always materializes a snapshot file and points at it', () => {
    const snapshot = collectBrandMemory({
      brand,
      currentWorkId: paid.id,
      sources: [source(onboarding, [audienceDecision], [strategyDoc])],
    });
    const rendered = renderBrandMemory(snapshot, { decisions: INHERITED_DECISIONS_INLINE_MAX, artifacts: INHERITED_ARTIFACTS_INLINE_MAX });
    expect(rendered).toBeTruthy();
    expect(rendered!.sideFile.path).toBe(BRAND_MEMORY_FILE);
    expect(rendered!.body).toContain(`Inspect the full snapshot in ./${BRAND_MEMORY_FILE}.`);
    expect(rendered!.body).toContain(`from work "Onboarding" (\`${onboarding.id}\`)`);
    expect(rendered!.body).toContain(audienceDecision.text);
    expect(rendered!.body).toContain('funnel: consideration, conversion');
    expect(rendered!.sideFile.content).toContain(audienceDecision.text);
    expect(rendered!.truncated).toBe(false);
  });

  it('keeps the newest inherited decisions inline and pointers the overflow in the snapshot', () => {
    const many = Array.from({ length: INHERITED_DECISIONS_INLINE_MAX + 4 }, (_, i) => decision({
      id: `dec_${String(i).padStart(3, '0')}`,
      workId: onboarding.id,
      text: `Inherited decision ${i} about positioning.`,
      status: 'approved',
      createdAt: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    const snapshot = collectBrandMemory({
      brand,
      currentWorkId: paid.id,
      sources: [source(onboarding, many, [])],
    });
    const rendered = renderBrandMemory(snapshot, { decisions: INHERITED_DECISIONS_INLINE_MAX, artifacts: INHERITED_ARTIFACTS_INLINE_MAX });
    expect(rendered?.truncated).toBe(true);
    expect(rendered?.body).toContain(`4 earlier inherited decisions are recorded in ./${BRAND_MEMORY_FILE}.`);
    expect(rendered?.body).not.toContain('Inherited decision 0 ');
    expect(rendered?.body).toContain(`Inherited decision ${INHERITED_DECISIONS_INLINE_MAX + 3}`);
    for (const d of many) expect(rendered?.sideFile.content).toContain(d.text);
  });

  it('returns null when the brand has no other work', () => {
    expect(renderBrandMemory(collectBrandMemory({ brand, currentWorkId: paid.id, sources: [] }), { decisions: 10, artifacts: 6 })).toBeNull();
  });
});

describe('renderInstructionBundle: current delta vs inherited brand knowledge', () => {
  it('compacts inherited knowledge against the instruction budget and points at the snapshot file', () => {
    const many = Array.from({ length: 40 }, (_, i) => decision({
      id: `dec_h_${String(i).padStart(3, '0')}`,
      workId: onboarding.id,
      text: `Inherited decision ${i} about the brand funnel, budget split and channel mix for the year.`,
      status: 'approved',
      createdAt: `2026-01-15T00:00:00.${String(i).padStart(3, '0')}Z`,
    }));
    const localMany = Array.from({ length: 40 }, (_, i) => decision({
      id: `dec_l_${String(i).padStart(3, '0')}`,
      workId: paid.id,
      text: `Local decision ${i} about this week's media mix and pacing.`,
      status: 'approved',
      createdAt: `2026-03-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    const heavyBrand = { ...brand, context: 'Z'.repeat(15_000) };
    const snapshot = collectBrandMemory({
      brand: heavyBrand,
      currentWorkId: paid.id,
      sources: [source(onboarding, many, [strategyDoc])],
    });
    const bundle = renderInstructionBundle({
      brand: heavyBrand,
      work: paid,
      decisions: localMany,
      brandMemory: snapshot,
    });
    expect(bundle.text).toMatch(/earlier inherited decisions are recorded in \.\/\.latte\/context\/brand-memory\.md/);
    expect(bundle.text).not.toContain('Inherited decision 0 ');
    expect(bundle.files.find((f) => f.path === BRAND_MEMORY_FILE)?.content).toContain('Inherited decision 0 ');
    expect(bundle.text).toContain('Local decision 39');
    expect(bundle.text).toContain('25 earlier decisions are recorded in ./.latte/context/decisions.md');
  });

  it('keeps local decisions in this work and inherited ones with origin, without mixing brands', () => {
    const snapshot = collectBrandMemory({
      brand,
      currentWorkId: paid.id,
      sources: [
        source(onboarding, [audienceDecision], [strategyDoc]),
        source(rivalWork, [rivalDecision], []),
      ],
    });
    const bundle = renderInstructionBundle({
      brand,
      work: paid,
      decisions: [localDecision],
      brandMemory: snapshot,
    });
    expect(bundle.text).toContain('## Brand knowledge from previous work (inherited, not this work\'s delta)');
    expect(bundle.text).toContain('## Decisions already taken in this work (do not reopen)');
    expect(bundle.text).toContain(localDecision.text);
    expect(bundle.text).toContain(`from work "Onboarding" (\`${onboarding.id}\`): ${audienceDecision.text}`);
    expect(bundle.text).not.toContain('SECRET_RIVAL_BUDGET_900k');
    expect(bundle.text).toContain('Do not claim you lack brand context');
    expect(bundle.text).toContain(`./${BRAND_MEMORY_FILE}`);
    const side = bundle.files.find((f) => f.path === BRAND_MEMORY_FILE);
    expect(side?.content).toContain(audienceDecision.text);
    expect(side?.content).not.toContain(localDecision.text);
    expect(side?.content).not.toContain('SECRET_RIVAL_BUDGET_900k');
  });
});
