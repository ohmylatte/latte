import type { ContentLocale, DocumentKind } from '../../shared/contracts';

/**
 * Starting points, not forms. Every template says what a good version of this
 * document answers and marks what is still unknown, so nobody has to invent
 * data to fill a field. The human (or an agent) rewrites freely.
 */
const UNKNOWN = '_Sin definir todavía._';
const UNKNOWN_EN = '_Not defined yet._';

function header(title: string, workTitle: string, base: string | null, lead: string, basedOnLabel: string): string {
  const lines = [`# ${title}`, '', `_${workTitle}${base ? ` · ${basedOnLabel}: ${base}` : ''}_`, '', lead, ''];
  return lines.join('\n');
}

export function renderDocumentTemplate(kind: DocumentKind, title: string, workTitle: string, baseTitle: string | null, locale: ContentLocale): string {
  return locale === 'en-US'
    ? renderDocumentTemplateEn(kind, title, workTitle, baseTitle)
    : renderDocumentTemplateEs(kind, title, workTitle, baseTitle);
}

function renderDocumentTemplateEs(kind: DocumentKind, title: string, workTitle: string, baseTitle: string | null): string {
  switch (kind) {
    case 'strategy':
      return `${header(title, workTitle, baseTitle, 'Qué decidimos hacer y por qué. Lo que todavía no sabemos queda marcado como tal.', 'basado en')}## Objetivo

${UNKNOWN}

## Audiencia

${UNKNOWN}

## Propuesta

${UNKNOWN}

## Elecciones

Qué hacemos y qué dejamos afuera, con el motivo.

${UNKNOWN}

## Restricciones

Presupuesto, plazos, límites de marca, lo que no se puede prometer.

${UNKNOWN}

## Hipótesis y evidencia

| Afirmación | Estado | En qué se apoya |
| --- | --- | --- |
|  | hipótesis | _sin fuente_ |

## Cómo lo medimos

${UNKNOWN}
`;
    case 'calendar':
      return `${header(title, workTitle, baseTitle, 'Un mes de acciones concretas. Una fila por pieza; lo que no está decidido se deja vacío, no se inventa.', 'basado en')}## Calendario

| Fecha | Canal | Objetivo | Mensaje | CTA |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Supuestos

Qué damos por cierto para que este calendario tenga sentido.

${UNKNOWN}

## Pendientes de definir

${UNKNOWN}
`;
    case 'research':
      return `${header(title, workTitle, baseTitle, 'Evidencia con fuente. Un hallazgo sin fuente es una hipótesis y se marca así.', 'basado en')}## Preguntas que queremos responder

${UNKNOWN}

## Hallazgos

| Hallazgo | Fuente | Fecha | Confianza |
| --- | --- | --- | --- |
|  |  |  |  |

## Qué quedó sin responder

${UNKNOWN}
`;
    case 'copy':
      return `${header(title, workTitle, baseTitle, 'Piezas listas para usar. Cada una dice para qué canal es y qué pide.', 'basado en')}## Pieza 1

- **Canal:** ${UNKNOWN}
- **Objetivo:** ${UNKNOWN}
- **CTA:** ${UNKNOWN}

Texto:

${UNKNOWN}
`;
    case 'note':
      return `${header(title, workTitle, baseTitle, 'Notas de trabajo.', 'basado en')}${UNKNOWN}\n`;
    default:
      return `${header(title, workTitle, baseTitle, 'El encargo y lo que hay que entregar.', 'basado en')}## Encargo

${UNKNOWN}

## Qué hay que entregar

${UNKNOWN}

## Restricciones

${UNKNOWN}
`;
  }
}

function renderDocumentTemplateEn(kind: DocumentKind, title: string, workTitle: string, baseTitle: string | null): string {
  switch (kind) {
    case 'strategy':
      return `${header(title, workTitle, baseTitle, "What we decided to do, and why. Anything we don't know yet gets flagged as such.", 'based on')}## Goal

${UNKNOWN_EN}

## Audience

${UNKNOWN_EN}

## Proposal

${UNKNOWN_EN}

## Choices

What we're doing and what we're leaving out, and why.

${UNKNOWN_EN}

## Constraints

Budget, timeline, brand limits, anything that can't be promised.

${UNKNOWN_EN}

## Hypotheses and evidence

| Claim | Status | Based on |
| --- | --- | --- |
|  | hypothesis | _no source_ |

## How we'll measure it

${UNKNOWN_EN}
`;
    case 'calendar':
      return `${header(title, workTitle, baseTitle, "A month of concrete actions. One row per piece; whatever isn't decided stays blank, never invented.", 'based on')}## Calendar

| Date | Channel | Goal | Message | CTA |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Assumptions

What we're taking as a given for this calendar to make sense.

${UNKNOWN_EN}

## Still to define

${UNKNOWN_EN}
`;
    case 'research':
      return `${header(title, workTitle, baseTitle, 'Evidence with a source. A finding with no source is a hypothesis, and gets labeled as one.', 'based on')}## Questions we want answered

${UNKNOWN_EN}

## Findings

| Finding | Source | Date | Confidence |
| --- | --- | --- | --- |
|  |  |  |  |

## What's still unanswered

${UNKNOWN_EN}
`;
    case 'copy':
      return `${header(title, workTitle, baseTitle, "Ready-to-use pieces. Each one says which channel it's for and what it's asking for.", 'based on')}## Piece 1

- **Channel:** ${UNKNOWN_EN}
- **Goal:** ${UNKNOWN_EN}
- **CTA:** ${UNKNOWN_EN}

Copy:

${UNKNOWN_EN}
`;
    case 'note':
      return `${header(title, workTitle, baseTitle, 'Working notes.', 'based on')}${UNKNOWN_EN}\n`;
    default:
      return `${header(title, workTitle, baseTitle, 'The brief, and what needs to be delivered.', 'based on')}## Brief

${UNKNOWN_EN}

## What needs to be delivered

${UNKNOWN_EN}

## Constraints

${UNKNOWN_EN}
`;
  }
}
