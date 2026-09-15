import type { Brand, Decision, FunnelStage, Work } from '../../shared/contracts';
import { WORK_FILES } from '../core/paths';

/** Index of inherited brand knowledge, always inside the current work. */
export const BRAND_MEMORY_FILE = `${WORK_FILES.metaDir}/${WORK_FILES.contextDir}/brand-memory.md`;
/** Read-only copies of inherited markdown, nested under this directory. */
export const BRAND_MEMORY_DIR = `${WORK_FILES.metaDir}/${WORK_FILES.contextDir}/brand-memory`;

/** How many inherited decisions ride the instruction file before older ones stay in the snapshot file. */
export const INHERITED_DECISIONS_INLINE_MAX = 10;
/** Floor when the whole instruction file is over INSTRUCTIONS_MAX_CHARS. */
export const INHERITED_DECISIONS_INLINE_FLOOR = 3;
/** How many inherited artifact pointers ride the instruction file. */
export const INHERITED_ARTIFACTS_INLINE_MAX = 6;
export const INHERITED_ARTIFACTS_INLINE_FLOOR = 2;
/** Excerpt inlined in AGENTS.md / the index. The recoverable copy is larger. */
export const ARTIFACT_EXCERPT_CHARS = 400;
export const ARTIFACT_EXCERPT_INLINE_CHARS = 160;
/** Per-file cap for a local inherited copy. Enough to recover a real document. */
export const ARTIFACT_COPY_PER_FILE_CHARS = 12_000;
/** Global cap across all inherited copies in one snapshot. */
export const ARTIFACT_COPY_TOTAL_CHARS = 48_000;
/** Max number of inherited markdown copies. */
export const ARTIFACT_COPY_MAX_FILES = 12;
/** If the remaining global budget is below this, later files are listed but not copied. */
export const ARTIFACT_COPY_MIN_CHARS = 400;

export type ArtifactCopyStatus =
  | 'copied'
  | 'copied-truncated'
  | 'omitted-budget'
  | 'omitted-binary'
  | 'omitted-empty'
  | 'omitted-unsafe';

export interface BrandMemoryDocumentSource {
  kind: string;
  title: string;
  fileName: string;
  status: string;
  funnelStages: FunnelStage[];
  /** Full file text as read by the caller; the resolver excerpts and copies it. */
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
  /** Path relative to this work directory when a local copy was written. */
  localPath: string | null;
  copyStatus: ArtifactCopyStatus;
  /** Raw body of the local copy, already capped. Null when not copied. */
  copyBody: string | null;
  omittedChars: number;
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

export interface RenderedInstructionCopy {
  path: string;
  content: string;
}

export interface RenderedBrandMemory {
  /** Markdown body of the instruction section, without the heading. */
  body: string;
  /** Index plus local copies. */
  files: RenderedInstructionCopy[];
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

/** Path segment safe for Latte's work-directory join (no separators, no `..`). */
export function isSafePathSegment(segment: string): boolean {
  if (typeof segment !== 'string' || segment.length === 0) return false;
  if (segment === '.' || segment === '..') return false;
  if (segment.includes('/') || segment.includes('\\') || segment.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(segment)) return false;
  return true;
}

function isMarkdownName(fileName: string): boolean {
  return /\.(md|markdown|txt)$/i.test(fileName);
}

export function localCopyPath(workId: string, fileName: string): string | null {
  if (!isSafePathSegment(workId) || !isSafePathSegment(fileName)) return null;
  return `${BRAND_MEMORY_DIR}/${workId}/${fileName}`;
}

function copyRank(a: { kind: string; funnelStages: FunnelStage[] }): number {
  const funnel = a.funnelStages.length > 0 ? 0 : 1;
  const kind = a.kind === 'brief' ? 1 : a.kind === 'result' ? 2 : 0;
  return funnel * 10 + kind;
}

interface PendingArtifact extends InheritedArtifact {
  sourceContent: string;
}

function assignCopies(pending: PendingArtifact[]): InheritedArtifact[] {
  const order = pending
    .map((artifact, index) => ({ artifact, index }))
    .sort((a, b) => copyRank(a.artifact) - copyRank(b.artifact) || a.index - b.index);

  let used = 0;
  let files = 0;
  for (const { artifact } of order) {
    const path = localCopyPath(artifact.workId, artifact.fileName);
    if (!path) {
      artifact.copyStatus = 'omitted-unsafe';
      continue;
    }
    if (!isMarkdownName(artifact.fileName) || artifact.kind === 'result') {
      artifact.copyStatus = 'omitted-binary';
      continue;
    }
    if (artifact.sourceContent.trim().length === 0) {
      artifact.copyStatus = 'omitted-empty';
      continue;
    }
    const remaining = ARTIFACT_COPY_TOTAL_CHARS - used;
    if (files >= ARTIFACT_COPY_MAX_FILES || remaining < ARTIFACT_COPY_MIN_CHARS) {
      artifact.copyStatus = 'omitted-budget';
      continue;
    }
    const cap = Math.min(ARTIFACT_COPY_PER_FILE_CHARS, remaining);
    const truncated = artifact.sourceContent.length > cap;
    artifact.copyBody = truncated ? artifact.sourceContent.slice(0, cap) : artifact.sourceContent;
    artifact.omittedChars = truncated ? artifact.sourceContent.length - cap : 0;
    artifact.copyStatus = truncated ? 'copied-truncated' : 'copied';
    artifact.localPath = path;
    used += artifact.copyBody.length;
    files += 1;
  }

  return pending.map(({ sourceContent: _source, ...artifact }) => artifact);
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
  const pending: PendingArtifact[] = [];
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
      pending.push({
        workId: source.work.id,
        workTitle: source.work.title,
        kind: doc.kind,
        title: doc.title,
        fileName: doc.fileName,
        status: doc.status,
        funnelStages: [...doc.funnelStages],
        excerpt: excerpt.text,
        excerptTruncated: excerpt.truncated,
        localPath: null,
        copyStatus: 'omitted-budget',
        copyBody: null,
        omittedChars: 0,
        sourceContent: doc.content,
      });
      seenFiles.add(doc.fileName);
    }
    const resultPath = source.work.resultPath?.trim() ?? '';
    if (resultPath.length > 0 && !seenFiles.has(resultPath)) {
      pending.push({
        workId: source.work.id,
        workTitle: source.work.title,
        kind: 'result',
        title: 'Linked result',
        fileName: resultPath,
        status: 'linked',
        funnelStages: [],
        excerpt: '',
        excerptTruncated: false,
        localPath: null,
        copyStatus: 'omitted-binary',
        copyBody: null,
        omittedChars: 0,
        sourceContent: '',
      });
    }
  }
  decisions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  return {
    brandId: input.brand.id,
    brandName: input.brand.name,
    priorWorks: prior.map((s) => ({ id: s.work.id, title: s.work.title, updatedAt: s.work.updatedAt })),
    decisions,
    artifacts: assignCopies(pending),
  };
}

export function hasBrandMemory(snapshot: BrandMemorySnapshot | null | undefined): boolean {
  return (snapshot?.priorWorks.length ?? 0) > 0;
}

function decisionLine(d: InheritedDecision): string {
  return `- ${d.createdAt.slice(0, 10)} — from work "${d.workTitle}" (\`${d.workId}\`): ${d.text}`;
}

function copyNote(a: InheritedArtifact): string {
  if (a.localPath) {
    const cut = a.copyStatus === 'copied-truncated' ? ' (copy truncated to budget)' : '';
    return ` — read \`./${a.localPath}\`${cut}`;
  }
  if (a.copyStatus === 'omitted-binary') return ' — binary, not copied; listed only';
  if (a.copyStatus === 'omitted-budget') return ' — not copied (copy budget); listed only';
  if (a.copyStatus === 'omitted-unsafe') return ' — not copied (unsafe path); listed only';
  if (a.copyStatus === 'omitted-empty') return ' — empty, not copied';
  return '';
}

function artifactLine(a: InheritedArtifact, excerptMax: number): string {
  const stages = a.funnelStages.length > 0 ? a.funnelStages.join(', ') : 'unclassified';
  let excerpt = '';
  if (a.excerpt.length > 0) {
    const needsCut = a.excerpt.length > excerptMax;
    const text = needsCut ? a.excerpt.slice(0, excerptMax) : a.excerpt;
    excerpt = ` — excerpt: ${text}${needsCut || a.excerptTruncated ? '…' : ''}`;
  }
  return `- from work "${a.workTitle}" (\`${a.workId}\`): \`${a.fileName}\` — ${a.title} (${a.kind}, ${a.status}) — funnel: ${stages}${excerpt}${copyNote(a)}`;
}

function wrapCopy(snapshot: BrandMemorySnapshot, artifact: InheritedArtifact): string {
  const stages = artifact.funnelStages.length > 0 ? artifact.funnelStages.join(', ') : 'unclassified';
  const truncation = artifact.copyStatus === 'copied-truncated'
    ? `\n\n_[… truncated: ${artifact.omittedChars} characters omitted to stay within the brand-memory copy budget. The rest is not available in this folder.]_\n`
    : '\n';
  return [
    '<!-- latte:brand-memory-copy -->',
    `# Inherited from "${artifact.workTitle}" (\`${artifact.workId}\`) — ${snapshot.brandName}`,
    '',
    `- Origin file: \`${artifact.fileName}\``,
    `- Kind: ${artifact.kind}`,
    `- Status: ${artifact.status}`,
    `- Funnel: ${stages}`,
    '- Read-only copy for this work. Not this work\'s deliverable. Do not edit. Do not leave this directory to fetch the origin file.',
    '',
    '---',
    '',
    (artifact.copyBody ?? '').trimEnd(),
    truncation,
  ].join('\n');
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
  const copies = snapshot.artifacts.filter((a) => a.localPath);
  const copyIndex = copies.length === 0
    ? '_No local copies in this snapshot._'
    : copies.map((a) => `- \`./${a.localPath}\` — ${a.title} from work "${a.workTitle}" (\`${a.workId}\`)`).join('\n');
  return [
    `# Brand knowledge — ${snapshot.brandName}`,
    '',
    'Inherited from other works of this brand. Not this work\'s brief or local decision log.',
    'Each decision and artifact keeps the work it came from. Do not mix another brand into this file.',
    `Recoverable copies of inherited markdown live under ./${BRAND_MEMORY_DIR}/. Read those when an excerpt is not enough. Do not leave this directory to open the origin work.`,
    '',
    '## Prior work',
    '',
    prior,
    '',
    '## Approved decisions (with origin)',
    '',
    decisionBlock,
    '',
    '## Documents and deliverables',
    '',
    artifactBlock,
    '',
    '## Local copies',
    '',
    copyIndex,
    '',
  ].join('\n');
}

/**
 * Renders the inherited section plus the index and local copies.
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
    `Inspect the index in ./${BRAND_MEMORY_FILE}. Recoverable copies of inherited markdown are under ./${BRAND_MEMORY_DIR}/. Read those local copies when an excerpt is not enough. Do not leave this directory to fetch origin files.`,
    '',
    'Prior work of this brand:',
    ...snapshot.priorWorks.map((w) => `- ${w.title} (\`${w.id}\`)`),
    '',
    'Approved decisions from previous work:',
    ...decisionLines,
    '',
    'Documents and deliverables from previous work (local copies in this folder):',
    ...artifactLines,
  ].join('\n');

  const files: RenderedInstructionCopy[] = [
    { path: BRAND_MEMORY_FILE, content: catalogMarkdown(snapshot) },
    ...snapshot.artifacts
      .filter((a): a is InheritedArtifact & { localPath: string; copyBody: string } => a.localPath !== null && a.copyBody !== null)
      .map((a) => ({ path: a.localPath, content: wrapCopy(snapshot, a) })),
  ];

  return { body, files, truncated };
}
