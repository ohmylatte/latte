import { describe, expect, it } from 'vitest';
import { countNeedingReview, filterDocuments, groupByStage, needsReview, reviewReasons } from './document-organizer';
import type { DocumentState, WorkDocument } from '../shared/contracts';
const doc = (patch: Partial<WorkDocument> = {}): WorkDocument => ({ id:'a',workId:'w',kind:'note',title:'Una campaña con nombre completo',fileName:'oferta.md',status:'draft',funnelStages:[],proposedFunnelStages:[],baseDocumentId:null,baseRevisionId:null,baseFingerprint:null,createdAt:'',updatedAt:'',...patch });
describe('document organizer',()=>{
 it('searches full title and file case-insensitively with intersecting filters',()=>{const d=doc({funnelStages:['conversion']});expect(filterDocuments([d],{query:'NOMBRE COMPLETO',stage:'conversion',status:'draft'})).toEqual([d]);expect(filterDocuments([d],{query:'OFERTA.MD',stage:'all',status:'approved'})).toEqual([]);});
 it('groups multi-stage references once per stage and leaves legacy unclassified',()=>{const d=doc({funnelStages:['discovery','conversion','conversion']});const groups=groupByStage([d,doc({id:'b',funnelStages:undefined})]);expect(groups.discovery).toEqual([d]);expect(groups.conversion).toEqual([d]);expect(groups.unclassified.map(x=>x.id)).toEqual(['b']);expect(groups.discovery[0]).toBe(groups.conversion[0]);});
  it('separates review status from changed dependency, as message keys ready for translation',()=>{expect(reviewReasons(doc({status:'review'}),true)).toEqual(['status.review','review.outdated']);expect(reviewReasons(doc({status:'approved'}),true)).toEqual(['review.outdated']);expect(reviewReasons(doc(),false)).toEqual([]);});
});
describe('what needs review',()=>{
  const state = (baseOutdated: boolean): DocumentState => ({documentId:'a',fingerprint:'fp',modifiedAt:null,baseOutdated});
  it('is true for a document in review, with or without a stale base',()=>{
    expect(needsReview(doc({status:'review'}),false)).toBe(true);
    expect(needsReview(doc({status:'review'}),true)).toBe(true);
  });
  it('is true for a stale base even when the document is approved',()=>{
    expect(needsReview(doc({status:'approved'}),true)).toBe(true);
  });
  it('is false for a draft whose base still matches',()=>{
    expect(needsReview(doc({status:'draft'}),false)).toBe(false);
    expect(needsReview(doc({status:'approved'}),false)).toBe(false);
  });
  it('counts the documents whose own status or whose base asks for a look',()=>{
    const documents = [
      doc({id:'a',status:'review'}),
      doc({id:'b',status:'approved'}),
      doc({id:'c',status:'draft'}),
      doc({id:'d'}),
    ];
    const states: Record<string, DocumentState> = { a: state(false), b: state(true), c: state(false) };
    expect(countNeedingReview(documents,states)).toBe(2);
    expect(countNeedingReview([],{})).toBe(0);
    expect(countNeedingReview(documents,{})).toBe(1);
  });
});
