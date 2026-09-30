import { afterEach, describe, expect, it } from 'vitest';
import { browserAPI, resetBrandDnaPreview, setBrandDnaPreviewStepMs } from './browser-api';
import { fullDateLabel } from '../shared/commercial-dates';

/**
 * Ronda 4 · EL DOBLE DE LA VISTA PREVIA NO MIENTE SOBRE LA FECHA.
 *
 * La idea "Contenido de temporada" de la vista previa decía "Hoy 20 de
 * septiembre" con la fecha clavada: una captura de una fecha que no es hoy es
 * una mentira chiquita que igual hay que arreglar. Usa la misma función de
 * fecha larga que las ideas de respaldo.
 */
const todayIso = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

describe('Inicio · la vista previa de Ideas', () => {
  afterEach(() => {
    resetBrandDnaPreview();
    setBrandDnaPreviewStepMs(700);
  });

  it('la idea de temporada usa la fecha real de hoy, no una fija', async () => {
    resetBrandDnaPreview();
    setBrandDnaPreviewStepMs(0);

    const job = await browserAPI.buildBrandDna('demo', 'ideas', null);
    let snapshot = await browserAPI.readBrandDnaBuildJob(job.jobId);
    for (let i = 0; i < 100 && !snapshot.done; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      snapshot = await browserAPI.readBrandDnaBuildJob(job.jobId);
    }
    expect(snapshot.done, 'el build de la vista previa terminó').toBe(true);

    const view = await browserAPI.readBrandDna('demo');
    const season = view.ideas.find((idea) => idea.id === 'idea-temporada');
    expect(season, 'la idea de temporada está en la vista previa').toBeDefined();
    expect(season!.why).toBe(`Hoy ${fullDateLabel(todayIso(), 'es-AR')} en Argentina.`);
    expect(season!.why).not.toContain('20 de septiembre');
  });
});
