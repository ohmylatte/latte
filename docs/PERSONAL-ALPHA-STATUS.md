# Latte · estado para la alpha personal (2026-09-06)

> **Snapshot histórico del 2026-09-06.** Este documento conserva lo que estaba
> verificado en ese corte; no describe el soporte ni la distribución actuales.
> Para el estado vigente, consultá el [`README`](../README.md) y, en Linux,
> [`RUN-linux.md`](RUN-linux.md).

Qué está verificado, qué está configurado pero sin validar, y qué directamente
no existe todavía. Este documento es para que nadie se lleve una sorpresa al
clonar el repo.

## Resultados exactos de esta corrida

| Comando | Resultado |
| --- | --- |
| `npm test` | 16 archivos, **145 tests**, todos pasan |
| `npm run typecheck:all` | limpio (`electron/**` y `src/**`, `--noEmit`) |
| `npx --no-install vitest run --config docs/qa-vitest.config.ts` | 2 archivos, **9 tests**, pasan |
| `electron docs/qa-desktop.cjs` | exit 0, `errors: []`, preload real + IPC |
| `electron scripts/visual-settings.cjs` | exit 0 |
| `electron scripts/visual-documents.cjs` | exit 0 |
| `electron scripts/visual-team.cjs` | exit 0 |
| `node docs/qa-stale-save.cjs` | `agentChangesRetained: true` |
| `npm start` sin `dist/` | sale 1 con la instrucción exacta de qué correr |

Sin inferencia nueva: **ningún comando de esta entrega envía prompts a un
modelo**. Los smokes que sí lo hacen (`smoke:opencode`, `smoke-claude.ts`,
`smoke-codex.ts`) no se ejecutaron.

## Comandos de la release

- `npm ci` + `npm run dev` es el camino probado. No compila nada: Vite sirve el renderer y el proceso principal corre TypeScript por tsx.
- En ese corte, `npm run build` compilaba **solo el renderer** a `dist/` con
  Vite y el proceso principal seguía en TypeScript en tiempo de ejecución. El
  empaquetado y los instaladores todavía no formaban parte de esa entrega.
- `npm start` abre Electron contra `dist/` sin servidor de desarrollo. Si falta `dist/index.html`, se niega e imprime qué correr.
- **Ni `build` ni `start` con `dist/` presente fueron ejecutados en esta entrega.** Están configurados y revisados a mano (`base: './'` en Vite, `main.ts` carga `dist/index.html` cuando no hay `VITE_DEV_SERVER_URL`), pero la validación real queda pendiente. Lo único que sí probé es que `npm start` sin `dist/` falla bien.
- Sin dependencias nuevas.

## Instrucciones de marketing (lo central de este corte)

El problema: la conversación por defecto no recibía ninguna instrucción de
marketing por el canal de prompt del runtime. Solo los roles nombrados tenían
personalidad, y el contexto del workspace llegaba por archivos que el runtime
decide leer o no.

Ahora `packs/marketing-core/base.md` es comportamiento de marketing y lo recibe
**toda conversación, incluida la neutral, en los tres runtimes**:

| Runtime | Canal |
| --- | --- |
| Claude Code | `--append-system-prompt-file` |
| Codex | `developerInstructions` en el hilo |
| OpenCode | campo `system` de cada mensaje |

Qué cubre, en compacto (menos de 6.000 caracteres, hay test que lo limita):

- Marketing primero. Código y diseño son medios de apoyo, solo si el resultado pedido los necesita.
- Antes de recomendar: objetivo, audiencia, oferta, etapa del embudo, baseline y KPI, restricciones. Si falta algo, pide **solo lo que bloquea** o asume explícito y sigue. Prohibido el cuestionario largo y el framework impuesto.
- Evidencia: separa hecho, hipótesis y decisión; exige fuente, fecha y tamaño de muestra; no inventa datos ni presenta un promedio de industria como número de la marca.
- Marca: distingue lo aprobado de lo propuesto; no cambia posicionamiento, claim ni precio en silencio.
- Entregables: produce la pieza real, no su descripción, y cierra con qué cambió, qué queda asumido y el próximo paso.
- Growth: hipótesis con métrica, umbral de éxito, duración, **guardrail** y cadencia de revisión.
- Autoridad: prepara sí, publica/envía/gasta no, salvo pedido explícito y permiso real del runtime.

Los roles nombrados (Estrategia, Investigación, Análisis, Revisión) se apilan
**encima** de esa base, no la reemplazan. Hay test que verifica el orden.

### Correcciones de honestidad

- El encabezado del pack decía `0.1` mientras el manifiesto decía `0.3`. Ahora el encabezado no lleva versión y el manifiesto es `0.4.0`; un test compara ambos.
- Se eliminó una afirmación falsa: *"Latte keeps both versions when two writers disagree"*. Eso vale para un guardado hecho **a través de Latte**; una escritura directa de un agente al archivo no se intercepta, reemplaza el contenido y Latte se entera después. El texto nuevo lo dice así, en el pack y en los archivos generados.

## Qué prueban los tests y qué no

| Afirmación | Cómo se verifica | Estado |
| --- | --- | --- |
| Las instrucciones llegan a cada runtime | `tests/backend/prompts.test.ts`, con los protocolos falsos de los tres runtimes | **Verificado** |
| El prompt contiene los comportamientos prometidos | Chequeos léxicos sobre el texto compuesto | **Verificado** |
| El asistente neutral recibe la base y ningún rol | Test dedicado + test de integración por OpenCode | **Verificado** |
| El modelo **obedece** esas instrucciones | Fixtures en `docs/marketing-eval/`, corrida manual contra un modelo real | **Pendiente** |

Esto último importa: un test léxico prueba que el texto viaja, no que el modelo
haga caso. Las seis fixtures cubren plan con datos completos, pedido sin datos,
violación de regla de marca, experimento de growth, lectura de resultados con
muestra chica y pedido de publicar. Hay que correrlas a mano, con una marca de
prueba, y anotar modelo, runtime y fecha.

## Limitaciones reales

- **En este snapshot solo se había probado Windows 11.** Las ramas POSIX
  estaban escritas, pero todavía no se habían ejercitado en vivo. Linux x64 se
  validó y empaquetó después; ver [`RUN-linux.md`](RUN-linux.md).
- **En este snapshot todavía no había instalador ni empaquetado.** La
  distribución era por código fuente; esa limitación histórica ya no describe
  la alpha actual.
- **Las instrucciones no son un sandbox.** Latte le da al agente la carpeta del trabajo como contexto y se lo dice en el prompt, pero un runtime puede escribir cualquier archivo al que tenga permiso del sistema operativo. Quien aplica permisos de verdad es cada runtime; Latte muestra sus pedidos para que el humano decida. No se garantiza que toda acción de un agente esté contenida.
- **Una escritura externa no identifica autor.** Queda registrada como `external`, nunca atribuida al rol activo.
- **La detección de cambios externos es por sondeo cada 2,5 s**, no es tiempo real.
- **Sin merge semántico**: ante un conflicto se elige una variante entera y la otra queda como versión.
- Sin publicación en redes, sin scheduling, sin integraciones, sin colaboración entre personas, sin cuentas de equipo.
- La inferencia la paga la cuenta del usuario. La vista web no ejecuta agentes.
- El estado de los miembros del equipo se deriva en vivo: tras reiniciar la app todos aparecen en pausa.

## Pendiente inmediato

1. Correr `npm run build` y `npm start` una vez y anotar el resultado. Si `dist/` queda en el repo, el `.gitignore` tiene que excluirlo (lo mantiene el coordinador).
2. Correr las seis fixtures de `docs/marketing-eval/` contra al menos un modelo real y llenar `results.md`.
3. Abrir la app con la base de datos real una vez para confirmar la migración a v4 en el lugar.

## Archivos de este corte

- `packs/marketing-core/base.md` (nuevo), `manifest.json` 0.4.0, `instructions.md`, roles.
- `electron/workspace/{packs,instructions}.ts`, `electron/agents/roles.ts`.
- `scripts/start.mjs` (nuevo), `package.json` (`build`, `start`).
- `tests/backend/prompts.test.ts` (nuevo, 11 tests), ajustes en `team.test.ts` y `chat.test.ts`.
- `docs/marketing-eval/{fixtures.json,README.md}` (nuevos).
- `README.md`: español primero, comandos honestos, límites de alpha.
