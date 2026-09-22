import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { TeamPanel, type LatteMode, type RuntimeChoice } from './TeamPanel';
import { SkillsView } from './SkillsView';
import { I18nProvider } from './i18n';
import { roleSummary, skillSummary } from './pack-i18n';
import type { AgentRole, AgentSkill, ChatRuntime, ChatSession, HandoffRequest, TeamMember, Work, WorkPermissionMode } from '../shared/contracts';

/**
 * R5: EL RESUMEN DEL PACK, EN EL IDIOMA DE LA INTERFAZ.
 *
 * El `summary:` de cada rol y de cada skill vive en el frontmatter de un `.md`
 * del pack, escrito en castellano, y ese `.md` es el prompt que viaja al
 * runtime: no se puede traducir en el disco sin cambiar lo que el agente lee
 * (y `sales-copywriter.md` está a 23 caracteres de su tope). Así que con la
 * interfaz en inglés la persona veía, en el selector de roles y en Skills, dos
 * frases en castellano en el medio de una pantalla en inglés.
 *
 * Se traduce del lado del renderer. Lo que NO está en el mapa —un rol propio,
 * una skill aprendida— sigue mostrando su propio texto, que es lo único
 * honesto: nadie lo tradujo.
 */

const PACK_ROLES: AgentRole[] = [
  { id: 'assistant', name: 'Asistente', initial: 'A', summary: 'Trabaja el brief con vos sin un rol fijo. Es el punto de partida.', builtin: true, tier: 'balanced', avatar: null },
  { id: 'strategist', name: 'Strategist', initial: 'S', summary: 'Compara opciones contra el objetivo y deja fundamentos, tradeoffs y próximos pasos.', builtin: false, tier: 'deep', avatar: null },
  { id: 'sales-copywriter', name: 'Sales Copywriter', initial: 'C', summary: 'Convertí briefs en copy de venta listo para usar, con una promesa defendible, prueba real y un CTA claro.', builtin: false, tier: 'balanced', avatar: null },
];
const CUSTOM: AgentRole = { id: 'mi-rol', name: 'Mi rol', initial: 'M', summary: 'Un resumen que escribí yo y nadie tradujo.', builtin: false, tier: 'balanced', avatar: null };

describe('roleSummary / skillSummary: el mapa por id, y el respaldo honesto', () => {
  it('en castellano devuelve la MISMA frase del frontmatter, palabra por palabra', () => {
    for (const role of PACK_ROLES) expect(roleSummary(role, 'es-AR')).toBe(role.summary);
  });

  it('en inglés devuelve la traducción, no el castellano del pack', () => {
    for (const role of PACK_ROLES) {
      const english = roleSummary(role, 'en-US');
      expect(english).not.toBe(role.summary);
      expect(english.trim().length).toBeGreaterThan(0);
    }
    expect(roleSummary(PACK_ROLES[1]!, 'en-US')).toContain('tradeoffs');
  });

  it('un rol propio devuelve su propio resumen en los dos idiomas: nadie lo tradujo', () => {
    expect(roleSummary(CUSTOM, 'es-AR')).toBe(CUSTOM.summary);
    expect(roleSummary(CUSTOM, 'en-US')).toBe(CUSTOM.summary);
  });

  it('lo mismo para las skills que Latte trae, y para una aprendida', () => {
    const shipped: AgentSkill = { id: 'writing', name: 'Escritura sin relleno', summary: 'Corta muletillas, frases vacías y cierres de efecto. Pide concreto: nombres, números, fechas, mecanismos.', enabled: true };
    const learned: AgentSkill = { id: 'mi-skill', name: 'Mi skill', summary: 'Algo que aprendió de mí.', enabled: true };
    expect(skillSummary(shipped, 'es-AR')).toBe(shipped.summary);
    expect(skillSummary(shipped, 'en-US')).not.toBe(shipped.summary);
    expect(skillSummary(learned, 'en-US')).toBe(learned.summary);
  });
});

// --- Las dos pantallas donde esto se leía en castellano ----------------------

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    isDesktop: false,
    api: {
      ...actual.browserAPI,
      // El provider pregunta el idioma al backend al montar: sin esto vuelve a
      // castellano en cuanto la promesa resuelve, y el test estaría midiendo
      // otra cosa.
      getUiLocale: async () => 'en-US' as const,
      featureFlags: async () => ({ generation: false, brandKits: false, learning: false, coordination: true }),
      listSkills: async () => [
        { id: 'writing', name: 'Escritura sin relleno', summary: 'Corta muletillas, frases vacías y cierres de efecto. Pide concreto: nombres, números, fechas, mecanismos.', enabled: true },
        { id: 'mi-skill', name: 'Mi skill', summary: 'Algo que aprendió de mí.', enabled: true },
      ],
      listSkillCandidates: async () => [],
    },
  };
});

const work: Work = { id: 'w1', brandId: 'b1', title: 'Trabajo', brief: '', folder: null, updatedAt: '' };

function panelProps(roles: AgentRole[]) {
  return {
    work, team: [] as TeamMember[], chats: {} as Record<string, ChatSession>, selectedId: null, roles,
    primaryLabel: 'OpenCode', primaryDetail: 'Listo', primaryReady: true, checking: false,
    primaryRuntime: 'opencode' as ChatRuntime, primaryAccountId: null, primaryModel: null,
    choices: [] as RuntimeChoice[], busy: false, isDesktop: false,
    onSelect: () => {}, onAdd: async () => {}, onOpen: async () => {}, onPause: async () => {},
    onFinish: async () => {}, onRestart: async () => {}, onContinue: async () => {},
    handoffs: [] as HandoffRequest[], onAcceptHandoff: async () => {}, onDismissHandoff: async () => {},
    onRemove: async () => {}, onProviders: () => {}, onRecheck: () => {}, onModel: () => {}, onTier: () => {},
    onError: () => {}, onAttachFiles: async () => [], untracked: [] as string[], onAdoptFile: () => {},
    permissions: 'ask' as WorkPermissionMode, permissionBusy: false, onPermissions: () => {},
    mode: 'advanced' as LatteMode,
  };
}

describe('el selector de roles y Skills, con la interfaz en inglés', () => {
  beforeEach(() => { document.documentElement.lang = 'en'; });
  afterEach(() => { document.documentElement.lang = 'es'; });

  const summaries = (container: HTMLElement) => Array.from(container.querySelectorAll('.role-card small')).map((el) => el.textContent ?? '');

  it('el selector muestra los resúmenes del pack en inglés, y el del rol propio tal cual', () => {
    const { container } = render(<I18nProvider><TeamPanel {...panelProps([...PACK_ROLES, CUSTOM])} /></I18nProvider>);
    const texts = summaries(container);
    expect(texts).toHaveLength(4);
    for (const role of PACK_ROLES) expect(texts).not.toContain(role.summary);
    expect(texts).toContain(CUSTOM.summary);
    expect(texts.some((text) => text.includes('tradeoffs and next steps'))).toBe(true);
  });

  it('Skills muestra el resumen de la skill incluida en inglés, y el de la aprendida tal cual', async () => {
    const { container } = render(<I18nProvider><SkillsView onNotice={() => {}} onError={() => {}} /></I18nProvider>);
    await waitFor(() => expect(container.querySelectorAll('.skill-card')).toHaveLength(2));
    const texts = Array.from(container.querySelectorAll('.skill-card p')).map((el) => el.textContent ?? '');
    expect(texts.some((text) => text.startsWith('Cuts filler'))).toBe(true);
    expect(texts).toContain('Algo que aprendió de mí.');
  });
});
