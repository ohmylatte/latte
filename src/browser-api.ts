import { composeBrandContext } from '../shared/brandContext';
import type { AgentRole, Brand, BrandContextProposal, BrandContextRevision, BrandContextStatus, Work, Revision, Decision, LatteAPI, WorkDocument, DocumentContent, SaveOutcome, AgentProfile, ProfileInput, OnboardingDraft } from '../shared/contracts';
import { isOnboardingDraft } from '../shared/contracts';
import { createAgentBus } from './agent-events';
import { createChatStore } from './chat-store';

const KEY = 'latte-preview-v1';
const initialBrief = '# Una nueva forma de habitar.\n\n_Brief de lanzamiento · Casa Oliva_\n\n## 01 / Objetivo\nPresentar la nueva colección a una audiencia que valora el diseño y la vida cotidiana.\n\n## 02 / Audiencia\nPersonas que eligen menos objetos, con más intención.\n\n## 03 / Propuesta\nDiseño que acompaña tu manera de vivir.\n\n> Hipótesis de ejemplo: contrastar con entrevistas antes de dar por validada.\n\n## 04 / Próximos pasos\n- [ ] Incorporar entrevistas reales\n- [ ] Revisar la propuesta de valor\n- [ ] Definir el primer experimento';
interface Store { brands: Brand[]; works: Work[]; revisions: Revision[]; decisions: Decision[]; brandContextProposals?: BrandContextProposal[]; brandContextRevisions?: BrandContextRevision[]; documents?: WorkDocument[]; contents?: Record<string,string>; profiles?: AgentProfile[]; onboardingComplete?: boolean; onboardingDraft?: string }
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
function read(): Store {
  const raw = localStorage.getItem(KEY);
  const store: Store = raw
    ? JSON.parse(raw)
    : { brands: [{ id: 'demo', name: 'Casa Oliva · Ejemplo', context: 'Marca ficticia de objetos de diseño. Tono cálido, preciso y cercano. Este espacio contiene material de demostración, no investigación real.', createdAt: now(), archivedAt: null }], works: [{ id: 'demo-work', brandId: 'demo', title: 'Lanzamiento primavera', brief: initialBrief, folder: null, updatedAt: now() }], revisions: [], decisions: [], brandContextProposals: [] };
  // A work written before out-of-scope stages existed reads as "nothing parked".
  store.works = (store.works ?? []).map((w) => ({ ...w, outOfScopeStages: w.outOfScopeStages ?? [] }));
  return store;
}
function change<T>(fn: (store: Store) => T): T { const s = read(); const result = fn(s); localStorage.setItem(KEY, JSON.stringify(s)); return result; }
/**
 * The preview's context fingerprint. The desktop hashes with sha256; here the
 * field only has to be opaque and stable, and comparing the exact text means a
 * collision can never turn a refused write into an accepted one.
 */
const contextFingerprint = (text: string): string => 'web:' + text.normalize('NFC').trim();
/** The same refusals the backend sends, with a code the view can act on. */
const contextError = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const previewRefresh = () => ({ updated: [], unchanged: [], live: [], userOwned: [] });
function recordRevision(s: Store, brand: Brand, next: string, source: BrandContextRevision['source'], origin: string | null): void {
  s.brandContextRevisions ??= [];
  if (next === brand.context) return;
  const createdAt = now();
  // Same rule as the backend: the first change of an existing context keeps the
  // value it replaced, so a wipe is recoverable even in the preview.
  if (brand.context.trim().length > 0 && !s.brandContextRevisions.some(r => r.brandId === brand.id)) {
    s.brandContextRevisions.push({ id: id(), brandId: brand.id, source: 'human', origin: null, content: brand.context, fingerprint: contextFingerprint(brand.context), createdAt });
  }
  s.brandContextRevisions.push({ id: id(), brandId: brand.id, source, origin, content: next, fingerprint: contextFingerprint(next), createdAt });
}
/** The web preview tracks a single brief document per work; the real model lives on the desktop. */
const previewDocId = (workId: string) => 'doc-' + workId;
const previewDocument = (w: Work): WorkDocument => ({ id: previewDocId(w.id), workId: w.id, kind: 'brief', title: w.title, fileName: 'brief.md', status: 'draft', funnelStages: [], proposedFunnelStages: [], baseDocumentId: null, baseRevisionId: null, baseFingerprint: null, createdAt: w.updatedAt, updatedAt: w.updatedAt });
function normalized(): Store & {documents:WorkDocument[];contents:Record<string,string>;profiles:AgentProfile[]} {
 const s=read();s.documents ??=[];s.contents ??={};s.profiles ??=[];
 for(const w of s.works)if(!s.documents.some(d=>d.id===previewDocId(w.id))){s.documents.push(previewDocument(w));s.contents[previewDocId(w.id)]=w.brief;}
 s.documents=s.documents.map(d=>({...d,funnelStages:d.funnelStages??[]}));
 return s as Store & {documents:WorkDocument[];contents:Record<string,string>;profiles:AgentProfile[]};
}
function mutate<T>(fn:(s:ReturnType<typeof normalized>)=>T):T {const s=normalized();const result=fn(s);localStorage.setItem(KEY,JSON.stringify(s));return result;}
const fingerprint=(text:string)=>text; // exact local comparison, including same-length edits
function contentFrom(s:ReturnType<typeof normalized>,documentId:string):DocumentContent {
 const d=s.documents.find(d=>d.id===documentId);if(!d)throw new Error('Documento no encontrado');
 return {document:d,content:s.contents[d.id]??'',fingerprint:fingerprint(s.contents[d.id]??''),modifiedAt:null,baseOutdated:Boolean(d.baseDocumentId && d.baseFingerprint!==fingerprint(s.contents[d.baseDocumentId]??''))};
}
const previewContent=async(documentId:string)=>contentFrom(normalized(),documentId);
function revision(s:ReturnType<typeof normalized>,documentId:string,content:string):Revision {const d=contentFrom(s,documentId).document;const r:Revision={id:id(),workId:d.workId,documentId,content,createdAt:now(),source:'human'};s.revisions.push(r);return r;}
// The tiers mirror the shipped pack, so the preview shows the same default effort per role as the desktop.
const shippedRoles:AgentRole[] = [
 {id:'assistant',name:'Asistente',initial:'A',summary:'Trabaja el brief con vos sin un rol fijo.',builtin:true,tier:'balanced'},
 {id:'strategist',name:'Strategist',initial:'S',summary:'Compara opciones y documenta decisiones.',builtin:false,tier:'deep'},
 {id:'researcher',name:'Researcher',initial:'R',summary:'Contrasta evidencia y fuentes.',builtin:false,tier:'light'},
 {id:'analyst',name:'Analyst',initial:'A',summary:'Interpreta datos y explicita límites.',builtin:false,tier:'balanced'},
 {id:'paid-media',name:'Paid Media',initial:'P',summary:'Analizá campañas, inversión y resultados con evidencia; priorizá acciones sin modificar cuentas por tu cuenta.',builtin:false,tier:'balanced'},
 {id:'sales-copywriter',name:'Sales Copywriter',initial:'C',summary:'Convertí briefs en copy de venta listo para usar, con una promesa defendible, prueba real y un CTA claro.',builtin:false,tier:'balanced'},
 {id:'reviewer',name:'Reviewer',initial:'V',summary:'Revisa entregables contra el brief.',builtin:false,tier:'light'},
];
const builtinProfiles:AgentProfile[]=shippedRoles.map(r=>({...r,soul:r.summary,skills:'',source:'builtin',directory:null,fingerprint:'builtin-'+r.id}));
function validateProfile(input:ProfileInput) {
 if(!/^[a-z][a-z0-9-]{0,47}$/.test(input.id)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(input.id))throw new Error('Identificador inválido');
 for(const [key,max] of [['name',80],['initial',4],['summary',500],['soul',100000],['skills',100000]] as const)if(typeof input[key]!=='string'||input[key].length>max || (key!=='skills'&&!input[key].trim()))throw new Error('Perfil inválido: '+key);
}
const unavailable = async (): Promise<never> => { throw new Error('Los agentes reales están disponibles en la aplicación de escritorio. Esta vista es una previsualización local.'); };
// updateWork's refusals, in the language chosen for the interface. Kept here
// and not in i18n.tsx: that module imports this one for that very choice, and
// the preview's data layer does not reach back into the React catalogs.
const UPDATE_WORK_ERRORS = {
  'es-AR': { patch: 'Cambio de trabajo inválido', notFound: 'Trabajo no encontrado', onlyOutcome: 'Solo cambian el resultado esperado y el entregable vinculado', desktop: 'Vincular un entregable requiere la aplicación de escritorio. Esta vista es una previsualización local.', name: 'Nombre de entregable inválido', expected: 'Resultado esperado inválido' },
  'en-US': { patch: 'Invalid work patch', notFound: 'Work not found', onlyOutcome: 'Only the expected output and the linked deliverable can change here', desktop: 'Linking a deliverable requires the desktop app. This view is a local preview.', name: 'Invalid deliverable name', expected: 'Invalid expected output' },
} as const;
const updateWorkError = (key: keyof (typeof UPDATE_WORK_ERRORS)['es-AR']) => new Error(UPDATE_WORK_ERRORS[localStorage.getItem('latte-ui-locale') === 'en-US' ? 'en-US' : 'es-AR'][key]);
export const browserAPI: LatteAPI = {
  getUiLocale: async () => localStorage.getItem('latte-ui-locale') === 'en-US' ? 'en-US' : 'es-AR',
  setUiLocale: async locale => { localStorage.setItem('latte-ui-locale', locale); return locale; },
  getContentLocale: async () => localStorage.getItem('latte-content-locale') === 'en-US' ? 'en-US' : 'es-AR',
  setContentLocale: async locale => { localStorage.setItem('latte-content-locale', locale); return locale; },
  getOnboardingComplete: async () => read().onboardingComplete ?? false,
  setOnboardingComplete: async complete => change(s => { s.onboardingComplete = Boolean(complete); s.onboardingDraft = undefined; return s.onboardingComplete; }),
  getOnboardingDraft: async () => {
    if (read().onboardingComplete) return null;
    const raw = read().onboardingDraft;
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isOnboardingDraft(parsed) ? parsed : null;
    } catch { return null; }
  },
  setOnboardingDraft: async (draft: OnboardingDraft) => {
    if (!isOnboardingDraft(draft)) throw new TypeError('Invalid onboarding draft');
    change(s => { if (!s.onboardingComplete) s.onboardingDraft = JSON.stringify(draft); });
  },
  clearOnboardingDraft: async () => change(s => { s.onboardingDraft = undefined; }),
  appInfo: async () => ({ dataDir: '', engine: 'localStorage (vista previa)', engineReason: 'La vista web no usa SQLite', pack: null, packRoles: 0, version: 'web' }),
  featureFlags: async () => ({ generation: false, brandKits: false, learning: false, coordination: false }),
  listBrands: async () => read().brands.filter(b => !b.archivedAt),
  getBrand: async brandId => {
    const b = read().brands.find(x => x.id === brandId);
    if (!b) throw new Error('Brand not found: ' + brandId);
    return b;
  },
  createBrand: async name => change(s => { const b: Brand = { id: id(), name, context: '', createdAt: now(), archivedAt: null }; s.brands.push(b); return b; }),
  updateBrand: async (brandId, context) => change(s => { const b = s.brands.find(b => b.id === brandId)!; b.context = context; return b; }),
  archiveBrand: async brandId => change(s => {
    const b = s.brands.find(b => b.id === brandId); if (!b) throw new Error('Brand not found: ' + brandId);
    if (!b.archivedAt) b.archivedAt = now();
    return b;
  }),
  restoreBrand: async brandId => change(s => {
    const b = s.brands.find(b => b.id === brandId); if (!b) throw new Error('Brand not found: ' + brandId);
    b.archivedAt = null;
    return b;
  }),
  listArchivedBrands: async () => read().brands.filter(b => Boolean(b.archivedAt)),
  listWorks: async brandId => read().works.filter(w => w.brandId === brandId),
  createWork: async (brandId, title) => change(s => {
    const brand = s.brands.find(b => b.id === brandId); if (!brand) throw new Error('Brand not found: ' + brandId);
    if (brand.archivedAt) throw new Error('Brand is archived: ' + brandId);
    const english = localStorage.getItem('latte-content-locale') === 'en-US'; const headings = english ? '\n\n## Goal\n\n## Context\n\n## Next steps\n' : '\n\n## Objetivo\n\n## Contexto\n\n## Próximos pasos\n'; const w: Work = { id: id(), brandId, title, brief: '# ' + title + headings, folder: null, outOfScopeStages: [], updatedAt: now() }; s.works.push(w); return w;
  }),
  // The expected output is real here; a linked result is not: the preview has
  // no Deliverables folder, so it refuses the link instead of faking a file.
  updateWork: async (workId, patch) => {
    // Same shape check as the desktop, before anything reads the patch's keys:
    // null would crash Object.keys, and an array would pass as an empty change.
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw updateWorkError('patch');
    return change(s => {
      const w = s.works.find(w => w.id === workId); if (!w) throw updateWorkError('notFound');
      if (Object.keys(patch).some(k => k !== 'expectedOutput' && k !== 'resultPath')) throw updateWorkError('onlyOutcome');
      // Same contract as desktop: only null or '' clears; anything else must be a file name, and the preview has none to link.
      if (patch.resultPath !== undefined && patch.resultPath !== null && patch.resultPath !== '') throw updateWorkError(typeof patch.resultPath === 'string' ? 'desktop' : 'name');
      if (patch.expectedOutput !== undefined) { if (patch.expectedOutput !== null && (typeof patch.expectedOutput !== 'string' || patch.expectedOutput.length > 2000)) throw updateWorkError('expected'); w.expectedOutput = patch.expectedOutput?.trim() || null; }
      if (patch.resultPath !== undefined) w.resultPath = null;
      w.updatedAt = now(); return w;
    });
  },
  saveBrief: async (workId, brief, baseFingerprint) => browserAPI.saveDocument(previewDocId(workId),brief,baseFingerprint??null),
  listRevisions: async workId => read().revisions.filter(r=>r.workId===workId).reverse(),
  listDocuments: async workId => normalized().documents.filter(d=>d.workId===workId),
  listBrandDocuments: async brandId => {
    const s = normalized();
    const workIds = new Set(s.works.filter(w => w.brandId === brandId).map(w => w.id));
    return s.documents.filter(d => workIds.has(d.workId));
  },
  readDocument: previewContent,
  documentState: async documentId=>{const c=await previewContent(documentId);return {documentId,fingerprint:c.fingerprint,modifiedAt:null,baseOutdated:c.baseOutdated};},
  createDocument: async(workId,kind,title,baseDocumentId)=>mutate(s=>{
    if(!s.works.some(w=>w.id===workId))throw new Error('Trabajo no encontrado');
    const base=baseDocumentId?contentFrom(s,baseDocumentId):null;
    if(base&&base.document.workId!==workId)throw new Error('La base pertenece a otro trabajo');
    const documentId=id();const d:WorkDocument={id:documentId,workId,kind,title,fileName:kind+'-'+documentId+'.md',status:'draft',funnelStages:[],proposedFunnelStages:[],baseDocumentId:baseDocumentId??null,baseRevisionId:null,baseFingerprint:base?.fingerprint??null,createdAt:now(),updatedAt:now()};
    s.documents.push(d);s.contents[d.id]='# '+title+'\n';return contentFrom(s,d.id);
  }),
  saveDocument: async(documentId,content,baseFingerprint):Promise<SaveOutcome>=>mutate(s=>{const disk=contentFrom(s,documentId);if(baseFingerprint!==null&&baseFingerprint!==disk.fingerprint)return {status:'conflict',document:disk.document,disk,keptRevision:revision(s,documentId,disk.content)};s.contents[documentId]=content;const work=s.works.find(w=>w.id===disk.document.workId)!;if(disk.document.kind==='brief')work.brief=content;work.updatedAt=now();disk.document.updatedAt=now();return {status:'saved',document:disk.document,fingerprint:fingerprint(content),work};}),
  updateDocument: async(documentId,patch)=>mutate(s=>{const d=contentFrom(s,documentId).document;
   if(patch.title!==undefined&&(typeof patch.title!=='string'||!patch.title.trim()||patch.title.length>120))throw new Error('Título inválido');
   if(patch.status!==undefined&&!['draft','review','approved'].includes(patch.status))throw new Error('Estado inválido');
   if(patch.funnelStages!==undefined&&(!Array.isArray(patch.funnelStages)||patch.funnelStages.length>4||patch.funnelStages.some(x=>!['discovery','consideration','conversion','retention'].includes(x))))throw new Error('Etapa inválida');
   if(patch.title!==undefined)d.title=patch.title.trim();if(patch.status!==undefined)d.status=patch.status;if(patch.funnelStages!==undefined)d.funnelStages=[...new Set(patch.funnelStages)];d.updatedAt=now();return d;
  }),
  toggleOutOfScopeStage: async (workId, stage) => change(s => {
    const w = s.works.find(w => w.id === workId);
    if (!w) throw new Error('Trabajo no encontrado');
    if (!['discovery', 'consideration', 'conversion', 'retention'].includes(stage)) throw new Error('Etapa inválida');
    const current = w.outOfScopeStages ?? [];
    w.outOfScopeStages = current.includes(stage) ? current.filter(x => x !== stage) : [...current, stage];
    w.updatedAt = now();
    return w;
  }),
  snapshotDocument: async documentId=>mutate(s=>revision(s,documentId,contentFrom(s,documentId).content)),
  listDocumentRevisions: async documentId=>read().revisions.filter(r=>r.documentId===documentId).reverse(),
  exportDocument: async documentId=>{const c=await previewContent(documentId);const url=URL.createObjectURL(new Blob([c.content],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=c.document.fileName;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return a.download;},
  keepDraftAsVersion: async(documentId,content)=>mutate(s=>revision(s,documentId,content)),
  listUntrackedFiles: async()=>[],listFolderEntries:async()=>({subfolders:[],otherFiles:[],truncated:false}),revealWorkFolder:unavailable,importFiles:unavailable,
  // There is no work folder in the browser: the deliverables of a work are
  // files on the machine that runs the agent, so the preview lists none and
  // refuses the actions instead of pretending it can reach a disk.
  listDeliverables:async()=>({files:[],truncated:false}),openDeliverable:unavailable,revealDeliverable:unavailable,copyDeliverable:unavailable,
listHandoffs:async()=>[],dismissHandoff:unavailable,listSkills:async()=>[],setSkillEnabled:unavailable,listSkillCandidates:async()=>[],approveSkillCandidate:unavailable,rejectSkillCandidate:unavailable,promoteSkillCandidate:unavailable,applyFunnelProposal:unavailable,dismissFunnelProposal:unavailable,trackFile:unavailable,
  saveAsDocument:async(workId,kind,title,content)=>{const c=await browserAPI.createDocument(workId,kind,title);await browserAPI.saveDocument(c.document.id,content,c.fingerprint);return c.document;},
  getWorkPermissions:async()=>'ask' as const,setWorkPermissions:unavailable,
  readAgencyProfile:unavailable,saveAgencyProfile:unavailable,importBrandKit:unavailable,publishBrandKit:unavailable,revokeBrandKit:unavailable,importAgencyKit:unavailable,publishAgencyKit:unavailable,setWorkBrandChoice:unavailable,readWorkBrandContext:unavailable,prepareGeneration:unavailable,
  acknowledgeBase:async documentId=>mutate(s=>{const d=contentFrom(s,documentId).document;if(d.baseDocumentId)d.baseFingerprint=contentFrom(s,d.baseDocumentId).fingerprint;return d;}),
  useFolder: unavailable,
  snapshot: async workId => change(s => { const r: Revision = { id: id(), workId, documentId: previewDocId(workId), source: 'human', content: s.works.find(w => w.id === workId)!.brief, createdAt: now() }; s.revisions.push(r); return r; }),
  listDecisions: async workId => read().decisions.filter(d => d.workId === workId),
  listBrandDecisions: async brandId => {
    const s = read();
    const workIds = new Set(s.works.filter(w => w.brandId === brandId).map(w => w.id));
    return s.decisions.filter(d => workIds.has(d.workId));
  },
  addDecision: async (workId, text) => change(s => { const createdAt=now(); const d:Decision = { id:id(),workId,text,rationale:'',alternativesRejected:[],evidenceRefs:[],status:'approved',source:{chatId:null,messageId:null,memberId:null,roleId:null,runtime:null},clientRequestId:null,fingerprint:'',createdAt,decidedAt:createdAt }; s.decisions.push(d); return d; }),
  getDecisionAuthority:async workId=>(localStorage.getItem('latte:decision-authority:'+workId) as 'off'|'suggest'|'auto-record'|null)??'suggest',
  setDecisionAuthority:async(workId,mode)=>{localStorage.setItem('latte:decision-authority:'+workId,mode);return mode;},
  // Coordination is a desktop-only feature (real runtime processes, a loopback
  // MCP server); the preview has neither, so it reports the safe defaults and
  // refuses writes, exactly like getWorkPermissions/setWorkPermissions above.
  getCoordinationAuthority:async()=>'manual' as const,setCoordinationAuthority:unavailable,
  getCoordinationBudget:async()=>({state:'unset'}),setCoordinationBudget:unavailable,
  getCoordinatorGrant:async()=>null,setCoordinatorGrant:unavailable,
  // Phase 3: run lifecycle, gates, bitácora, asks and the handoff bridge —
  // same desktop-only reasoning as above. No run ever exists in the preview.
  startCoordinationRun:unavailable,pauseCoordinationRun:unavailable,resumeCoordinationRun:unavailable,cancelCoordinationRun:unavailable,
  getCoordinationRun:async()=>null,listCoordinationGates:async()=>[],resolveCoordinationGate:unavailable,listCoordinationLog:async()=>[],listOpenCoordinationAsks:async()=>[],answerCoordinationAsk:unavailable,
  acceptHandoffAsTask:async()=>({bridged:false,task:null}),
  // Task 3.19: manual settlement is desktop-only too — same reasoning as the
  // rest of this section, no run and no dispatch ever exist in the preview.
  settleCoordinationDispatch:unavailable,
  // Phase 6 (tasks 6.33-6.37): same desktop-only reasoning — no real
  // runtime process, no loopback MCP server, no coordination event ever
  // fires in the browser preview.
  coordinationRuntimeSupport:async()=>[],listActiveCoordinationRuns:async()=>[],
  getCoordinationGlobalBudget:async()=>({state:'unset'}),setCoordinationGlobalBudget:unavailable,markCoordinationSeen:unavailable,
  onCoordinationEvent:()=>()=>{},
  approveDecision:async(decisionId,edited)=>change(s=>{const d=s.decisions.find(x=>x.id===decisionId)!;d.status='approved';if(edited)d.text=edited;d.decidedAt=now();return d;}),
  rejectDecision:async decisionId=>change(s=>{const d=s.decisions.find(x=>x.id===decisionId)!;d.status='rejected';d.decidedAt=now();return d;}),
  archiveDecision:async decisionId=>change(s=>{const d=s.decisions.find(x=>x.id===decisionId)!;d.status='archived';d.decidedAt=now();return d;}),
  listBrandContextProposals: async brandId => {
    const s = read();
    const brand = s.brands.find(b => b.id === brandId);
    return (s.brandContextProposals ?? []).filter(p => p.brandId === brandId).map(p => ({ ...p, stale: Boolean(brand && p.baseFingerprint && p.baseFingerprint !== brand.context) }));
  },
  brandContextStatus: async brandId => {
    const s = read();
    const brand = s.brands.find(b => b.id === brandId); if (!brand) throw new Error('Brand not found: ' + brandId);
    const proposals = (s.brandContextProposals ?? []).filter(p => p.brandId === brandId).map(p => ({ ...p, stale: Boolean(p.baseFingerprint && p.baseFingerprint !== brand.context) }));
    const works = s.works.filter(w => w.brandId === brandId);
    const status: BrandContextStatus = {
      brandId,
      fingerprint: contextFingerprint(brand.context),
      pending: proposals.find(p => p.status === 'pending') ?? null,
      proposals,
      works: works.map(w => ({ id: w.id, title: w.title, live: false })),
      ownerWorkId: works.map(w => w.id).sort()[0] ?? null,
      revisions: (s.brandContextRevisions ?? []).filter(r => r.brandId === brandId).slice().reverse(),
    };
    return status;
  },
  // The preview has no instruction files: the report is empty and the notice
  // stays the plain "saved" line. The desktop reports what each work got.
  saveBrandContext: async (brandId, context, expectedFingerprint) => change(s => {
    const b = s.brands.find(x => x.id === brandId); if (!b) throw new Error('Brand not found: ' + brandId);
    if (expectedFingerprint != null && expectedFingerprint !== contextFingerprint(b.context)) throw contextError('CONTEXT_STALE', 'Brand context changed since it was loaded');
    const next = context.trim().normalize('NFC');
    if (next.length === 0) throw contextError('CONTEXT_EMPTY', 'Brand context cannot be emptied by a save');
    recordRevision(s, b, next, 'human', null);
    b.context = next;
    return { brand: b, refresh: previewRefresh() };
  }),
  clearBrandContext: async (brandId, expectedFingerprint) => change(s => {
    const b = s.brands.find(x => x.id === brandId); if (!b) throw new Error('Brand not found: ' + brandId);
    if (expectedFingerprint != null && expectedFingerprint !== contextFingerprint(b.context)) throw contextError('CONTEXT_STALE', 'Brand context changed since it was loaded');
    recordRevision(s, b, '', 'clear', null);
    b.context = '';
    return { brand: b, refresh: previewRefresh() };
  }),
  listBrandContextRevisions: async brandId => (read().brandContextRevisions ?? []).filter(r => r.brandId === brandId).slice().reverse(),
  restoreBrandContextRevision: async (brandId, revisionId, expectedFingerprint) => change(s => {
    const b = s.brands.find(x => x.id === brandId); if (!b) throw new Error('Brand not found: ' + brandId);
    if (expectedFingerprint != null && expectedFingerprint !== contextFingerprint(b.context)) throw contextError('CONTEXT_STALE', 'Brand context changed since it was loaded');
    const revision = (s.brandContextRevisions ?? []).find(r => r.id === revisionId && r.brandId === brandId);
    if (!revision) throw new Error('Revisión no encontrada');
    recordRevision(s, b, revision.content, 'restore', revision.id);
    b.context = revision.content;
    return { brand: b, refresh: previewRefresh() };
  }),
  approveBrandContextProposal: async (proposalId, edited, acceptStale = false) => change(s => {
    s.brandContextProposals ??= [];
    const p = s.brandContextProposals.find(x => x.id === proposalId); if (!p) throw new Error('Propuesta no encontrada');
    const brand = s.brands.find(b => b.id === p.brandId); if (!brand) throw new Error('Brand not found: ' + p.brandId);
    if (brand.archivedAt) throw new Error('Brand is archived: ' + brand.id);
    const report = { updated: [], unchanged: [], live: [], userOwned: [] };
    if (p.status === 'approved') return { proposal: p, brand, refresh: report };
    if (p.status !== 'pending') throw new Error('La propuesta ya no está pendiente');
    if (edited != null) p.text = edited;
    const composed = composeBrandContext(brand.context, p.text, p.mode);
    if (composed.length > 60_000) throw new Error(`Brand context is ${composed.length - 60_000} characters over the 60000-character limit`);
    if (!acceptStale && p.baseFingerprint && p.baseFingerprint !== brand.context) throw new Error('Brand context changed since this proposal');
    p.status = 'approved'; p.decidedAt = now(); p.decidedReason = 'approved';
    recordRevision(s, brand, composed, 'proposal', p.id);
    brand.context = composed;
    return { proposal: p, brand, refresh: report };
  }),
  rejectBrandContextProposal: async proposalId => change(s => {
    s.brandContextProposals ??= [];
    const p = s.brandContextProposals.find(x => x.id === proposalId); if (!p) throw new Error('Propuesta no encontrada');
    const brand = s.brands.find(b => b.id === p.brandId); if (!brand) throw new Error('Brand not found: ' + p.brandId);
    if (brand.archivedAt) throw new Error('Brand is archived: ' + p.brandId);
    const report = { updated: [], unchanged: [], live: [], userOwned: [] };
    if (p.status === 'rejected') return { proposal: p, brand, refresh: report };
    if (p.status !== 'pending') throw new Error('La propuesta ya no está pendiente');
    p.status = 'rejected'; p.decidedAt = now(); p.decidedReason = 'rejected';
    return { proposal: p, brand, refresh: report };
  }),
  requestBrandContextDraft: unavailable,
  runtimeStatus: async () => ['claude', 'codex', 'opencode'].map(provider => ({ provider: provider as 'claude' | 'codex' | 'opencode', available: false, detail: 'Requiere escritorio' })),
  startAgent: unavailable, writeAgent: unavailable, resizeAgent: unavailable, stopAgent: unavailable,
  onAgentEvent: () => () => {},
  readMemory: async () => ({ available: false, text: 'Engram se conecta desde la aplicación de escritorio. Esta vista no simula recuerdos.' }),
  saveMemory: unavailable,
  exportWork: async workId => { const w = read().works.find(w => w.id === workId)!; const url = URL.createObjectURL(new Blob([w.brief], { type: 'text/markdown;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = w.title.replace(/[^\p{L}\p{N} -]/gu, '') + '.md'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return a.download; },
  // Structured chat needs the local OpenCode runtime: honest unavailable state in the browser preview.
  chatStatus: async () => ({ available: false, detail: 'El chat con agentes necesita un motor de IA conectado. Esta vista previa no ejecuta agentes.', version: null, models: [], defaultModel: null }),
  startChat: unavailable, listChatMessages: async () => [], sendChat: unavailable, abortChat: unavailable, stopChat: unavailable,
  replyPermission: unavailable, replyQuestion: unavailable,
  onChatEvent: () => () => {},
  reportUnsaved: () => {},
  windowControl: () => {},
  onWindowState: () => () => {},
  listProviders: async () => [], connectProviderKey: unavailable, disconnectProvider: unavailable, startProviderOAuth: unavailable, completeProviderOAuth: unavailable,
  listMcpServers: async () => [], addMcpServer: unavailable, removeMcpServer: unavailable, loginMcpServer: unavailable, authenticateClaudeMcp: unavailable,
  getPrimaryAgent: async () => null, setPrimaryAgent: unavailable, listAgentRuntimes: async () => [], addAgentAccount: unavailable, removeAgentAccount: unavailable, startAccountLogin: unavailable, logoutAccount: unavailable,
  // No CLI to ask in a browser tab: no catalog, and no pretending there is one.
  listAccountModels: async () => ({ source: 'suggested' as const, models: [], detail: 'Esta vista previa no puede consultar los modelos de tu cuenta.' }),
  // The team roster is real only on desktop; the preview shows the roles so the concept is visible.
  listRoles: async()=> (await browserAPI.listProfiles()).map(({id,name,initial,summary,builtin,tier})=>({id,name,initial,summary,builtin,tier})),
  listProfiles:async()=>[...builtinProfiles,...normalized().profiles],
  saveProfile:async(input,expectedFingerprint)=>mutate(s=>{validateProfile(input);if(shippedRoles.some(r=>r.id===input.id))throw new Error('Los perfiles incluidos son de solo lectura');const existing=s.profiles.find(p=>p.id===input.id);if(expectedFingerprint===null?Boolean(existing):!existing||existing.fingerprint!==expectedFingerprint)throw new Error('El perfil cambió o ya existe. Tu borrador sigue intacto; recargá antes de reintentar.');const p:AgentProfile={...input,builtin:false,tier:'balanced',source:'custom',directory:null,fingerprint:id()};s.profiles=s.profiles.filter(p=>p.id!==input.id);s.profiles.push(p);return p;}),
  listTeam: async () => [], addTeamMember: unavailable, openTeamMember: unavailable, pauseTeamMember: unavailable, finishTeamMember: unavailable, restartTeamMember: unavailable, removeTeamMember: unavailable, setTeamMemberModel: unavailable, setTeamMemberTier: unavailable, draftContinuation: unavailable,
  // The web preview is always whatever ohmylatte.app is serving: there is
  // nothing to download and nothing to restart.
  checkForUpdate: async () => ({ phase: 'unsupported' as const, unsupportedKind: 'source' as const, version: null, percent: 0, message: 'Esta es la vista previa web: se actualiza sola al recargar la página.' }),
  downloadUpdate: async () => browserAPI.checkForUpdate(),
  installUpdate: async () => ({ status: 'not-ready' as const }),
  onUpdateState: () => () => {},
};
export const api = window.latte ?? browserAPI;
export const isDesktop = Boolean(window.latte);
/** Global buses, created once so events emitted before a pane mounts are kept. */
export const agentBus = createAgentBus(api);
export const chatStore = createChatStore(api);
