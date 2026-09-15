import type { Brand, Decision, FunnelStage, Work } from '../../shared/contracts';
import { WORK_FILES } from '../core/paths';

/** Materialized catalog of inherited brand knowledge, always inside the current work. */
export const BRAND_MEMORY_FILE = `${WORK_FILES.metaDir}/${WORK_FILES.contextDir}/brand-memory.md`;

/** How many inherited decisions ride the instruction file before older ones stay in the snapshot file. */
export const INHERITED_DECISIONS_INLINE_MAX = 10;
/** Floor when the whole instruction file is over INSTRUCTIONS_MAX_CHARS. */
export const INHERITED_DECISIONS_INLINE_FLOOR = 3;
/** How many inherited artifact pointers ride the instruction file. */
export const INHERITED_ARTIFACTS_INLINE_MAX = 6;
export const INHERITED_ARTIFACTS_INLINE_FLOOR = 2;
/** Excerpt stored in the snapshot file. Inline uses a shorter slice of the same text. */
export const ARTIFACT_EXCERPT_CHARS = 400;
export const ARTIFACT_EXCERPT_INLINE_CHARS = 160;

export interface BrandMemoryDocumentSource {
  kind: string;
  title: string;
  fileName: string;
  status: string;
  funnelStages: FunnelStage[];
  /** Full file text as read by the caller; the resolver excerpts it. */
  content: string;
}

export interface BrandMemoryWorkSource {
  work: Pick<Work, 'id' | 'brandId' | 'title' | 'resultPath' | 'updatedAt'>;
  decisions: Decision[];
  documents: BrandMemoryDocumentSource[];
}

export interface BrandMemoryInput {
  brand: Pick<Brand, 'id' | 'name'>;
  currentWorkId: string;
  sources: BrandMemoryWorkSource[];
}

export interface InheritedDecision {
  id: string;
  workId: string;
  workTitle: string;
  createdAt: string;
  text: string;
  rationale: string;
}

export interface InheritedArtifact {
  workId: string;
  workTitle: string;
  kind: string;
  title: string;
  fileName: string;
  status: string;
  funnelStages: FunnelStage[];
  excerpt: string;
  excerptTruncated: boolean;
}

export interface PriorWorkRef {
  id: string;
  title: string;
  updatedAt: string;
}

/** Deterministic, bounded snapshot of inheritable brand knowledge. No I/O. */
export interface BrandMemorySnapshot {
  brandId: string;
  brandName: string;
  priorWorks: PriorWorkRef[];
  decisions: InheritedDecision[];
  artifacts: InheritedArtifact[];
}

export interface BrandMemoryRenderLimits {
  decisions: number;
  artifacts: number;
}

export interface RenderedBrandMemory {
  /** Markdown body of the instruction section, without the heading. */
  body: string;
  /** Full catalog written next to CLAUDE.md / AGENTS.md. */
  sideFile: { path: string; content: string };
  truncated: boolean;
}

function collapse(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function excerptOf(content: string, max: number): { text: string; truncated: boolean } {
  const collapsed = collapse(content);
  if (collapsed.length <= max) return { text: collapsed, truncated: false };
  return { text: collapsed.slice(0, max), truncated: true };
}

/** Empty default brief Latte writes on createWork (`# Title` plus blank lines). */
export function isPlaceholderBrief(kind: string, title: string, content: string): boolean {
  if (kind !== 'brief') return false;
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;
  return trimmed === `# ${title}`;
}

function isApproved(decision: Decision): boolean {
  return decision.status === 'approved';
}

/**
 * Collects inheritable knowledge from other works of the same brand.
 * Current-work delta is excluded. Sources whose brandId does not match are dropped.
 */
export function collectBrandMemory(input: BrandMemoryInput): BrandMemorySnapshot {
  const prior: BrandMemoryWorkSource[] = [];
  for (const source of input.sources) {
    if (source.work.id === input.currentWorkId) continue;
    if (source.work.brandId !== input.brand.id) continue;
    prior.push(source);
  }
  prior.sort((a, b) => b.work.updatedAt.localeCompare(a.work.updatedAt) || a.work.title.localeCompare(b.work.title) || a.work.id.localeCompare(b.work.id));

  const decisions: InheritedDecision[] = [];
  const artifacts: InheritedArtifact[] = [];
  for (const source of prior) {
    for (const decision of source.decisions) {
      if (!isApproved(decision)) continue;
      decisions.push({
        id: decision.id,
        workId: source.work.id,
        workTitle: source.work.title,
        createdAt: decision.createdAt,
        text: collapse(decision.text),
        rationale: collapse(decision.rationale),
      });
    }
    const seenFiles = new Set<string>();
    for (const doc of source.documents) {
      if (isPlaceholderBrief(doc.kind, doc.title, doc.content)) continue;
      const excerpt = excerptOf(doc.content, ARTIFACT_EXCERPT_CHARS);
      artifacts.push({
        workId: source.work.id,
        workTitle: source.work.title,
        kind: doc.kind,
        title: doc.title,
        fileName: doc.fileName,
        status: doc.status,
        funnelStages: [...doc.funnelStages],
        excerpt: excerpt.text,
        excerptTruncated: excerpt.truncated,
      });
      seenFiles.add(doc.fileName);
    }
    const resultPath = source.work.resultPath?.trim() ?? '';
    if (resultPath.length > 0 && !seenFiles.has(resultPath)) {
      artifacts.push({
        workId: source.work.id,
        workTitle: source.work.title,
        kind: 'result',
        title: 'Linked result',
        fileName: resultPath,
        status: 'linked',
        funnelStages: [],
        excerpt: '',
        excerptTruncated: false,
      });
    }
  }
  decisions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  return {
    brandId: input.brand.id,
    brandName: input.brand.name,
    priorWorks: prior.map((s) => ({ id: s.work.id, title: s.work.title, updatedAt: s.work.updatedAt })),
    decisions,
    artifacts,
  };
}

export function hasBrandMemory(snapshot: BrandMemorySnapshot | null | undefined): boolean {
  return (snapshot?.priorWorks.length ?? 0) > 0;
}

function decisionLine(d: InheritedDecision): string {
  return `- ${d.createdAt.slice(0, 10)} — from work "${d.workTitle}" (\`${d.workId}\`): ${d.text}`;
}

function artifactLine(a: InheritedArtifact, excerptMax: number): string {
  const stages = a.funnelStages.length > 0 ? a.funnelStages.join(', ') : 'unclassified';
  let excerpt = '';
  if (a.excerpt.length > 0) {
    const needsCut = a.excerpt.length > excerptMax;
    const text = needsCut ? a.excerpt.slice(0, excerptMax) : a.excerpt;
    excerpt = ` — excerpt: ${text}${needsCut || a.excerptTruncated ? '…' : ''}`;
  }
  return `- from work "${a.workTitle}" (\`${a.workId}\`): \`${a.fileName}\` — ${a.title} (${a.kind}, ${a.status}) — funnel: ${stages}${excerpt}`;
}

function catalogMarkdown(snapshot: BrandMemorySnapshot): string {
  const decisionBlock = snapshot.decisions.length === 0
    ? '_No approved decisions in previous work._'
    : snapshot.decisions.map((d) => {
      const rationale = d.rationale.length > 0 ? `\n  rationale: ${d.rationale}` : '';
      return `${decisionLine(d)}${rationale}`;
    }).join('\n');
  const artifactBlock = snapshot.artifacts.length === 0
    ? '_No tracked documents or linked results in previous work._'
    : snapshot.artifacts.map((a) => artifactLine(a, ARTIFACT_EXCERPT_CHARS)).join('\n');
  const prior = snapshot.priorWorks.map((w) => `- ${w.title} (\`${w.id}\`)`).join('\n');
  return [
    `# Brand knowledge — ${snapshot.brandName}`,
    '',
    'Inherited from other works of this brand. Not this work\'s brief or local decision log.',
    'Each decision and artifact keeps the work it came from. Do not mix another brand into this file.',
    '',
    '## Prior work',
    '',
    prior,
    '',
    '## Approved decisions (with origin)',
    '',
    decisionBlock,
    '',
    '## Documents and deliverables (pointers)',
    '',
    artifactBlock,
    '',
  ].join('\n');
}

/**
 * Renders the inherited section plus the always-written snapshot file.
 * Null when this brand has no other work: nothing to inherit.
 */
export function renderBrandMemory(
  snapshot: BrandMemorySnapshot,
  limits: BrandMemoryRenderLimits,
): RenderedBrandMemory | null {
  if (snapshot.priorWorks.length === 0) return null;
  const decisionsMax = Math.max(0, limits.decisions);
  const artifactsMax = Math.max(0, limits.artifacts);
  const decisionOverflow = Math.max(0, snapshot.decisions.length - decisionsMax);
  const artifactOverflow = Math.max(0, snapshot.artifacts.length - artifactsMax);
  const truncated = decisionOverflow > 0 || artifactOverflow > 0;
  const inlinedDecisions = decisionOverflow > 0 ? snapshot.decisions.slice(decisionOverflow) : snapshot.decisions;
  const inlinedArtifacts = snapshot.artifacts.slice(0, artifactsMax);

  const decisionLines = snapshot.decisions.length === 0
    ? ['_No approved decisions in previous work._']
    : [
      ...inlinedDecisions.map(decisionLine),
      ...(decisionOverflow > 0 ? [`- ${decisionOverflow} earlier inherited decisions are recorded in ./${BRAND_MEMORY_FILE}.`] : []),
    ];
  const artifactLines = snapshot.artifacts.length === 0
    ? ['_No tracked documents or linked results in previous work._']
    : [
      ...inlinedArtifacts.map((a) => artifactLine(a, ARTIFACT_EXCERPT_INLINE_CHARS)),
      ...(artifactOverflow > 0 ? [`- ${artifactOverflow} more artifacts are recorded in ./${BRAND_MEMORY_FILE}.`] : []),
    ];

  const body = [
    'This section is inherited brand knowledge from other works of this same brand. It is not this work\'s brief, documents or local decision log.',
    'Do not claim you lack brand context when Brand context or this section has content. Tactical decisions keep their origin work; do not treat them as this work\'s own log.',
    `Inspect the full snapshot in ./${BRAND_MEMORY_FILE}.`,
    '',
    'Prior work of this brand:',
    ...snapshot.priorWorks.map((w) => `- ${w.title} (\`${w.id}\`)`),
    '',
    'Approved decisions from previous work:',
    ...decisionLines,
    '',
    'Documents and deliverables from previous work (pointers; the files live in their origin work, not this folder):',
    ...artifactLines,
  ].join('\n');

  return {
    body,
    sideFile: { path: BRAND_MEMORY_FILE, content: catalogMarkdown(snapshot) },
    truncated,
  };
}
