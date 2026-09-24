import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B1.5: CADA CLASE QUE EL PRODUCTO PINTA TIENE UNA REGLA QUE LA PINTA.
 *
 * Los jueces de las rondas anteriores dejaron anotado que había clases nuevas
 * SIN una sola línea de CSS: `team-finished-coordination`,
 * `active-teams-strip-row-finished`, `home-row-finished`, los tachados de las
 * altas. Una clase sin regla no es un estilo pendiente: es una promesa que el
 * componente hace y la hoja no cumple — el run terminado se veía idéntico a
 * uno vivo, y la tira lateral desbordaba con marca, trabajo y estado
 * pisándose.
 *
 * El test escanea `styles.css` (cortado por `/\r?\n/`, el repo es CRLF) y
 * exige que cada selector exista Y traiga declaraciones: un `{}` vacío pasaría
 * un `includes` y no pintaría nada.
 */

const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const lines = css.split(/\r?\n/);

/** Las declaraciones de la primera regla cuyo selector menciona esta clase. */
function ruleBodyFor(className: string): string | null {
  const needle = '.' + className;
  for (const line of lines) {
    const brace = line.indexOf('{');
    if (brace < 0) continue;
    const selector = line.slice(0, brace);
    // Frontera: `.team-card` no puede darse por cumplida con `.team-cards`.
    if (!new RegExp(`\\${needle}(?![\\w-])`).test(selector)) continue;
    const body = line.slice(brace + 1, line.lastIndexOf('}'));
    if (body.trim().length > 0) return body;
  }
  return null;
}

const NEW_CLASSES = [
  // Las tarjetas, en el chat.
  'team-cards', 'team-cards-waiting', 'team-cards-goto', 'team-card',
  'team-card-actions', 'team-card-edit', 'team-card-edit-actions', 'team-card-edit-prompt',
  'team-card-answer', 'team-card-more', 'team-card-first-line', 'team-card-prompt',
  'team-card-readonly', 'team-card-unreadable', 'team-card-aggregate', 'team-card-note',
  'team-card-edit-dropped', 'team-card-empty-plan', 'team-card-orphan-note',
  'team-card-plan-dropped-title', 'team-card-hire-dropped', 'team-card-hire-unticked',
  'team-card-edit-hire', 'team-card-edit-unlimited',
  // El buzón.
  'team-inbox', 'team-inbox-row', 'team-inbox-line', 'team-inbox-name', 'team-inbox-pending',
  'team-inbox-thread-toggle', 'team-thread', 'team-thread-row', 'team-thread-empty',
  'team-member-state', 'team-tab-pending',
  // El run y lo avanzado.
  'team-coordination-controls', 'team-coordination-counts', 'team-coordination-budget',
  'team-finished-coordination', 'team-advanced', 'team-advanced-budget-edit',
  'team-advanced-budget-input', 'team-advanced-budget-save', 'team-advanced-run-budget-invalid',
  'team-support', 'team-support-row', 'team-support-coordination', 'team-support-memory',
  // B3: el modo Equipo de la columna, la linea plegada y el subtitulo de la pestana.
  'team-rail-head', 'team-rail-modes', 'team-rail-chat', 'team-rail-team', 'team-rail-pending',
  'team-tab-thread', 'team-view', 'team-view-empty', 'team-view-columns', 'team-view-list',
  'team-view-thread', 'team-view-thread-title', 'team-inbox-open-chat',
  'team-cards-collapsed', 'team-cards-collapsed-text', 'team-tab-text', 'team-tab-last',
  // B4.3: los dos renglones de la pestana, que el chip dejo de pisar.
  'team-tab-top', 'team-tab-bottom',
  // La tira lateral y la fila de Inicio, que venían sin una sola regla.
  // H2: `active-teams-strip-row-finished` se fue de las dos puntas a la vez —
  // la tira ya no dibuja runs cerrados, así que la clase no la pinta nadie y
  // la regla que la pintaba tampoco tiene por qué seguir. Una regla sin
  // componente es la misma promesa rota que un componente sin regla, del
  // otro lado. El punto de estado y el "y N más" ocupan su lugar en la lista.
  'active-teams-strip', 'active-teams-strip-row', 'active-teams-strip-brand',
  'active-teams-strip-work', 'active-teams-strip-status', 'active-teams-strip-budget',
  'active-teams-strip-gates', 'active-teams-strip-dot', 'active-teams-strip-more',
  'home-row-finished',
  // Marca → Equipo (esquema 14): el plantel, y los dos rótulos del diálogo.
  'roster-list', 'roster-row', 'roster-actions', 'roster-call', 'roster-empty', 'role-picker-section',
];

describe('B1.5: el CSS del equipo', () => {
  it('la hoja se leyó de verdad', () => {
    expect(lines.length).toBeGreaterThan(50);
  });

  for (const className of NEW_CLASSES) {
    it(`.${className} tiene una regla con declaraciones`, () => {
      const body = ruleBodyFor(className);
      expect(body, `.${className} no tiene ninguna regla en styles.css`).not.toBeNull();
      expect(body!.length, `.${className} tiene una regla vacía`).toBeGreaterThan(3);
    });
  }

  /**
   * La tira desbordaba: marca, trabajo y estado en una fila sin `min-width:0`
   * ni recorte, dentro de un sidebar de 232 px. Cada uno en su renglón, y lo
   * que no entra se recorta con elipsis.
   */
  it('la tira no puede desbordar: sus celdas recortan', () => {
    const cell = ruleBodyFor('active-teams-strip-row')!;
    expect(cell).toContain('min-width:0');
    const spans = lines.find((l) => l.startsWith('.active-teams-strip-row>span{'));
    expect(spans, 'las celdas de la tira no tienen regla propia').toBeDefined();
    expect(spans!).toContain('text-overflow:ellipsis');
    expect(spans!).toContain('display:block');
  });

  /**
   * H2: un run cerrado no espera nada de nadie — y por eso ya no está en la
   * tira. Lo que la hoja tiene que pintar ahora es la SEÑAL de estado: el
   * punto, con el único acento de la superficie, y su tono de "te necesita".
   */
  it('el punto de estado tiene forma y un solo acento', () => {
    const dot = ruleBodyFor('active-teams-strip-dot')!;
    expect(dot).toContain('border-radius:50%');
    expect(css).toContain('.active-teams-strip-dot[data-tone="live"]');
    expect(css).toContain('.active-teams-strip-dot[data-tone="needs"]');
    expect(css).not.toContain('.active-teams-strip-row-finished');
  });

  /** El conteo de la tira es un número: se lee en mono, como todos los de la app. */
  it('el conteo de la tira va en mono y en su propia columna', () => {
    const budget = ruleBodyFor('active-teams-strip-budget')!;
    expect(budget).toContain('var(--mono)');
    expect(budget).toContain('grid-area');
  });

  /**
   * B3.1: la vista del equipo y el hilo no pueden desbordar la columna. Las dos
   * celdas con `min-width:0` y su propio scroll: sin eso, un renglon largo del
   * buzon estira la grilla y empuja el hilo fuera de la pantalla.
   */
  it('la vista del equipo recorta y scrollea, en sus dos celdas', () => {
    expect(ruleBodyFor('team-view-columns')).toContain('min-width:0');
    expect(ruleBodyFor('team-view-list')).toContain('overflow-y:auto');
    expect(ruleBodyFor('team-view-list')).toContain('min-width:0');
    expect(ruleBodyFor('team-view-thread')).toContain('overflow-y:auto');
    expect(ruleBodyFor('team-view-thread')).toContain('min-width:0');
  });

  /** En una columna angosta la lista y el hilo van uno sobre otro; se reparten cuando hay ancho. */
  it('las dos columnas son una sola hasta que la columna da el ancho', () => {
    expect(ruleBodyFor('team-view-columns')).toContain('grid-template-columns:minmax(0,1fr)');
    expect(css).toContain('@container (min-width:560px)');
    expect(css).toContain('.team{container-type:inline-size}');
  });

  /** B3.3: el subtitulo de la pestana recorta en vez de estirar la tira. */
  it('el subtitulo de la pestana recorta', () => {
    expect(ruleBodyFor('team-tab-last')).toContain('text-overflow:ellipsis');
    expect(ruleBodyFor('team-tab-text')).toContain('min-width:0');
  });

  /** B3.2: la linea plegada es UNA linea; lo que no entra se recorta. */
  it('la linea plegada no puede crecer a dos renglones', () => {
    expect(ruleBodyFor('team-cards-collapsed-text')).toContain('white-space:nowrap');
    expect(ruleBodyFor('team-cards-collapsed-text')).toContain('text-overflow:ellipsis');
  });

  /** Las tarjetas viven arriba del composer: no pueden comerse la conversación. */
  it('la sección de tarjetas tiene techo y scroll propio', () => {
    const body = ruleBodyFor('team-cards')!;
    expect(body).toContain('max-height');
    expect(body).toContain('overflow-y:auto');
  });

  /**
   * B4.3a: TECHO NO ES ALTURA.
   *
   * Desplegadas, las tarjetas quedaban APLASTADAS dentro de la columna del
   * chat: se veía el título «Del equipo», una barra de scroll y nada más. El
   * `max-height:46vh` decía hasta dónde pueden crecer, pero como todo hijo
   * flexible de `.chat-pane` podían encogerse a cero — y se encogían, porque
   * la conversación de al lado se queda con el alto. Lo que faltaba es que NO
   * cedan: el que cede es el scroll de la conversación.
   */
  it('las tarjetas desplegadas no ceden alto; la conversación sí', () => {
    expect(ruleBodyFor('team-cards')).toContain('flex:0 0 auto');
    // La última regla del scroll es la que manda: tiene que poder achicarse.
    const scroll = [...lines].reverse().find((l) => l.startsWith('.chat-pane .chat-scroll{'));
    expect(scroll, 'no hay ninguna regla para el scroll de la conversación').toBeDefined();
    expect(scroll!).toContain('flex:1 1 auto');
    expect(scroll!).toContain('min-height:0');
  });

  /**
   * B4.3b: LA PESTAÑA SON DOS RENGLONES, Y POR ESO NADA SE PISA.
   *
   * En una sola fila de 190px el chip de estado («conectado») se montaba
   * encima del nombre («Community Manager»). Arriba el avatar, el nombre y el
   * punto; abajo el chip y el último intercambio. `align-items:flex-start`
   * porque una fila centrada con dos renglones desalinea el avatar.
   */
  it('la pestaña apila dos renglones en vez de apretar todo en una fila', () => {
    expect(ruleBodyFor('team-tab')).toContain('align-items:flex-start');
    const top = ruleBodyFor('team-tab-top');
    const bottom = ruleBodyFor('team-tab-bottom');
    expect(top, '.team-tab-top no tiene regla').not.toBeNull();
    expect(bottom, '.team-tab-bottom no tiene regla').not.toBeNull();
    // Los dos renglones ocupan el ancho y recortan: sin `min-width:0` un
    // nombre largo estira la pestaña en vez de recortarse.
    for (const body of [top!, bottom!]) {
      expect(body).toContain('display:flex');
      expect(body).toContain('min-width:0');
    }
  });

  /** El chip y el último intercambio comparten renglón: los dos recortan. */
  it('el renglón de abajo recorta en vez de empujar', () => {
    expect(ruleBodyFor('team-tab-last')).toContain('overflow:hidden');
    expect(ruleBodyFor('team-member-state')).toContain('flex-shrink:0');
  });
});
