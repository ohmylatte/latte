# QA manual de la coordinación autónoma, con procesos reales

Este guion existe porque todo lo que sostiene la coordinación se verificó con fakes herméticos.
Acá se prueba lo que ningún test puede: procesos reales de Claude Code y Codex, la máquina
llena, y una persona mirando la pantalla. Cada paso dice qué hacer y qué tiene que verse. Si
algo se ve distinto, es un hallazgo: anotarlo con la hora y el estado de la tira de equipos.

Tiempo estimado: dos horas. Requisitos: Claude Code y Codex instalados y logueados; el binario
`engram` en el PATH; una instalación de prueba separada de la de uso.

---

## 0. Instalación de prueba con la coordinación prendida

1. Elegir una carpeta vacía para los datos y arrancar la app apuntando ahí:

   ```
   LATTE_DATA_DIR=C:\latte-qa npm run dev
   ```

   La primera vez crea la base con el esquema v12. Cerrar la app.

2. Prender el flag escribiendo la fila en la tabla `meta` de la base que quedó dentro de
   `C:\latte-qa` (con `sqlite3` o cualquier cliente):

   ```sql
   INSERT OR REPLACE INTO meta (key, value) VALUES ('feature:coordination', 'on');
   ```

   No hay interruptor de interfaz ni de operación: esto es a propósito, y es lo que se decide
   en el paso 3 del cierre.

3. Volver a arrancar. Crear una marca y un trabajo.

**Qué tiene que verse**: en Decisiones, la sección de coordinación existe y muestra el
presupuesto del trabajo como "sin configurar". La memoria de marca aparece como disponible en
cada miembro nuevo (si `engram` no está en el PATH, tiene que decir que no está, nunca
"conectado").

---

## 1. Un equipo de tres, desde una frase

1. Sumar tres miembros: un estratega en Claude Code, un redactor en Codex, un analista en
   Claude Code. Esperar a que los tres arranquen.
2. En el chat del estratega, escribir: «coordiná al equipo y preparen el contenido del mes».

**Qué tiene que verse**: aparece una propuesta en Decisiones con tareas concretas, quién hace
cada una, y a quién sumar (si propone un rol que no está en el equipo). Cada rol del plan tiene
cobertura: alta, miembro existente, o huérfano. Un plan con un rol que nadie puede hacer no
debería llegar nunca: el agente recibe el rechazo y vuelve a proponer. En Inicio, la fila
"te espera una aprobación" aparece para ese trabajo.

---

## 2. Aprobar editando

1. Abrir "Editar y aprobar". Bajar el tope de despachos a 4. Destildar una contratación.
2. Confirmar.

**Qué tiene que verse**: antes de confirmar, el plan muestra recortadas las tareas de ese rol
(y las que dependían de ellas, tachadas aparte, con el contador). Si un alta quedó sin tareas
por el arrastre, lo dice. Después de confirmar, el editor cierra, el run pasa a "en curso", los
miembros nuevos aparecen en el equipo, y la bitácora de altas los lista. El presupuesto del
trabajo muestra 4 despachos.

Variante: forzar un error al confirmar (por ejemplo, un plan con dependencias más profundas que
20). **Tiene que verse**: el editor NO cierra, las casillas quedan como estaban, y el error se
lee en el idioma de la interfaz. No reaparece un "Aprobar" simple.

---

## 3. Un despacho que pregunta

1. Con autoridad `manual`, aprobar el primer gate de despacho.
2. Esperar a que el worker (Codex) empiece. En su chat, pedirle que use `latte_ask` para
   preguntar algo sobre su tarea.

**Qué tiene que verse**: la pregunta aparece en Decisiones con su plazo. El run sigue "en
curso" (el worker está trabajando; no se suspende por su propia pregunta). Responder: el
worker puede leerla con `latte_ask_status`, y si la tarea se vuelve a despachar, la respuesta
viene en el prompt. Dejar vencer otra pregunta (pedirle al worker un `ttlMinutes` de 10; el default es 30): a los 30 segundos del
vencimiento desaparece de la lista y contestarla da "ya no esperaba respuesta".

---

## 4. Pausar a mitad de arranque

1. Aprobar un gate cuyo rol requiere un alta (un proceso nuevo).
2. Mientras el proceso está levantando (los primeros segundos), pausar el equipo desde el
   panel.

**Qué tiene que verse**: el run queda "suspendido" con motivo de pausa. Cuando el proceso
termina de levantar, NO recibe la tarea: la bitácora muestra el despacho abortado por run no
activo, sin reserva abierta, y el miembro recién contratado no queda vivo sin tarea (se
compensó) o queda ocioso en el equipo, pero nunca trabajando. Reanudar: el despacho vuelve a
salir desde cero.

---

## 5. Cancelar con dos en vuelo

1. Con autoridad `auto` y dos tareas independientes, dejar que dos workers trabajen a la vez.
2. Cancelar el equipo.

**Qué tiene que verse**: los dos procesos reciben la cancelación (sus chats lo muestran), las
dos reservas se cierran, la tira de equipos muestra el run como cancelado con el conteo de
tareas hechas y pendientes, y Decisiones no ofrece ningún gate vivo. Un `latte_report` tardío
de cualquiera de los dos responde "sin run activo", no un error interno.

---

## 6. Cerrar la app con uno en vuelo, y reabrir

1. Nuevo run, un worker trabajando.
2. Cerrar la app (no matar el proceso: cerrar).
3. Reabrir.

**Qué tiene que verse**: al arrancar, el barrido liquida el despacho que quedó abierto (la
reserva se cierra, la tarea vuelve a la cola sin cobrar intento) y no queda ningún
`codex app-server` huérfano en el administrador de tareas. El run sigue "en curso" y el
siguiente despacho sale normal. Si el run había terminado justo antes de cerrar, arranca como
"terminado", no como "en curso".

---

## 7. La máquina llena: los techos

Los techos de Codex son un juicio, no una medición: 3 miembros coordinados por run, 6
procesos coordinados en toda la app, 10 app-servers en total. Este paso los mide.

1. Cuatro trabajos, cada uno con su run, en la misma marca o en marcas distintas.
2. Ir sumando miembros de Codex coordinados hasta que el sistema diga que no.

**Qué tiene que verse**: el cuarto run es el último (el quinto rebota con "demasiados equipos
activos", nombrando cuáles). Al séptimo Codex coordinado, el miembro arranca con memoria pero
sin coordinación, y lo dice. Anotar: uso de memoria y CPU con seis app-servers vivos, y si
alguno se cae solo. Ese número es el que decide si los techos suben, bajan o se quedan.

---

## 8. Lo que hay que anotar al final

- Cada estado que se vio distinto de lo esperado, con hora y captura de la tira de equipos.
- Consumo con la máquina llena (paso 7).
- Si algún proceso quedó huérfano después de cerrar la app.
- Cuánto tardó cada spawn de Codex y de Claude (importa para el barrido de 30 minutos).

Con eso se decide el paso 3: cómo se prende el flag, y para quién.
