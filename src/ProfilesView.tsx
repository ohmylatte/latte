import { translate as t } from './i18n';
import { useEffect, useState } from 'react';
import { Copy, Plus, Save, Users } from 'lucide-react';
import type { AgentProfile, ProfileInput } from '../shared/contracts';
import { api, isDesktop } from './browser-api';
import { AvatarPicker } from './coordination/AvatarPicker';
const empty:ProfileInput={id:'',name:'',initial:'',summary:'',soul:'',skills:'',avatar:null};
export function ProfilesView({onChanged,onError,onNotice,onDirtyChange}:{onChanged:()=>void;onError:(text:string)=>void;onNotice:(text:string)=>void;onDirtyChange:(dirty:boolean)=>void}) {
 const [profiles,setProfiles]=useState<AgentProfile[]>([]),[selected,setSelected]=useState<AgentProfile|null>(null),[draft,setDraft]=useState<ProfileInput|null>(null),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 /**
  * LA SEMILLA DE UN PERFIL QUE TODAVIA NO TIENE ID.
  *
  * El picker colgaba del id, y el id de un perfil nuevo arranca VACIO: se
  * abria el formulario y no habia ninguna cara para elegir hasta escribir
  * algo. Ahora cada formulario nuevo trae su propia semilla, y esa semilla
  * NO cambia cuando despues aparece el id: la cara que ya elegiste no se
  * reescribe sola debajo del cursor.
  */
 const [nonce,setNonce]=useState(()=>Math.random().toString(36).slice(2));
 const freshForm=()=>setNonce(Math.random().toString(36).slice(2));
 useEffect(()=>{let live=true;void api.listProfiles().then(p=>{if(live)setProfiles(p);}).catch(e=>onError(String(e))).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[]);
 useEffect(()=>{onDirtyChange(dirty);},[dirty]);
 const allowed=()=>!busy&&(!dirty||window.confirm(t('ui.auto.207')));
 const pick=(p:AgentProfile|null)=>{if(!allowed())return;freshForm();setSelected(p);setDraft(p?{id:p.id,name:p.name,initial:p.initial,summary:p.summary,soul:p.soul,skills:p.skills,avatar:p.avatar}:{...empty});setDirty(false);};
 const change=(key:keyof ProfileInput,value:string)=>{setDraft(d=>d?{...d,[key]:value}:d);setDirty(true);};
 const clone=()=>{if(!selected||selected.error||!allowed())return;// Una copia es OTRO rol: se lleva el alma y las skills, no la cara. El
 // avatar se deriva de su id nuevo apenas lo escriba.
 freshForm();setDraft({id:'',name:selected.name+' · copia',initial:selected.initial,summary:selected.summary,soul:selected.soul,skills:selected.skills,avatar:null});setSelected(null);setDirty(true);};
 const save=async()=>{if(!draft||busy)return;setBusy(true);try{const p=await api.saveProfile(draft,selected?.fingerprint??null);setSelected(p);setDraft({id:p.id,name:p.name,initial:p.initial,summary:p.summary,soul:p.soul,skills:p.skills,avatar:p.avatar});setDirty(false);setProfiles(await api.listProfiles());onChanged();onNotice(t('ui.auto.208'));}catch(e){onError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
 const readonly=selected?.source==='builtin'||Boolean(selected?.error);
 /**
  * La cara de un rol INCLUIDO se elige igual, y se guarda al instante.
  *
  * El resto del formulario es de solo lectura porque el comportamiento de
  * un rol del pack es del programa. La cara no: es identidad, y esa la elige
  * quien usa Latte. Va por su propio canal —un override de instalacion que
  * sobrevive a una actualizacion— y no por el guardado del perfil, que para
  * un builtin ni siquiera existe. Sin boton: no hay un borrador que confirmar,
  * hay una eleccion.
  */
 const chooseBuiltinAvatar=async(avatar:string)=>{if(!selected||busy)return;setBusy(true);try{await api.setRoleAvatar(selected.id,avatar);setDraft(d=>d?{...d,avatar}:d);setSelected(s=>s?{...s,avatar}:s);setProfiles(await api.listProfiles());onChanged();onNotice(t('ui.auto.208'));}catch(e){onError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
 // A disabled save with no reason is a dead end: the shipped assistant has no SOUL,
 // so cloning it always lands here. Name what is missing.
 const missing=draft?([['Identificador',draft.id],['Nombre',draft.name],['Inicial',draft.initial],['Resumen',draft.summary],['SOUL.md',draft.soul]] as const).filter(([,value])=>!value.trim()).map(([label])=>label):[];
 return <section className="settings-section profiles-section"><div className="profiles-heading"><div><h2>Perfiles</h2><p className="settings-lead">{t('ui.auto.209')}</p></div><button onClick={()=>pick(null)} disabled={busy}><Plus size={15}/>{t('ui.auto.210')}</button></div><p className="profile-disclaimer">{isDesktop?t('ui.auto.211'):t('ui.auto.212')}</p><div className="profiles-layout"><nav className="profile-list" aria-label="Perfiles disponibles">{loading&&<p>Cargando perfiles…</p>}{profiles.map(p=><button key={p.id} className={selected?.id===p.id?'selected':''} onClick={()=>pick(p)} disabled={busy}><Users size={16}/><span><strong>{p.name}</strong><small>{p.source==='builtin'?'Incluido · solo lectura':'Propio'} · {p.id}</small></span></button>)}</nav><div className="profile-editor">{!draft?<div className="profile-placeholder"><Users size={30}/><h3>{t('ui.auto.213')}</h3><p>{t('ui.auto.214')}</p></div>:<><div className="profile-editor-heading"><h3>{selected?selected.name:t('ui.auto.210')} {dirty&&<small>{t('ui.auto.131')}</small>}</h3>{selected&&!selected.error&&<button onClick={clone} disabled={busy}><Copy size={14}/>{t('ui.auto.215')}</button>}</div>{selected?.error&&<p role="alert" className="explorer-warning">{t('ui.auto.216')} {selected.error}{t('ui.auto.217')}</p>}{selected?.directory&&<p className="profile-location"><code>{selected.directory}</code><br/>SOUL.md · SKILL.md · profile.json</p>}<div className="profile-form-grid"><label htmlFor="profile-id">Identificador<input id="profile-id" value={draft.id} disabled={Boolean(selected)||busy} maxLength={48} placeholder="growth-strategist" onChange={e=>change('id',e.target.value)}/></label><label htmlFor="profile-initial">Inicial<input id="profile-initial" value={draft.initial} disabled={readonly||busy} maxLength={4} onChange={e=>change('initial',e.target.value)}/></label></div><AvatarPicker roleId={selected?selected.id:draft.id.trim()||`nuevo-${nonce}`} name={draft.name||draft.id||t('ui.auto.210')} value={draft.avatar??null} disabled={busy||Boolean(selected?.error)} onChange={value=>{if(readonly){void chooseBuiltinAvatar(value);return;}setDraft(d=>d?{...d,avatar:value}:d);setDirty(true);}}/><label htmlFor="profile-name">{t('ui.auto.380')}<input id="profile-name" value={draft.name} disabled={readonly||busy} maxLength={80} onChange={e=>change('name',e.target.value)}/></label><label htmlFor="profile-summary">Resumen<input id="profile-summary" value={draft.summary} disabled={readonly||busy} maxLength={500} onChange={e=>change('summary',e.target.value)}/></label><label htmlFor="profile-soul">SOUL.md · Responsabilidad y personalidad<textarea id="profile-soul" value={draft.soul} readOnly={readonly} disabled={busy} maxLength={100000} placeholder={t('ui.auto.218')} onChange={e=>change('soul',e.target.value)}/></label><label htmlFor="profile-skills">SKILL.md · Procedimientos e instrucciones<textarea id="profile-skills" value={draft.skills} readOnly={readonly} disabled={busy} maxLength={100000} placeholder={t('ui.auto.219')} onChange={e=>change('skills',e.target.value)}/></label><p className="footnote">{t('ui.auto.220')}</p>{!readonly&&<>{missing.length>0&&<p role="status" className="footnote profile-missing">{t('ui.auto.221')} {missing.join(', ')}.</p>}<button className="primary" disabled={busy||!dirty||missing.length>0} onClick={()=>void save()}><Save size={15}/>{t('ui.auto.222')}</button></>}</>}</div></div></section>;
}
