import type { Brand, Decision, Work } from '../../shared/contracts';
import { briefDocumentId, type LatteRepository } from '../storage/repository';
import { renderInstructions, type InstructionPack } from '../workspace/instructions';
import { fingerprintOf, type WorkspaceFiles } from '../workspace/workspace';
import { newId } from '../core/ids';
import { memoryProjectFor } from '../memory/engram';

export const DEMO_BRAND_ID = 'brd_demo_casa_oliva';
export const DEMO_WORK_ID = 'wrk_demo_lanzamiento_cosecha';

const DEMO_BRAND_CONTEXT = `# Casa Oliva (DEMO)

> Marca ficticia incluida con Latte para que puedas probar el flujo completo. Borrá o ignorá esta marca cuando cargues la tuya.

## Qué es
Aceite de oliva virgen extra de producción familiar en el Valle de Uco (Mendoza). Cosecha temprana, prensado en frío dentro de las 6 horas, botella de vidrio oscuro de 500 ml.

## A quién le hablamos
- Cocineros caseros de 30 a 55 años que ya compran productos de origen y leen etiquetas.
- Regalería gourmet (tiendas de barrio, vinotecas).
- Restaurantes de cocina de producto que quieren mencionar el productor en la carta.

## Posicionamiento
"El aceite que se prueba primero solo." Sabor antes que marketing: notas de tomate verde y almendra, picor final limpio.

## Tono
Cálido, directo, sin épica. Hablamos de oficio y de mesa, nunca de "experiencias premium". Español rioplatense, tuteo con voseo.

## Nunca
- Comparar con marcas industriales por nombre.
- Prometer beneficios de salud.
- Usar la palabra "artesanal" (está vacía).

## Activos
- Paleta: verde oliva profundo, crema, terracota.
- Fotografía: luz natural, manos, mesa de madera, botella siempre con producto real.
`;

/**
 * The working document of the demo work. In Latte the "brief" field IS the
 * Markdown document the human and the agents edit, so the ask and the plan
 * live together in one file.
 */
const DEMO_DOCUMENT = `# Encargo · Lanzamiento Cosecha 2026

> Documento DEMO generado con Latte. Este trabajo tiene varios entregables: el encargo, la estrategia y el calendario. Cada uno es un archivo Markdown con sus propias versiones.

## Encargo

Lanzamiento de la Cosecha 2026, edición limitada de 1.200 botellas.

## Qué hay que entregar

- Estrategia de lanzamiento (documento aparte).
- Calendario de 3 semanas con canal, mensaje y CTA (documento aparte, derivado de la estrategia).
- Tres piezas de copy listas para usar.

## Restricciones

Pauta de USD 400, sin descuentos en el primer mes, y la fecha de prensado (14 de mayo) tiene que ser visible en cada pieza.
`;

const DEMO_STRATEGY = `# Estrategia · Cosecha 2026

_Documento DEMO. La estrategia decide; el calendario ejecuta. Lo que no está validado se marca como hipótesis._

## Objetivo

Vender el 60 % de la edición (720 de 1.200 botellas) en las primeras 3 semanas, entre tienda online y 8 puntos de venta aliados.

## Audiencia

Cocineros caseros de 30 a 55 que ya compran productos de origen y leen etiquetas. Segundo anillo: regalería gourmet y restaurantes de cocina de producto.

## Propuesta

"Prensado el 14 de mayo. Abierto en tu mesa." La fecha de prensado es el argumento: es lo que ninguna botella de góndola puede decir.

## Elecciones

- Contamos la fecha de prensado en la primera línea de cada pieza, no en la ficha técnica.
- Sin descuentos el primer mes: la escasez se sostiene con stock real, no con precio.
- Priorizamos video corto sobre bodegón: se muestra el oficio, no el producto quieto.
- Dejamos afuera: influencers de estilo de vida, packs promocionales, cualquier claim de salud.

## Restricciones

Pauta de USD 400. 1.200 botellas, sin reposición. La palabra "artesanal" está prohibida por decisión de marca.

## Hipótesis y evidencia

| Afirmación | Estado | En qué se apoya |
| --- | --- | --- |
| La fecha de prensado diferencia frente a góndola | hipótesis | Conversaciones de mostrador, sin muestra formal |
| El mail tiene 38 % de apertura | evidencia | Histórico de los últimos 6 envíos |
| Los aliados reponen si prueban en mostrador | hipótesis | _sin fuente todavía_ |

## Cómo lo medimos

Botellas por semana contra el objetivo de 720, apertura del primer mail contra el 38 % histórico, y pedidos de reposición de los 8 aliados.
`;

const DEMO_CALENDAR = `# Calendario · 3 semanas de lanzamiento

_Documento DEMO derivado de la estrategia. Si la estrategia cambia, Latte avisa que hay que revisar esto; no lo reescribe solo._

## Calendario

| Fecha | Canal | Objetivo | Mensaje | CTA |
| --- | --- | --- | --- | --- |
| Semana 1 · lunes | Instagram | Anticipo | Video de 20 s del prensado, fecha en la primera línea | Pedila en el link |
| Semana 1 · jueves | Newsletter | Anticipo | "Ya está en botella": 1.200 unidades, sin reposición | Pedir mi botella |
| Semana 2 · martes | Instagram Reels | Prueba | Cata con pan: verde tomate, almendra, picor limpio | Pedila en el link |
| Semana 2 · viernes | Punto de venta | Prueba | Cartel A5 con la fecha y una frase de cata | Probala en el mostrador |
| Semana 3 · miércoles | Newsletter | Cierre | Contador de stock real | Última tanda |
| Semana 3 · viernes | WhatsApp a aliados | Cierre | Reposición antes de fin de mes | Confirmar pedido |

## Supuestos

- La pauta (USD 400) se reparte 70 % a los Reels de la semana 2 y 30 % a retargeting en la semana 3.
- Los 8 puntos de venta reciben material físico antes del lunes de la semana 1.

## Pendientes de definir

Fechas exactas del calendario y quién graba el video del prensado.
`;

const DEMO_DECISIONS = [
  'La fecha de prensado (14 de mayo) va en la primera línea de toda pieza; es el diferencial, no un dato técnico.',
  'Sin descuentos en el primer mes: la edición limitada se sostiene con stock real, no con precio.',
  'No usamos la palabra "artesanal" en ningún canal.',
];

/**
 * Seeds one clearly labelled demo brand so the app opens with something real
 * to explore. Runs only when the database has no brands at all.
 */
export function seedDemoIfEmpty(repo: LatteRepository, files: WorkspaceFiles, pack: InstructionPack | null = null, now: () => string = () => new Date().toISOString()): boolean {
  if (repo.countBrands() > 0) return false;

  const createdAt = now();
  const brand: Brand = { id: DEMO_BRAND_ID, name: 'Casa Oliva (demo)', context: DEMO_BRAND_CONTEXT, createdAt, archivedAt: null };
  const work: Work = {
    id: DEMO_WORK_ID,
    brandId: brand.id,
    title: 'Lanzamiento Cosecha 2026',
    brief: DEMO_DOCUMENT,
    folder: null,
    updatedAt: createdAt,
  };

  repo.transaction(() => {
    repo.insertBrand(brand);
    repo.insertWork(work);
    files.ensureBrand(brand.id);
    files.ensureWork(brand.id, work.id, DEMO_DOCUMENT);
    files.writeDocument(brand.id, work.id, DEMO_DOCUMENT);

    const decisions: Decision[] = DEMO_DECISIONS.map((text, index) => ({
      id: `dec_demo_${index + 1}`,
      workId: work.id,
      text,
      createdAt,
      rationale:'', alternativesRejected:[], evidenceRefs:[], status:'approved',
      source:{chatId:null,messageId:null,memberId:null,roleId:null,runtime:null}, clientRequestId:null, fingerprint:'', decidedAt:createdAt,
    }));
    for (const decision of decisions) repo.insertDecision(decision);

    const briefId = briefDocumentId(work.id);
    repo.insertDocument({ id: briefId, workId: work.id, kind: 'brief', title: 'Encargo', fileName: 'brief.md', status: 'approved', baseDocumentId: null, baseRevisionId: null, baseFingerprint: null, lastFingerprint: fingerprintOf(DEMO_DOCUMENT), createdAt, updatedAt: createdAt });

    // The strategy is its own deliverable, with a version the calendar can point at.
    const strategyId = 'doc_demo_b_strategy';
    files.writeDocument(brand.id, work.id, DEMO_STRATEGY, 'strategy.md');
    repo.insertDocument({ id: strategyId, workId: work.id, kind: 'strategy', title: 'Estrategia de lanzamiento', fileName: 'strategy.md', status: 'review', baseDocumentId: null, baseRevisionId: null, baseFingerprint: null, lastFingerprint: fingerprintOf(DEMO_STRATEGY), createdAt, updatedAt: createdAt });
    const strategyRevision = 'rev_demo_strategy';
    repo.insertRevision({ id: strategyRevision, workId: work.id, documentId: strategyId, source: 'human', content: DEMO_STRATEGY, createdAt });
    files.writeSnapshot(brand.id, work.id, strategyRevision, createdAt, DEMO_STRATEGY);

    // The calendar declares which version of the strategy it was built on.
    files.writeDocument(brand.id, work.id, DEMO_CALENDAR, 'calendar.md');
    repo.insertDocument({ id: 'doc_demo_c_calendar', workId: work.id, kind: 'calendar', title: 'Calendario de 3 semanas', fileName: 'calendar.md', status: 'draft', baseDocumentId: strategyId, baseRevisionId: strategyRevision, baseFingerprint: fingerprintOf(DEMO_STRATEGY), lastFingerprint: fingerprintOf(DEMO_CALENDAR), createdAt, updatedAt: createdAt });

    const revisionId = newId('rev');
    repo.insertRevision({ id: revisionId, workId: work.id, documentId: briefId, source: 'human', content: DEMO_DOCUMENT, createdAt });
    files.writeSnapshot(brand.id, work.id, revisionId, createdAt, DEMO_DOCUMENT);

    files.writeInstructions(brand.id, work.id, renderInstructions({
      brand,
      work,
      decisions,
      documents: [
        { kind: 'brief', title: 'Encargo', fileName: 'brief.md', status: 'approved' },
        { kind: 'strategy', title: 'Estrategia de lanzamiento', fileName: 'strategy.md', status: 'review' },
        { kind: 'calendar', title: 'Calendario de 3 semanas', fileName: 'calendar.md', status: 'draft', baseFileName: 'strategy.md' },
      ],
      pack,
      memoryProject: memoryProjectFor(brand.id),
    }));
  });
  return true;
}
