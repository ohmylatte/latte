import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configure, fireEvent, render, screen, within } from '@testing-library/react';

configure({ asyncUtilTimeout: 5_000 });

/**
 * ENTREGA 1A — REGRESIÓN DE QA: LA VISTA PREVIA WEB ES "NINGUNA IA LISTA".
 *
 * Reportado en QA manual (vite, puerto 5190, localStorage limpio): terminar
 * el onboarding en la vista previa (sin Electron, sin runtime real) dejaba el
 * picker de 7 roles de siempre en vez de la tarjeta de recuperación. La causa:
 * `activateWork` cortaba con `if (!isDesktop) return;` ANTES de escribir
 * `activationRecovery`, así que el equipo quedaba vacío y sin ninguna señal
 * — `TeamPanel` no tenía forma de distinguir "todavía no se intentó" de
 * "no hay IA lista".
 *
 * Nada se mockea a propósito: es la MISMA implementación de `browser-api.ts`
 * que corre en la vista previa real (`addTeamMember`/`sendChat` son
 * `unavailable` ahí), así que este test reproduce el camino exacto del reporte.
 */

const gateHeading = () => screen.findByRole('heading', { name: '¿En qué querés trabajar?' });
const clickCard = (title: RegExp) => fireEvent.click(screen.getByRole('button', { name: title }));

function chooseDemoBrandCard() {
  fireEvent.click(screen.getByRole('button', { name: /Recorrer el demo/ }));
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { localStorage.clear(); });

describe('Entrega 1A — QA: recorrido completo en la vista previa web (sin IA real)', () => {
  it('muestra la tarjeta de recuperación, nunca el picker de 7 roles vacío', async () => {
    const { App } = await import('./App');
    const { I18nProvider } = await import('./i18n');
    render(<I18nProvider><App /></I18nProvider>);

    await gateHeading();
    clickCard(/Campaña nueva/);
    await screen.findByRole('heading', { name: 'Campaña nueva' });
    fireEvent.change(screen.getByPlaceholderText('¿Qué querés lograr?'), { target: { value: 'Lanzar la cosecha 2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));

    await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' });
    chooseDemoBrandCard();

    await screen.findByRole('heading', { name: '¿Con qué cuenta trabajás?' });
    clickCard(/Explorar con un proyecto demo/);

    fireEvent.click(await screen.findByRole('button', { name: /Empezar trabajo/ }));

    // La tarjeta de recuperación: el trabajo y el brief quedaron, y hay una
    // salida real en los dos sentidos.
    expect(await screen.findByText('Tu trabajo está listo, falta conectar una IA')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Conectar IA' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Seguir explorando el demo' })).toBeDefined();

    // El brief se lee como documento: títulos de verdad, nunca "##" sueltos.
    const card = screen.getByText('Tu trabajo está listo, falta conectar una IA').closest('.activation-recovery') as HTMLElement;
    expect(card.textContent).not.toContain('##');
    expect(within(card).getByRole('heading', { name: 'Objetivo' })).toBeDefined();

    // Nunca el picker de 7 roles vacío, ni sus controles técnicos.
    expect(screen.queryByText('ARMÁ TU EQUIPO')).toBeNull();
    expect(screen.queryByText('Cuánto se esfuerza')).toBeNull();
    expect(screen.queryByText('CON QUÉ AGENTE')).toBeNull();

    // "Seguir explorando el demo" limpia el aviso sin reintentar sola, y
    // recién ahí aparece el picker de siempre (el camino manual de agregar un rol).
    fireEvent.click(screen.getByRole('button', { name: 'Seguir explorando el demo' }));
    expect(await screen.findByText('ARMÁ TU EQUIPO')).toBeDefined();
  });
});
