import type { DocumentState, DocumentStatus, FunnelStage, WorkDocument } from '../shared/contracts';
export const STAGES: FunnelStage[] = ['discovery','consideration','conversion','retention'];
export const STAGE_LABEL: Record<FunnelStage | 'unclassified', string> = {discovery:'Descubrimiento',consideration:'Consideración',conversion:'Conversión',retention:'Retención',unclassified:'Sin clasificar'};
export const STATUS_LABEL: Record<DocumentStatus,string> = {draft:'Borrador',review:'En revisión',approved:'Aprobado'};
export function filterDocuments(documents: WorkDocument[], filters: {query:string;stage:FunnelStage|'all'|'unclassified';status:DocumentStatus|'all'}) {
 const query=filters.query.trim().toLocaleLowerCase();
 return documents.filter(d=>(!query || `${d.title} ${d.fileName}`.toLocaleLowerCase().includes(query)) && (filters.stage==='all' || (filters.stage==='unclassified' ? !d.funnelStages?.length : d.funnelStages?.includes(filters.stage))) && (filters.status==='all'||d.status===filters.status));
}
export function groupByStage(documents: WorkDocument[]) {
 const groups: Record<FunnelStage|'unclassified',WorkDocument[]>={discovery:[],consideration:[],conversion:[],retention:[],unclassified:[]};
 for(const d of documents) {const stages=[...new Set(d.funnelStages??[])];if(!stages.length)groups.unclassified.push(d);else for(const stage of stages)groups[stage]?.push(d);}
 return groups;
}
export function reviewReasons(document: WorkDocument, outdated: boolean) {return [...(document.status==='review'?['En revisión']:[]),...(outdated?['Base desactualizada']:[])];}
/**
 * Whether this document is asking for a look, from the two facts that say so:
 * it is waiting for review, or the base it was derived from moved underneath.
 *
 * `reviewReasons` explains the same two facts as copy; this one answers the
 * yes/no question, so a count and a reason list can never disagree.
 */
export function needsReview(document: WorkDocument, outdated: boolean) {return document.status==='review' || outdated;}
/** How many of these documents need a look, from the states already loaded for them. */
export function countNeedingReview(documents: WorkDocument[], states: Record<string, DocumentState>) {return documents.filter(d => needsReview(d, states[d.id]?.baseOutdated ?? false)).length;}
