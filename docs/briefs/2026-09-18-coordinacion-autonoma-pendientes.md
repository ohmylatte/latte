> **Superado** por `2026-09-20-coordinacion-autonoma-cierre.md`. Este documento queda como historia del estado en `39fb0f4`.

# Coordinación autónoma: lo que quedó pendiente

**Estado**: la rama `gabogabucho/latte-orchestration` termina en `39fb0f4`, con la suite verde
(153 archivos, 1601 tests, typecheck limpio). **No está lista para mergear.** Este documento
dice por qué, con el detalle suficiente para retomar sin releer doce commits.

Origen: el plan completo (98 tareas) se implementó, y después se le pasaron tres rondas de
revisión adversarial con dos jueces ciegos independientes. Esas revisiones encontraron más de
cuarenta defectos reales, **todos con la suite en verde**. Se aplicaron unos treinta y siete
arreglos en cuatro rondas. La tercera ronda de juicio volvió con doce críticos nuevos, y ahí
se cortó.

---

## Lo que sí funciona

El camino conversacional está construido y probado de punta a punta, entrando por donde entra
una persona (no llamando al motor directamente):

```
un miembro abre y recibe sus herramientas por MCP
  → escribís "coordiná al equipo y preparen el contenido del mes"
  → el agente propone un plan concreto: tareas, quién hace cada una, a quién sumar y por qué
  → aparece una propuesta para leer, con aprobar / aprobar editando / rechazar
  → una aprobación concede permiso, presupuesto, autoridad, altas y tareas
  → sale el primer despacho
```

También está resuelto y probado:

- **Marcas en paralelo.** Dos marcas coordinando a la vez no comparten buzón, presupuesto ni
  equipo. Los cuatro tests de aislamiento pasaron sin tocar producción: el diseño ya lo
  contemplaba.
- **Memoria de marca por defecto.** Todo miembro arranca con engram inyectado, con o sin
  coordinación, con el flag prendido o apagado.
- **El protocolo MCP real.** `initialize` / `tools/list` / `tools/call`, versión `2025-06-18`,
  traída de la especificación y corroborada contra un servidor real.
- **La migración v11 → v12** sobre una base con datos reales: 30 → 38 tablas, cero filas
  perdidas, idempotente, con backup automático previo.

---

## La causa raíz, que explica casi todo lo demás

Casi todos los defectos encontrados son **la misma decisión de diseño repetida**:

> Se lee un estado, se espera algo lento —levantar un proceso de agente, segundos de ancho— y
> se actúa sobre el estado que se leyó antes de esperar.

Durante esos segundos el mundo cambia: la persona cancela, otro miembro se muere, entra otro
despacho, se apaga el interruptor. Cualquier decisión tomada antes del `await` ya es vieja
cuando se ejecuta.

Se arregló en `startDispatch`. Apareció en `assign()`. Se arregló. Apareció en `cancelRun`.
Apareció en `serverFor`. Apareció en los ceilings de procesos. **Veinte instancias del mismo
problema**, y cada ronda tapó las que le señalaron.

Por eso se cortó: parchar la vigésima no acerca a la primera.

**El rediseño que corresponde**: que el estado se lea y se comprometa en el mismo instante —
un compare-and-set contra la base, antes de cualquier espera — y que lo lento ocurra después,
con compensación explícita si falla. El patrón ya existe bien hecho en un lugar
(`claimCoordinationTaskForDispatch`); falta aplicarlo en el resto.

---

## Los críticos pendientes

### 1. Los runs nunca terminan

`electron/coordination/engine.ts` — ningún `updateCoordinationRunStatus` escribe `done`. Solo
`running`, `suspended` y `cancelled`.

Cuando la última tarea reporta y no queda nada pendiente, el run queda `running` **para
siempre**. Consecuencias en cadena: ocupa uno de los cuatro cupos de `MAX_ACTIVE_COORDINATION_RUNS`
(a los cuatro equipos terminados **nadie puede coordinar nunca más**), su gasto sigue contando
contra el tope global, bloquea un segundo equipo en ese trabajo por el índice único parcial, y
la tira de equipos activos muestra como vivo algo que terminó. La única salida es Cancelar, que
la interfaz presenta como aborto de emergencia.

**Esto no es un descuido de implementación: el estado final nunca se diseñó.** Es el arreglo más
importante y el más barato.

### 2. Destildar una contratación no la impide

`engine.ts:468-471` arma el snapshot de roles aprobados desde `proposal.plan` **y**
`membersToHire`; `DecisionsView.confirmEdit` filtra solo `membersToHire`. Como el hire existe
*porque* el plan lo necesita, el rol queda en `approvedRoles` igual. Al primer despacho,
`resolveTargetMember` lo contrata y levanta el proceso, sin gate.

La interfaz renderiza un rechazo que el motor ignora.

### 3. Cancelar no detiene un despacho en vuelo

`startDispatch` lee `run.status` antes del `await` que levanta el proceso, y la transacción
nunca lo vuelve a leer. Cancelás, el barrido no encuentra esa tarea porque todavía no existe, y
el despacho commitea y manda igual. Probado:

```json
{"runStatusAfterCancel":"cancelled","hubSendCalls":1,"openReservations":1}
```

`pauseRun` tiene el mismo agujero, contra su propia documentación.

### 4. Un `null` rompe la interfaz de todas las marcas

El esquema publicado de `latte_request_coordination` permite `estimatedDispatches: null`, y
`requestCoordination` no valida. Ese `null` produce un `budget_json` que
`requireCoordinationBudget` rechaza, así que `listActiveCoordinationRuns()` —la tira global, de
**todas** las marcas— tira error. Y como `tools.ts:32` llama a `budgetBlockForEnvelope` fuera de
su propio try, toda llamada MCP posterior de ese trabajo escapa como HTTP 500.

### 5. Una muerte de proceso deja todo colgado

El evento `closed` llega a `injection.release` pero nunca a `settleUncertain`. Un agente que se
cae deja su tarea `dispatched` y su reserva abierta para el resto de la sesión: no hay reintento,
el cupo de presupuesto queda quemado, y el run no puede terminar. `settleUncertain` documenta un
modo `incrementAttempts: true` "para la muerte de un proceso" que **no tiene ningún llamador**.

### 6. El interruptor no apaga lo que ya está andando

`resolveGate` y `resolveProposalGate` no consultan `requireCoordinationEnabled()`. Con el flag
apagado a mitad de vuelo, aprobar una propuesta pendiente igual contrata, levanta procesos,
escribe el permiso, el presupuesto y la autoridad. Solo el despacho siguiente se bloquea.

### 7. Se sigue afirmando lo que no se verificó

En Codex, `reportInjected` cae en `catch { return requested }` ante cualquier fallo —devolviendo
lo que Latte *pidió* como si fuera lo que el runtime *conectó*—, y aun en el camino feliz filtra
por nombre sin mirar `authStatus`. El lado de Claude sí lo hace bien (`status === 'connected'`).

### 8. Dos lectores del mismo dato con semánticas opuestas

`getCoordinationGlobalBudget` devuelve `null` ("sin tope") ante un JSON ilegible;
`readGlobalBudget` **tira** ante los mismos bytes, y tirar deniega. La pantalla dice "sin tope
global" mientras cada despacho falla con un error opaco.

### 9. Fugas de procesos que nadie puede recuperar

Cuando `ensure()` o `thread/start` fallan en Codex, el proceso ya existe y no se apaga; y como
el `serverKey` lleva un token aleatorio adentro, **nadie puede recomputar esa clave nunca**. El
proceso queda inalcanzable, contando contra el cupo, sin archivo de pid que permita barrerlo al
próximo arranque.

### 10. Los ceilings son check-then-act entre miembros distintos

`assign()` lee los cupos, hace dos `await`, y recién después marca. Los locks existentes son por
miembro, así que dos miembros distintos abriendo a la vez leen la misma foto de "hay lugar" y
ambos entran. Es el mismo patrón de la causa raíz.

### 11. `confirmInjection` libera el cupo pero deja el token vivo

Al detectar que el runtime rechazó la inyección, borra la marca de coordinado pero no revoca ni
desmarca el token como entregado. Resultado: otro miembro puede pasarse del cupo mientras el
rechazado sigue teniendo una credencial que funciona, y el servidor local no se puede apagar
nunca.

### 12. Cosas que se prometen y no existen

- `touch()` hace I/O de disco y puede **reescribir el CLAUDE.md/AGENTS.md del trabajo** en cada
  cambio de estado, solo para leer un `brandId`.
- "Desde tu última visita" no mide ninguna visita: no hay timestamp persistido en ningún lado.
- `coordinationHires` está testeado en tres archivos y **no tiene fuente de datos**.
- `latte_dispatch` publica un parámetro `approvedGateId` que su handler descarta.
- `editedPrompt` llega sin validar hasta un agente levantado.

---

## Tests que pasan por la razón equivocada

Vale tanto como la lista de arriba, porque explica cómo convivieron 1601 tests verdes con todo
esto:

- **La suite es CRLF.** Cualquier aserción que escanee el fuente buscando un `\n` literal
  **nunca matchea**. El test del choke point único —el que vigilaba la invariante central del
  diseño, que haya una sola puerta al despacho— fue ciego toda su vida por esto. Usar `/\r?\n/`.
- **Ventanas con `indexOf` sin verificar que encontraron su ancla.** Un `-1` convierte
  `slice(-1)` en el último carácter del archivo y la aserción negada pasa por vacío.
- **Loops que iteran cero veces.** `.every()` sobre una lista vacía es `true`. El test de
  aislamiento entre marcas —el que prueba que la marca A no ve a la B— pasa si ambas listas
  vuelven vacías. Siempre assertar el largo primero.
- **Regexes demasiado flojas.** `/empty|vac/` también matchea "vacuum".
- **Dos arreglos de la ronda 4 shipearon sin un solo test**: `sweepUncertainDispatches` y la
  compensación de `hub.send`.

Regla que sale de todo esto: **cualquier test cuyo cuerpo dependa de encontrar algo tiene que
fallar cuando no lo encuentra.**

---

## Conocido y aceptado a propósito

No son pendientes; son decisiones tomadas con los ojos abiertos:

- **El argumento `project` de una herramienta de engram le gana al `--project` fijado.** Probado
  contra el binario real. El aislamiento de memoria entre marcas descansa en una instrucción del
  prompt, no en una invariante. Se declara, no se tapa. Arreglo correcto: un modo en engram que
  fije el proyecto y rechace overrides (issue upstream, es MIT y acepta contribuciones).
- **No hay camino de UI ni de operación para prender `feature:coordination`**, igual que los
  otros tres flags del repo.
- **No existe productor de mensajes**, por eso `latte_check` documenta que devuelve vacío.
- **`maxTokens` / `maxCostMicros` / `maxWallMinutes`** se registran en 0 y nunca disparan.
- **El FK de `coordination_cost_ledger`** contra el trigger `no_delete` hace que un `Work` que
  registró gasto no se pueda borrar. Es latente (hoy no hay borrado; las marcas se archivan). Se
  intentó arreglar con una reconstrucción de tabla y **se revirtió**: la reconstrucción no era
  atómica y podía dejar la aplicación sin abrir, o borrar el ledger entero en silencio, sin
  backup. Cambiar una bomba latente por una activa es mal negocio. Queda documentado en el
  esquema, y necesita una migración atómica con backup forzado cuando llegue el borrado de Works.

---

## Por dónde retomar

1. **Los runs terminan** (crítico 1). Es el más barato y el que desbloquea el producto.
2. **El checkbox de contratación se respeta** (crítico 2). Es una mentira en la cara del usuario.
3. **Recién ahí**, el corte de diseño del camino de despacho: leer y comprometer en el mismo
  instante, lo lento después, compensación explícita. Eso ataca los críticos 3, 5, 9, 10 y 11
  juntos, en vez de de a uno.
4. El QA manual con la máquina llena sigue pendiente: los techos de 6 y 10 procesos de Codex son
  un juicio, no una medición, y nunca se probaron contra hardware real en Windows. El guion está
  escrito.

## Referencias

El detalle completo de cada ronda está en engram, bajo `latte/judgment-round2-veredicto`,
`latte/judgment-round3-escalado`, `latte/tests-crlf-blind` y las series
`sdd/autonomous-coordination/*`.
