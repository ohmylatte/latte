import { currentLocale, translate as t } from './i18n';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Check, CircleAlert, CircleCheck, FolderCheck, FolderLock, Forward, LoaderCircle, MessageSquare, MessageSquarePlus, Pause, Play, Plug, Plus, Settings2, Trash2, UserPlus, X, Zap } from 'lucide-react';
import { DEFAULT_EFFORT_TIER, EFFORT_TIERS, type AgentModelList, type AgentRole, type WorkPermissionMode, type ChatRuntime, type ChatSession, type EffortTier, type HandoffRequest, type TeamMember, type TeamMemberOptions, type TeamMemberStatus, type Work } from '../shared/contracts';
import { api, chatStore } from './browser-api';
import { ChatPane } from './ChatPane';
import { useChatState } from './chat-store';
import { canChangePermission } from './permission-ux';
import { continuationModel, continuationOptions, type ContinuationTarget } from './provider-models';
import { contextWeight, describeUsage, formatTokens, totalTokens } from './usage-format';
import { roleColorVar, SteamWisp } from './brand-marks';

/** A runtime the user can pick for a new member instead of the primary agent. */
export interface RuntimeChoice { key: string; label: string; runtime: ChatRuntime; accountId: string | null }

export interface TeamPanelProps {
  work: Work | null;
  team: TeamMember[];
  /** Live sessions by chat id (= member id). */
  chats: Record<string, ChatSession>;
  selectedId: string | null;
  roles: AgentRole[];
  primaryLabel: string;
  primaryDetail: string;
  primaryReady: boolean;
  /** The runtimes are still being detected: the list of agents is not empty, it is unknown. */
  checking: boolean;
  /** Runtime the primary agent uses; the folder grant only changes anything for Claude. */
  primaryRuntime: ChatRuntime;
  /** Account of the primary agent, so a continuation can default to a different one. */
  primaryAccountId: string | null;
  /** Model saved for the primary agent: where a continuation on it starts when the source ran on another runtime. */
  primaryModel: string | null;
  choices: RuntimeChoice[];
  busy: boolean;
  isDesktop: boolean;
  onSelect: (memberId: string) => void;
  onAdd: (roleId: string, options: TeamMemberOptions | null) => Promise<void>;
  onOpen: (memberId: string) => Promise<void>;
  onPause: (memberId: string) => Promise<void>;
  onFinish: (memberId: string) => Promise<void>;
  onRestart: (memberId: string) => Promise<void>;
  /** Creates a member that continues another one, with the reviewed hand-over as its first message. Rejects when nothing was created. */
  onContinue: (sourceId: string, roleId: string, options: TeamMemberOptions | null, text: string) => Promise<void>;
  /** Roles one agent asked for; the human decides whether any conversation opens. */
  handoffs: HandoffRequest[];
  onAcceptHandoff: (handoff: HandoffRequest) => Promise<void>;
  onDismissHandoff: (handoff: HandoffRequest) => Promise<void>;
  onRemove: (memberId: string) => Promise<void>;
  onProviders: () => void;
  onRecheck: () => void;
  /** Changes the model of one conversation; the runtime restarts and resumes underneath. */
  onModel: (memberId: string, model: string | null) => void;
  /** Changes how hard one conversation works per answer; same mechanics as onModel. */
  onTier: (memberId: string, tier: EffortTier) => void;
  onError: (message: string) => void;
  /** Turns an answer into a document of the work. */
  onSaveAsDocument?: (text: string) => void;
  /** Copies client material into this work so the active agent can read it. */
  onAttachFiles: () => Promise<string[]>;
  /** Files the agent left in the folder that are not documents yet. */
  untracked: string[];
  onAdoptFile: (fileName: string) => void;
  /** How much this work's team may do without asking. */
  permissions: WorkPermissionMode;
  /** Only the permission mutation is pending; chat activity must not disable this control. */
  permissionBusy: boolean;
  onPermissions: (mode: WorkPermissionMode) => void;
}

const RUNTIME_SHORT: Record<ChatRuntime, string> = { opencode: 'OpenCode', claude: 'Claude', codex: 'Codex' };

/**
 * The work's team: one row per role opened in this work, the selected one's
 * conversation underneath. Status is live for open members (from the chat
 * store) and persisted for the rest (paused / finished).
 */
export function TeamPanel(props: TeamPanelProps) {
  const { work, team, chats, selectedId, roles, busy, isDesktop } = props;
  const [adding, setAdding] = useState(false);
  // Member whose work is being handed over; the dialog stays tied to it.
  const [continuing, setContinuing] = useState<string | null>(null);
  useEffect(() => { setAdding(false); setContinuing(null); }, [work?.id]);
  const selected = team.find(m => m.id === selectedId) ?? null;
  const continuingMember = team.find(m => m.id === continuing) ?? null;
  const liveChat = selected ? chats[selected.id] ?? null : null;
  const selectedState = useChatState(chatStore, liveChat?.id ?? null);
  const selectedLive = Boolean(liveChat) && !selectedState.closed;
  const selectedStatus: TeamMemberStatus = selectedLive ? (selectedState.status === 'idle' ? 'idle' : 'working') : selected?.status === 'ended' ? 'ended' : 'paused';
  const activity = useTeamActivity(team, chats);
  // The first team is the empty state itself; after that, adding is a dialog.
  const firstTeam = team.length === 0 && Boolean(work);
  const showPicker = adding || firstTeam;
  const workTotal = useTeamUsageTotal(team);

  return <div className="team">
    {work && props.handoffs.map(handoff => <div key={handoff.fileName} className="doc-banner handoff" role="status">
      <UserPlus size={14} />
      <span>{t('ui.auto.266')} <strong>{handoff.roleName}</strong> vea esto: <em>{handoff.request.split(/\r?\n/)[0].slice(0, 140)}</em>{handoff.known ? '' : ' — ese rol no existe en Latte.'}</span>
      {handoff.known && <button className="primary" disabled={busy} onClick={() => void props.onAcceptHandoff(handoff)}>{t('ui.auto.267')}</button>}
      <button disabled={busy} onClick={() => void props.onDismissHandoff(handoff)}>{t('ui.auto.379')}</button>
    </div>)}
    {work && team.length > 0 && <>
      <div className="team-tabs" role="tablist" aria-label={t('ui.auto.268')}>
        <div className="team-tab-strip">
          {team.map(member => <MemberTab key={member.id} member={member} chat={chats[member.id] ?? null} selected={member.id === selectedId} busy={busy} onSelect={() => props.onSelect(member.id)} />)}
        </div>
        {activity && <span className={'team-activity' + (activity.needsAttention ? ' attention' : '')} role="status" title={activity.detail}>{activity.label}</span>}
        {workTotal > 0 && <span className="team-usage-total" title={t('usage.help')}>{t('usage.workTotal', { tokens: formatTokens(workTotal, currentLocale()) })}</span>}
        <button className="team-tab-add" aria-label={t('ui.auto.269')} title={t('ui.auto.269')} disabled={busy || !isDesktop} onClick={() => setAdding(true)}><UserPlus size={15} /></button>
        <button className="team-tab-add" aria-label="Proveedores de IA" title="Agentes y proveedores" onClick={props.onProviders}><Settings2 size={15} /></button>
        {selected && <div className="team-tab-actions">
          <ModelPicker member={selected} busy={busy} onModel={props.onModel} />
          <TierPicker tier={selected.tier} busy={busy} compact onChange={tier => props.onTier(selected.id, tier)} />
          <button className="icon-button" aria-label={t('continue.action')} title={t('continue.actionHelp')} disabled={busy || !isDesktop} onClick={() => setContinuing(selected.id)}><Forward size={13} /></button>
          {selectedLive && <button className="icon-button" aria-label={t('ui.auto.087')} title={t('ui.auto.270')} disabled={busy} onClick={() => void props.onPause(selected.id)}><Pause size={13} /></button>}
          {selectedStatus !== 'ended' && <button className="icon-button" aria-label="Marcar como finalizado" title={t('ui.auto.271')} disabled={busy} onClick={() => void props.onFinish(selected.id)}><CircleCheck size={13} /></button>}
          <button className="icon-button" aria-label={t('ui.auto.272')} title={t('ui.auto.273')} disabled={busy} onClick={() => { if (window.confirm(t('ui.auto.401', { p0: selected.roleName, p1: selected.roleName }))) void props.onRestart(selected.id); }}><MessageSquarePlus size={13} /></button>
          <button className="icon-button" aria-label={t('ui.auto.274')} title={t('ui.auto.274')} disabled={busy} onClick={() => { if (window.confirm(t('ui.auto.402', { p0: selected.roleName }))) void props.onRemove(selected.id); }}><Trash2 size={13} /></button>
        </div>}
      </div>
      {selected && <MemberUsage member={selected} />}
    </>}
    {firstTeam && <RolePicker roles={roles} choices={props.choices} primaryLabel={props.primaryLabel} primaryDetail={props.primaryDetail} primaryReady={props.primaryReady} checking={props.checking} busy={busy} isDesktop={isDesktop} canCancel={team.length > 0} onCancel={() => setAdding(false)} onProviders={props.onProviders} onRecheck={props.onRecheck} onAdd={async (roleId, options) => { await props.onAdd(roleId, options); setAdding(false); }} />}
    {adding && !firstTeam && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) setAdding(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="add-member-title" className="modal">
        <div className="modal-head"><div><div className="document-kicker">{t('ui.auto.076')}</div><h2 id="add-member-title">{t('ui.auto.275')}</h2></div><button className="modal-close" aria-label={t('ui.auto.001')} onClick={() => setAdding(false)}><X size={20} /></button></div>
        <div className="modal-body"><RolePicker roles={roles} choices={props.choices} primaryLabel={props.primaryLabel} primaryDetail={props.primaryDetail} primaryReady={props.primaryReady} checking={props.checking} busy={busy} isDesktop={isDesktop} canCancel={false} onCancel={() => setAdding(false)} onProviders={props.onProviders} onRecheck={props.onRecheck} onAdd={async (roleId, options) => { await props.onAdd(roleId, options); setAdding(false); }} /></div>
      </section></div>}
    {continuingMember && <ContinueDialog source={continuingMember} roles={roles} choices={props.choices} primaryLabel={props.primaryLabel} primaryReady={props.primaryReady} primaryRuntime={props.primaryRuntime} primaryAccountId={props.primaryAccountId} primaryModel={props.primaryModel} checking={props.checking} busy={busy} isDesktop={isDesktop} onClose={() => setContinuing(null)} onProviders={props.onProviders} onRecheck={props.onRecheck} onContinue={async (roleId, options, text) => { await props.onContinue(continuingMember.id, roleId, options, text); setContinuing(null); }} />}
    {!work && <div className="agent-idle"><div className="agent-symbol"><MessageSquare size={27} /></div><h3>{t('ui.auto.276')}<br />{t('ui.auto.277')}</h3><p className="footnote">{t('ui.auto.278')}</p></div>}
    {!showPicker && selected && (liveChat ? <ChatPane key={liveChat.id} session={liveChat} onStop={() => void props.onPause(selected.id)} onError={props.onError} onSaveAsDocument={props.onSaveAsDocument} untracked={props.untracked} onAdoptFile={props.onAdoptFile} onAttachFiles={props.onAttachFiles} beforeComposer={<WorkPermissions mode={props.permissions} busy={props.permissionBusy} hasClaude={props.primaryRuntime === 'claude' || team.some(m => m.runtime === 'claude')} isDesktop={isDesktop} onChange={props.onPermissions} />} /> : <ResumeCard member={selected} origin={team.find(m => m.id === selected.continuedFrom) ?? null} busy={busy} isDesktop={isDesktop} onOpen={() => props.onOpen(selected.id)} onRestart={() => props.onRestart(selected.id)} onRemove={() => props.onRemove(selected.id)} onContinue={() => setContinuing(selected.id)} />)}
    {!showPicker && !selected && team.length > 0 && <p className="chat-empty">{t('ui.auto.279')}</p>}
  </div>;
}

/**
 * A compact, live answer to "what is still running?". It deliberately shows
 * activity rather than invented token/cost figures: Latte has no provider-
 * independent cost meter yet, but it can honestly expose which conversations
 * are spending time or waiting on the human.
 */
function useTeamActivity(team: TeamMember[], chats: Record<string, ChatSession>): { label: string; detail: string; needsAttention: boolean } | null {
  const key = useSyncExternalStore(chatStore.subscribe, () => {
    let working = 0;
    let retrying = 0;
    let attention = 0;
    for (const member of team) {
      const chat = chats[member.id];
      if (!chat) continue;
      const state = chatStore.get(chat.id);
      if (state.closed) continue;
      if (state.status === 'busy') working += 1;
      if (state.status === 'retry') retrying += 1;
      if (state.permissions.length > 0 || state.questions.length > 0) attention += 1;
    }
    return `${working}:${retrying}:${attention}`;
  }, () => '0:0:0');
  const [working, retrying, attention] = key.split(':').map(Number);
  if (working === 0 && retrying === 0 && attention === 0) return null;
  const parts = [
    working > 0 ? t('team.activity.working', { count: working }) : null,
    retrying > 0 ? t('team.activity.retrying', { count: retrying }) : null,
    attention > 0 ? t('team.activity.attention', { count: attention }) : null,
  ].filter((part): part is string => part !== null);
  return { label: parts.join(' · '), detail: t('team.activity.detail', { parts: parts.join(', ') }), needsAttention: attention > 0 };
}

/**
 * How much this work's whole team has spent, live. Reads the chat store
 * directly (not `member.usage`) so a turn that just finished shows up without
 * waiting for the team roster to reload.
 */
function useTeamUsageTotal(team: TeamMember[]): number {
  return useSyncExternalStore(chatStore.subscribe, () => {
    let sum = 0;
    for (const member of team) sum += totalTokens(chatStore.get(member.id).usage);
    return sum;
  }, () => 0);
}

/**
 * What the selected member has spent, in plain language and never the word
 * "tokens". Nothing renders before the first turn: there is nothing honest to
 * report yet.
 */
function MemberUsage({ member }: { member: TeamMember }) {
  const state = useChatState(chatStore, member.id);
  const line = describeUsage(state.usage, currentLocale());
  if (!line) return null;
  const heavy = contextWeight(state.usage.contextTokens) === 'heavy';
  return <p className="team-usage" title={t('usage.help')}>
    <span>{t('usage.label')}: {line}</span>
    {heavy && <span className="team-usage-hint">{t('usage.heavyHint')}</span>}
  </p>;
}

/**
 * One grant instead of a prompt per file.
 *
 * Every claim here was measured against a real Claude Code, not assumed: with
 * the folder patterns a write inside the work folder stops asking, a read or
 * write one level up still asks, and every other tool keeps asking. Codex
 * already runs with its workspace writable, so the row only shows up when the
 * team has a member this actually changes something for.
 *
 * It stays one line tall on purpose: the conversation below needs the height
 * more than this does.
 */
const permissionLabel = (mode: WorkPermissionMode) => t(`permission.mode.${mode}` as 'permission.mode.ask');

/**
 * How much this work's team may do without stopping to ask.
 *
 * Three levels, because the middle one is the honest default for writing
 * documents and the last one is a real handover of judgement: in `auto` Latte
 * answers every request itself. It answers *once* each time, never "always",
 * so nothing is written into a runtime's own permission file and going back to
 * asking takes effect on the very next request.
 */
export function WorkPermissions({ mode, busy, hasClaude, isDesktop, onChange }: { mode: WorkPermissionMode; busy: boolean; hasClaude: boolean; isDesktop: boolean; onChange: (mode: WorkPermissionMode) => void }) {
  const pick = (next: WorkPermissionMode) => {
    if (!canChangePermission(mode, next, busy, isDesktop)) return;
    const warning = [
      t('permission.auto.confirmTitle'),
      t('permission.auto.confirmBody'),
      hasClaude ? t('permission.auto.claudeWarning') : '',
      t('permission.auto.confirmAction'),
    ].filter(Boolean).join('\n\n');
    if (next === 'auto' && !window.confirm(warning)) return;
    onChange(next);
  };
  return <details className={'folder-trust mode-' + mode}>
    <summary>
      {mode === 'ask' ? <FolderLock size={13} /> : mode === 'folder' ? <FolderCheck size={13} /> : <Zap size={13} />}
      <span><strong>{permissionLabel(mode)}</strong>{mode === 'auto' && <small>{t('permission.auto.once')}</small>}</span>
      {busy && <LoaderCircle className="spin" size={12} aria-label={t('permission.changing')} />}
    </summary>
    <div className="permission-modes" role="radiogroup" aria-label={t('permission.group')}>
      {(['ask', 'folder', 'auto'] as WorkPermissionMode[]).map(value => <button
        key={value}
        type="button"
        role="radio"
        aria-checked={mode === value}
        aria-label={t('permission.select', { mode: permissionLabel(value) })}
        className={mode === value ? 'selected' : ''}
        disabled={busy || !isDesktop}
        onClick={() => pick(value)}
      >
        <strong>{permissionLabel(value)}</strong>
        <small>{t(`permission.help.${value}` as 'permission.help.ask')}</small>
      </button>)}
    </div>
    {!isDesktop && <p className="permission-preview" role="note">{t('permission.preview')}</p>}
    {mode === 'auto' && hasClaude && <p className="permission-warning">{t('permission.auto.activeWarning')}</p>}
  </details>;
}

export function MemberTab({ member, chat, selected, busy, onSelect }: { member: TeamMember; chat: ChatSession | null; selected: boolean; busy: boolean; onSelect: () => void }) {
  const state = useChatState(chatStore, chat ? chat.id : null);
  const live = Boolean(chat) && !state.closed;
  const status: TeamMemberStatus = live ? (state.status === 'idle' ? 'idle' : 'working') : member.status === 'ended' ? 'ended' : 'paused';
  const attention = live && (state.permissions.length > 0 || state.questions.length > 0);
  return <button role="tab" aria-selected={selected} className={'team-tab status-' + status + (attention ? ' attention' : '')} disabled={busy} onClick={onSelect} title={member.roleName + ' · ' + RUNTIME_SHORT[member.runtime] + ' · ' + statusLabel(status, attention)}>
    <span className="team-avatar" data-role={member.roleId} aria-hidden="true">{member.initial}</span>
    <span className="team-tab-name">{member.roleName}</span>
    {status === 'working' && !attention
      ? <SteamWisp className="team-steam" style={{ color: roleColorVar(member.roleId) }} />
      : <i className="team-tab-dot" aria-hidden="true" />}
    <span className="visually-hidden">{statusLabel(status, attention)}</span>
  </button>;
}

function statusLabel(status: TeamMemberStatus, attention: boolean) {
  if (attention) return <><i className="busy-dot" />Te necesita</>;
  switch (status) {
    case 'working': return <><LoaderCircle className="spin" size={12} />{t('ui.auto.403')}</>;
    case 'idle': return <><i className="live-dot" />{t('ui.auto.404')}</>;
    case 'ended': return <>{t('ui.auto.285')}<CircleCheck size={13} /></>;
    default: return <>En pausa<Pause size={12} /></>;
  }
}

function ResumeCard({ member, origin, busy, isDesktop, onOpen, onRestart, onRemove, onContinue }: { member: TeamMember; origin: TeamMember | null; busy: boolean; isDesktop: boolean; onOpen: () => Promise<void>; onRestart: () => Promise<void>; onRemove: () => Promise<void>; onContinue: () => void }) {
  const [opening, setOpening] = useState(false);
  const open = async () => { setOpening(true); try { await onOpen(); } finally { setOpening(false); } };
  return <div className="agent-idle team-resume">
    <span className="team-avatar large" data-role={member.roleId} aria-hidden="true">{member.initial}</span>
    <h3>{member.roleName}<br /><small>{member.label}</small>{origin && <small>{t('continue.from', { role: origin.roleName })}</small>}</h3>
    <p>{member.status === 'ended' ? t('ui.auto.286') : t('ui.auto.287')}</p>
    <button className="primary" disabled={busy || opening} onClick={() => void open()}>{opening ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{opening ? 'Abriendo…' : member.status === 'ended' ? t('ui.auto.288') : t('ui.auto.289')}</button>
    {/* A paused or finished member is where an exhausted account usually leaves you: continuing elsewhere belongs right here. */}
    <button className="subtle" title={t('continue.actionHelp')} disabled={busy || opening || !isDesktop} onClick={onContinue}><Forward size={13} />{t('continue.action')}</button>
    <button className="subtle" disabled={busy || opening} onClick={() => { if (window.confirm(t('ui.auto.401', { p0: member.roleName, p1: member.roleName }))) void onRestart(); }}><MessageSquarePlus size={13} />{t('ui.auto.272')}</button>
    <button className="subtle" disabled={busy || opening} onClick={() => { if (window.confirm(t('ui.auto.405', { p0: member.roleName }))) void onRemove(); }}><Trash2 size={13} />{t('ui.auto.274')}</button>
  </div>;
}

function RolePicker({ roles, choices, primaryLabel, primaryDetail, primaryReady, checking, busy, isDesktop, canCancel, onCancel, onAdd, onProviders, onRecheck }: { roles: AgentRole[]; choices: RuntimeChoice[]; primaryLabel: string; primaryDetail: string; primaryReady: boolean; checking: boolean; busy: boolean; isDesktop: boolean; canCancel: boolean; onCancel: () => void; onAdd: (roleId: string, options: TeamMemberOptions | null) => Promise<void>; onProviders: () => void; onRecheck: () => void }) {
  const [roleId, setRoleId] = useState(roles[0]?.id ?? 'assistant');
  const [choice, setChoice] = useState('primary');
  const [opening, setOpening] = useState(false);
  // Follows the picked role's own default effort; picking another role resets it,
  // same as the role determines the starting point rather than carrying a stale choice.
  const [tier, setTier] = useState<EffortTier>(() => roles.find(r => r.id === roleId)?.tier ?? DEFAULT_EFFORT_TIER);
  useEffect(() => { setTier(roles.find(r => r.id === roleId)?.tier ?? DEFAULT_EFFORT_TIER); }, [roleId, roles]);
  const picked = choices.find(c => c.key === choice) ?? null;
  const ready = choice === 'primary' ? primaryReady : Boolean(picked);
  const add = async () => {
    if (!ready || opening) return;
    setOpening(true);
    try { await onAdd(roleId, picked ? { runtime: picked.runtime, accountId: picked.accountId, model: null, tier } : { tier }); } finally { setOpening(false); }
  };
  return <div className="role-picker">
    <div className="role-picker-head"><span className="field-label">{canCancel ? t('ui.auto.290') : t('ui.auto.291')}</span>{canCancel && <button className="icon-button" aria-label={t('ui.auto.241')} onClick={onCancel}><X size={15} /></button>}</div>
    <p className="agent-explanation">{t('ui.auto.292')}</p>
    <div className="role-list" role="radiogroup" aria-label="Rol">
      {roles.map(role => <button key={role.id} role="radio" aria-checked={roleId === role.id} className={'role-card' + (roleId === role.id ? ' selected' : '')} onClick={() => setRoleId(role.id)}><span className="team-avatar" data-role={role.id} aria-hidden="true">{role.initial}</span><span><strong>{role.name}</strong><small>{role.summary}</small></span>{roleId === role.id && <Check size={14} />}</button>)}
    </div>
    <TierPicker tier={tier} busy={busy || opening} onChange={setTier} />
    <label className="field-label" htmlFor="member-runtime">{t('ui.auto.293')}</label>
    {/*
      Detecting the runtimes means running their CLIs, and that costs seconds.
      Until it answers, the list is not empty: it is unknown. Saying so beats a
      picker with one option that looks broken.
    */}
    <select id="member-runtime" value={choice} disabled={busy || opening || checking} onChange={e => setChoice(e.target.value)}>
      {checking
        ? <option value="primary">{t('ui.auto.294')}</option>
        : <>
          <option value="primary">{t('ui.auto.295')} {primaryLabel}</option>
          {choices.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
        </>}
    </select>
    {choice === 'primary' && <small className="runtime-detail">{checking ? t('ui.auto.296') : primaryDetail}</small>}
    <div className="chat-card-actions">
      <button className="primary" disabled={busy || opening || checking || !ready || !isDesktop} onClick={() => void add()}>{opening || checking ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{opening ? 'Abriendo…' : checking ? 'Buscando agentes…' : t('ui.auto.297')}</button>
      {isDesktop && !checking && <button className="subtle" onClick={onProviders}><Plug size={13} />{primaryReady ? t('ui.auto.298') : t('ui.auto.299')}</button>}
      {isDesktop && !checking && !primaryReady && <button className="subtle" onClick={onRecheck}>Volver a comprobar</button>}
    </div>
    {!isDesktop && <small className="preview-note">{t('ui.auto.300')}</small>}
  </div>;
}

const displayError = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An agent that can take the work over right now: the primary agent when it is ready, or a logged-in alternative. */
interface ContinueOption extends ContinuationTarget { label: string }
const RUNTIME_NAME: Record<ChatRuntime, string> = { opencode: 'OpenCode', claude: 'Claude Code', codex: 'Codex' };

/**
 * Continue a member's work with another agent or account.
 *
 * Latte writes the hand-over from its own records and the human edits it
 * here, before anything is created or spent. The origin is only read: it keeps
 * its conversation, its account and its status. Only agents that can start
 * now are offered; when there is none the dialog says what is missing and how
 * to fix it instead of offering something that would fail after opening.
 */
function ContinueDialog({ source, roles, choices, primaryLabel, primaryReady, primaryRuntime, primaryAccountId, primaryModel, checking, busy, isDesktop, onClose, onContinue, onProviders, onRecheck }: { source: TeamMember; roles: AgentRole[]; choices: RuntimeChoice[]; primaryLabel: string; primaryReady: boolean; primaryRuntime: ChatRuntime; primaryAccountId: string | null; primaryModel: string | null; checking: boolean; busy: boolean; isDesktop: boolean; onClose: () => void; onContinue: (roleId: string, options: TeamMemberOptions | null, text: string) => Promise<void>; onProviders: () => void; onRecheck: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState('');
  const [opening, setOpening] = useState(false);
  const [roleId, setRoleId] = useState(() => roles.some(r => r.id === source.roleId) ? source.roleId : roles[0]?.id ?? 'assistant');
  // null until the person picks one: the default follows the options as detection answers.
  const [choice, setChoice] = useState<string | null>(null);
  // Model picked per agent; untouched agents start where continuationModel says.
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  const [catalog, setCatalog] = useState<{ key: string; list: AgentModelList } | null>(null);
  useEffect(() => {
    let live = true;
    setDraft(null); setLoadError('');
    api.draftContinuation(source.id)
      .then(result => { if (live && result.sourceMemberId === source.id) { setDraft(result.text); setText(result.text); } })
      .catch(e => { if (live) setLoadError(displayError(e)); });
    return () => { live = false; };
  }, [source.id, attempt]);

  const sameAsSource = (o: ContinueOption) => o.runtime === source.runtime && (o.runtime === 'opencode' || (o.accountId ?? 'system') === (source.accountId ?? 'system'));
  const options: ContinueOption[] = [
    ...(primaryReady ? [{ key: 'primary', label: t('continue.primary', { label: primaryLabel }), runtime: primaryRuntime, accountId: primaryRuntime === 'opencode' ? null : primaryAccountId ?? 'system' }] : []),
    ...choices.map(c => ({ key: c.key, label: c.label, runtime: c.runtime, accountId: c.accountId })),
  ];
  // Usually the reason to continue is the source's own account, so another one comes first.
  const picked = options.find(o => o.key === choice) ?? options.find(o => !sameAsSource(o)) ?? options[0] ?? null;
  const blocked = !checking && options.length === 0;
  const edited = draft !== null && text !== draft;
  const ready = isDesktop && !checking && !busy && !opening && picked !== null && draft !== null && text.trim().length > 0;

  // The catalog belongs to the agent and account picked; the same loader as the conversation's model picker.
  const catalogKey = picked ? `${picked.runtime}:${picked.accountId ?? ''}` : '';
  useEffect(() => {
    if (!picked) return;
    let live = true;
    void modelListFor(picked.runtime, picked.accountId)
      .then(list => { if (live) setCatalog({ key: catalogKey, list }); })
      .catch(() => { if (live) setCatalog({ key: catalogKey, list: { source: 'suggested', models: [], detail: '' } }); });
    return () => { live = false; };
  }, [catalogKey]);
  const list = catalog && catalog.key === catalogKey ? catalog.list : null;
  const models = list?.models ?? [];
  const model = picked ? continuationModel(picked, source, primaryModel, modelDrafts) : '';
  // Say where the model came from, and when it cannot come along, why.
  const modelNote = !picked || checking ? ''
    : model !== '' && list?.source === 'catalog' && !models.some(m => m.id === model) ? t('continue.modelNotListed', { model })
    : picked.runtime === source.runtime && model === (source.model ?? '') ? (source.model ? t('continue.modelKept', { model: source.model }) : t('continue.modelKeptDefault'))
    : picked.runtime !== source.runtime && source.model ? t('continue.modelOtherRuntime', { model: source.model, runtime: RUNTIME_NAME[source.runtime] })
    : '';

  const close = () => { if (opening) return; if (edited && !window.confirm(t('continue.leaveConfirm'))) return; onClose(); };
  const submit = async () => {
    if (!ready || !picked) return;
    setOpening(true); setFailure('');
    try { await onContinue(roleId, continuationOptions(picked, model), text); } catch (e) { setFailure(displayError(e)); } finally { setOpening(false); }
  };

  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="continue-title" className="modal continuation" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
      <div className="modal-head"><div><div className="document-kicker">{t('continue.kicker')}</div><h2 id="continue-title">{t('continue.title', { role: source.roleName })}</h2></div><button className="modal-close" aria-label={t('ui.auto.001')} onClick={close}><X size={20} /></button></div>
      <div className="modal-body">
        <p className="agent-explanation">{t('continue.lead', { role: source.roleName, label: source.label })}</p>
        <div className="continuation-pickers">
          <label><span className="field-label">{t('continue.role')}</span>
            <select value={roleId} disabled={opening} onChange={e => setRoleId(e.target.value)}>{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          </label>
          <label><span className="field-label">{t('continue.agent')}</span>
            <select value={picked?.key ?? ''} disabled={checking || opening || options.length === 0} onChange={e => setChoice(e.target.value)}>
              {checking ? <option value="">{t('continue.checking')}</option>
                : options.length === 0 ? <option value="">{t('continue.none')}</option>
                : options.map(o => <option key={o.key} value={o.key}>{sameAsSource(o) ? t('continue.sameAsSource', { label: o.label }) : o.label}</option>)}
            </select>
          </label>
          <label><span className="field-label">{t('continue.model')}</span>
            <select value={model} title={list?.detail ?? ''} disabled={checking || opening || !picked} onChange={e => { const key = picked?.key; if (key) setModelDrafts(prev => ({ ...prev, [key]: e.target.value })); }}>
              <option value="">{picked?.runtime === 'opencode' ? t('continue.modelDefaultOpenCode') : t('continue.modelDefault')}</option>
              {model !== '' && !models.some(m => m.id === model) && <option value={model}>{model}</option>}
              {models.map(m => <option key={m.id} value={m.id}>{m.label}{m.isDefault ? t('continue.modelIsDefault') : ''}</option>)}
            </select>
          </label>
        </div>
        {picked && !checking && <small className="runtime-detail">{list ? modelNote : t('continue.modelLoading')}</small>}
        {blocked && <div className="continuation-block" role="alert">
          <span><CircleAlert size={14} />{t('continue.blocked')}</span>
          <div className="chat-card-actions">
            <button onClick={() => { if (!edited || window.confirm(t('continue.leaveConfirm'))) onProviders(); }}><Plug size={13} />{t('continue.providers')}</button>
            <button onClick={onRecheck}>{t('continue.recheck')}</button>
          </div>
        </div>}
        {!checking && picked && sameAsSource(picked) && <p className="runtime-detail">{t('continue.sameHint')}</p>}
        <label className="field-label" htmlFor="continuation-text">{t('continue.text')}</label>
        {loadError
          ? <div className="chat-error" role="alert"><CircleAlert size={14} /><span>{t('continue.error', { message: loadError })}</span><button onClick={() => setAttempt(n => n + 1)}>{t('continue.retry')}</button></div>
          : <textarea id="continuation-text" className="continuation-text" spellCheck={false} value={draft === null ? t('continue.loading') : text} disabled={draft === null || opening} onChange={e => setText(e.target.value)} />}
        <p className="footnote">{t('continue.help')}</p>
        {failure && <div className="chat-error" role="alert"><CircleAlert size={14} /><span>{failure}</span></div>}
        <div className="chat-card-actions">
          <button className="primary" disabled={!ready} onClick={() => void submit()}>{opening ? <LoaderCircle className="spin" size={15} /> : <Forward size={15} />}{opening ? t('continue.opening') : t('continue.submit')}</button>
          <button disabled={opening} onClick={close}>{t('continue.cancel')}</button>
          {edited && <button className="subtle" disabled={opening} onClick={() => { if (window.confirm(t('continue.resetConfirm'))) setText(draft ?? ''); }}>{t('continue.reset')}</button>}
        </div>
        {!isDesktop && <small className="preview-note">{t('continue.preview')}</small>}
      </div>
    </section>
  </div>;
}


/**
 * The model this conversation runs on, changed without leaving it.
 *
 * Neither CLI swaps a model in place, so Latte restarts the runtime and
 * resumes the same conversation. The list is the runtime's own catalog where
 * there is one; OpenCode has 155 models behind a provider, which is a Settings
 * decision and not a control to squeeze next to a chat, so there it only
 * reports what is in use.
 */
/**
 * The models a runtime says an account can use. OpenCode already publishes
 * what it has configured; the subscription runtimes are asked one by one, and
 * answer a catalog or an honest "this is what Latte knows".
 */
function modelListFor(runtime: ChatRuntime, accountId: string | null): Promise<AgentModelList> {
  return runtime === 'opencode'
    ? api.chatStatus().then((status): AgentModelList => ({
      source: 'catalog',
      detail: `Modelos configurados en OpenCode${status.defaultModel ? ` · por defecto ${status.defaultModel}` : ''}.`,
      models: status.models.map(id => ({ id, label: id, description: '', isDefault: id === status.defaultModel })),
    }))
    : api.listAccountModels(runtime, accountId ?? 'system');
}

function ModelPicker({ member, busy, onModel }: { member: TeamMember; busy: boolean; onModel: (memberId: string, model: string | null) => void }) {
  const [list, setList] = useState<AgentModelList | null>(null);
  useEffect(() => {
    let live = true;
    setList(null);
    void modelListFor(member.runtime, member.accountId).then(value => { if (live) setList(value); }).catch(() => undefined);
    return () => { live = false; };
  }, [member.runtime, member.accountId]);

  const models = list?.models ?? [];
  const current = member.model ?? '';
  // OpenCode ids read `provider/model`; grouping by provider keeps a long list navigable.
  const groups = new Map<string, typeof models>();
  for (const model of models) {
    const slash = model.id.indexOf('/');
    const group = slash > 0 ? model.id.slice(0, slash) : '';
    groups.set(group, [...(groups.get(group) ?? []), model]);
  }
  const grouped = groups.size > 1 || (groups.size === 1 && !groups.has(''));
  const option = (m: AgentModelList['models'][number]) => <option key={m.id} value={m.id}>{m.label}{m.isDefault ? ' · por defecto' : ''}</option>;

  return <select
    className="team-model"
    aria-label={t('ui.auto.388', { p0: member.roleName })}
    title={list ? t('ui.auto.406', { p0: list.detail }) : t('ui.auto.301')}
    value={current}
    disabled={busy || !list}
    onChange={e => onModel(member.id, e.target.value || null)}
  >
    <option value="">{list ? t('ui.auto.302') : 'Buscando modelos…'}</option>
    {current !== '' && !models.some(m => m.id === current) && <option value={current}>{current}</option>}
    {grouped
      ? [...groups.entries()].map(([group, items]) => group ? <optgroup key={group} label={group}>{items.map(option)}</optgroup> : items.map(option))
      : models.map(option)}
  </select>;
}

const tierLabel = (tier: EffortTier) => t(`effort.tier.${tier}.label` as 'effort.tier.light.label');
const tierHelp = (tier: EffortTier) => t(`effort.tier.${tier}.help` as 'effort.tier.light.help');

/**
 * How hard a member works per answer, in words a marketer chooses by outcome,
 * never by model name or reasoning-effort level. `compact` drops the help
 * caption under each option (kept on the `title`) for the tight space next to
 * the model picker; the roomier "Sumar un rol" dialog shows it in full.
 */
function TierPicker({ tier, busy, compact, onChange }: { tier: EffortTier; busy: boolean; compact?: boolean; onChange: (tier: EffortTier) => void }) {
  return <div className={'effort-picker' + (compact ? ' compact' : '')} role="radiogroup" aria-label={t('effort.group')}>
    {!compact && <span className="field-label">{t('effort.group')}</span>}
    <div className="effort-options">
      {EFFORT_TIERS.map(value => <button
        key={value}
        type="button"
        role="radio"
        aria-checked={tier === value}
        aria-label={t('effort.select', { tier: tierLabel(value) })}
        title={tierHelp(value)}
        className={tier === value ? 'selected' : ''}
        disabled={busy}
        onClick={() => onChange(value)}
      >
        <strong>{tierLabel(value)}</strong>
        {!compact && <small>{tierHelp(value)}</small>}
      </button>)}
    </div>
  </div>;
}
