# Coordinación autónoma: cierre

**Estado**: la rama `gabogabucho/latte-orchestration` termina en `7cf90b6`, con la suite verde
(224 archivos, 2145 tests, 1 skipped, typecheck limpio). Son 94 commits sobre el brief anterior
(`07d2de6`) y 108 sobre `upstream/main`. **Está lista para mergear detrás del flag**, con las
condiciones de la sección "Antes de prenderla". Reemplaza a
`2026-09-18-coordinacion-autonoma-pendientes.md`, que queda como historia.

---

## Qué se cerró

Los doce críticos del brief anterior, todos con test que entra por la capa real (IPC, JSON-RPC
del servidor MCP de producción, o evento de proceso), y verificados por jueces adversariales
con sabotaje del código de producción:

| # | Crítico | Cómo quedó |
|---|---|---|
| 1 | Los runs nunca terminan | `done` cuando todas las tareas son `done`/`failed`, sin reservas ni despachos abiertos, sin preguntas vigentes, y con el coordinador fuera de turno. Reparación idempotente al arrancar. |
| 2 | Destildar una contratación no la impide | Roles aprobados = solo `membersToHire`; miembros existentes en vivo. La UI recorta el plan a la vista; el motor rechaza planes con roles incumplibles. |
| 3 | Cancelar no detiene un despacho en vuelo | La transacción de confirmación relee el run Y la tarea (token de reclamo) antes de cualquier escritura. |
| 4 | Un `null` rompe la UI de todas las marcas | Todo argumento MCP se valida contra el esquema publicado; presupuestos con parser discriminado; lectura tolerante por fila. |
| 5 | Una muerte de proceso deja todo colgado | `closed` liquida en caliente; el tick de 30 s barre lo que el hub dice muerto. |
| 6 | El interruptor no apaga lo que ya anda | Aprobar, reanudar y contestar-reactivar exigen el flag; rechazar y cancelar nunca. |
| 7 | Se afirma lo que no se verificó | Codex y Claude reportan solo lo que el runtime confirmó; OpenCode dice que no informa. |
| 8 | Dos lectores con semánticas opuestas | Un parser para todos los presupuestos; `invalid` deniega y se muestra. |
| 9 | Fugas de procesos irrecuperables | Pid registrado antes de `initialize`; fallo de arranque mata el hijo. |
| 10 | Ceilings check-then-act | Cupos reservados antes de esperar, en una sola fuente. |
| 11 | `confirmInjection` deja el token vivo | Revoca, toma el slot de memoria, no degrada por estados transitorios. |
| 12 | Cosas prometidas que no existen | `touch()` sin I/O; última visita medida por acto de la persona; contrataciones con fuente; parámetros publicados que existen. |

Y lo que salió de nueve rondas de juicio sobre el código nuevo (unos ciento cincuenta hallazgos
cerrados), entre ellos tres estructurales que no estaban en el brief:

- **Había dos instancias del motor** (la del servicio y la del servidor MCP) y el estado en memoria
  vivía en una sola. Hoy hay una, y un test cuenta cero construcciones de motor en bootstrap.
- **Las lecturas escribían.** `listGates`/`listOpenAsks` vencían preguntas y podían cerrar runs.
  Hoy leer es leer; un tick del servicio cada 30 s hace los barridos.
- **La vida de un despacho la dice el adaptador**, no la tabla ni el reloj. El umbral de 30
  minutos es respaldo para filas sin dueño, y esperar una pregunta nunca cuesta un intento.

---

## El principio, y dónde faltó

> Toda decisión sobre un recurso compartido se reserva sincrónicamente antes de esperar; lo
> lento pasa después; al volver, se confirma releyendo dentro de la misma transacción, o se
> compensa.

Se aplicó a siete sitios en el corte de diseño y sostuvo seis rondas de jueces. Falló una vez,
por mi propia mano: el barrido de huérfanos agregó un escritor de la tarea durante el `await`
del spawn, y la confirmación releía el run pero no la tarea. Se cerró con un token de reclamo
(`updated_at` del reclamo, confirmado con compare-and-set) y con la regla que faltaba escribir:
**cada `await` del despacho tiene tres salidas (éxito, el run cambió, el spawn falló), y el
token vale en las tres.** La revisión acotada al commit del token encontró que estaba en una.

---

## Decisiones de diseño que no estaban en el brief

- `failed` es terminal (agotar intentos, dependencia fallida, rol no contratado); `blocked` es
  solo "esperando una pregunta" y siempre vuelve a `ready`.
- Un run no cierra con preguntas abiertas ni mientras el coordinador tiene un turno en curso.
- Pausar un miembro o cambiarle el modelo no cobra intento; morir sin `closed` tampoco; terminar
  el turno sin reportar, sí.
- Una propuesta con un rol que nadie puede hacer se rechaza donde nace (el agente la rehace).
- Tres mapas de errores en el renderer: coordinación, marca, y genéricos de toda la app. Un test
  estructural deriva los códigos del fuente y falla ante uno sin frase.
- La visita a un Trabajo la anota un acto explícito de la persona, una sola vez, después de que
  cargó lo que fue a ver.

---

## Riesgos y pendientes, sin anestesia

**Lo que ningún juez puede ver.** Todo lo anterior se verificó con fakes herméticos. No hubo QA
de punta a punta con procesos reales de Claude y Codex después de estos cambios. Los techos de
procesos (6 y 10) siguen siendo un juicio, no una medición, y nunca se probaron en Windows con la
máquina llena. Ahí vive el riesgo que queda.

**Restos conocidos del último arreglo** (documentados en el código, sin decisión tomada):

- `updated_at` como token de reclamo es una aproximación. El arreglo definitivo es una columna
  `dispatch_claim_id` (esquema v13). Hoy una colisión requiere dos escrituras en el mismo
  milisegundo sobre una tarea liberada hace 30 minutos.
- Si un spawn colgado contrató un miembro fresco y el re-despacho reutilizó ese mismo miembro a
  medio levantar, la compensación del primero puede despedir al proceso del segundo. Necesita una
  decisión: reservar el alta hasta el commit, o no compensar altas que otro reclamó.
- El `catch` de `hub.send` reescribe su propia fila sin token; `settleUncertain` cancela sin
  `outcome`.
- `CONTEXT_STALE` (editor de contexto de marca) llega sin frase. `suspendReason` no se renderiza
  en ninguna pantalla.

**Deuda preexistente que los jueces señalaron y no era de esta feature**: sin CSS para las clases
nuevas de run terminado y altas tachadas; sin ErrorBoundary en el renderer; `i18n-generated.ts`
con traducciones EN rotas; dos tests flaky bajo carga (`economy.test.ts`, `agents.test.ts`).

**Memoria.** Engram estuvo caído durante las rondas 2 a 10. El detalle vive en los mensajes de
commit (`git log 07d2de6..7cf90b6`) y en este documento. Hay que reponerlo cuando vuelva.

---

## Antes de prenderla

La coordinación llega apagada (`feature:coordination`, sin interruptor de UI). Lo que sí entra
prendido es la memoria por defecto (engram inyectado a cada miembro), verificada con datos reales
antes de los juicios, con migración v11 → v12 idempotente y backup previo.

1. **Mergear detrás del flag.** Cero exposición a personas; frena la deriva de 108 commits.
2. **QA manual con procesos reales**, con el guion `sdd/autonomous-coordination/qa-script`: un
   equipo de tres, propuesta desde una frase, aprobar editando, un despacho que pregunta, una
   pausa a mitad de spawn, cancelar con dos en vuelo, cerrar la app con uno en vuelo y reabrir.
   Medir los techos de procesos en Windows con la máquina llena.
3. **Decidir cómo se prende el flag**, y para quién. Recién ahí es una feature para usar.

---

## Lo que aprendimos del proceso

- **El loop de jueces ciegos no converge a cero por construcción.** Cada iteración escribe diez
  arreglos y dos jueces adversariales encuentran uno o dos en ese código. El criterio de parada
  honesto es "N rondas sin hallazgos en el núcleo", no "veredicto limpio". Desde la ronda 3 lo
  único que volvió al núcleo fue el token, y fue por un diseño mío.
- **Dos jueces saboteando producción en el mismo worktree se pisan.** Desde la ronda 2, solo
  lectura y repros con nombre único.
- **Un test que modela la muerte de un proceso borrando la fila del miembro no prueba nada**: el
  hub real deja la fila y publica `paused`.
- **Un comentario que describe un cableado que ya no existe es cómo se cuela el próximo bug**
  ("son proxies sin estado", "el umbral cubre el alta no publicada").
- **La suite es CRLF**, y un literal `\n` en un test que escanea fuente nunca matchea.
