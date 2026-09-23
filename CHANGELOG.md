# Changelog

## 1.3.0 — 2026-09-23

Latte se conecta por vos a los servidores MCP que piden login, y el equipo aprende a terminar: cerrar un trabajo apaga a quienes convocó, y el chat de equipo pasa a ser un solo lugar donde le hablás al coordinador y ves todo lo que pasa.

### Conexiones

- **Latte hace el login OAuth por vos.** Un servidor MCP con OAuth no se podía conectar a un miembro: el login del CLI sólo existe en modo interactivo. Ahora Latte abre la ventana de login, guarda los tokens cifrados y los refresca solo. theagentcy funciona.
- **Una sola pantalla, en Ajustes → Conexiones**, con todas las conexiones: las globales y las de cada marca, con su estado. Al agregar una elegís si vale para todas las marcas o para una.
- **Cada miembro recibe las conexiones de su marca** sin ver el login ni el token: le llegan por un endpoint local de Latte, y la de marca gana sobre la global para el mismo servidor.
- **Si una sesión vence a mitad de un trabajo**, aparece «Volver a entrar» en el chat del miembro y nadie se reinicia.
- **Herramientas (MCP) desaparece del menú.** Lo que tenías registrado en tus CLI queda en sólo lectura, con un botón para importarlo.
- **Meta queda para después**: requiere una app propia registrada.

### El equipo

- **Cerrar el run apaga a los convocados.** Quien está a mitad de un turno se pausa al terminarlo, y el coordinador sale último. El encabezado dice «Terminamos · N de M», con un solo botón: «Nuevo pedido».
- **El chat de equipo es el modo Equipo.** Un cuadro de texto al pie le habla al coordinador, y una sola lista junta tus mensajes, sus respuestas, los despachos, los reportes y las preguntas. El coordinador ya no tiene pestaña propia.
- **Un traspaso sin run se vuelve propuesta, solo.** Si un miembro le pide algo a otro rol y no hay run activo, queda «Propuesta lista · Aprobar» y aprobar despacha. Nunca más un borrador pegado.
- **«Lo que produjo el equipo» caduca.** Un run cancelado es una línea con acceso a la bitácora; uno terminado se ve completo 24 h y después se pliega.
- **La tira de equipos activos** en la barra lateral es una fila por equipo, con tope de tres y sin los terminados.
- **La línea «Plan aprobado» se va al abrir el equipo** y no vuelve para ese run.

### Chat

- **Las preguntas con opciones de Claude Code se muestran y se responden en el chat**, con «Otra respuesta» si ninguna opción sirve.
- **El Asistente propone coordinación** cuando el trabajo es de otro rol, en vez de hacerlo él.
- **Las ventanas de login llevan el ícono de Latte.**
- **Un miembro que ya no está** se dibuja con un avatar neutro, sin iniciales inventadas.

### Conocido

- OpenCode todavía no recibe conexiones: su servidor es uno solo por proceso y el acceso quedaría compartido entre marcas.
- Meta necesita una app registrada para conectarse.
- El avatar de un rol todavía no se exporta como PNG, y los archivos que produce una tarea se siguen leyendo del texto del reporte.
- El plantel por marca viene en la próxima.

## 1.2.0 — 2026-09-22

El equipo deja de ser un montón de conversaciones sueltas. Pedís en el chat, aprobás una vez, y el equipo se organiza solo: despacha, se reporta y consolida. También estrena cara propia por rol y memoria de marca por defecto.

### El equipo se coordina solo

- **Pedís en el chat y aprobás una vez.** Le contás lo que querés a cualquier miembro; si hace falta un equipo, propone un plan con las tareas, quién las haría y cuántos despachos estima. Vos aprobás (o rechazás, o editás) UNA vez, y a partir de ahí el equipo trabaja: despacha las tareas, cada miembro reporta lo suyo y el coordinador consolida el resultado.
- **Las preguntas vuelven al chat.** Si un miembro necesita algo tuyo para seguir, la pregunta aparece donde ya estás mirando, no en una bandeja aparte.
- **Modo Equipo**: una línea de tiempo por miembro, con lo que cada uno recibió, hizo y devolvió.
- **Bitácora en `agents.log`**, dentro de la carpeta del trabajo: lo que pasó queda escrito en texto plano, legible sin abrir Latte.
- **Viene prendida**, con un interruptor en Ajustes → Avanzado para apagarla si preferís un equipo de conversaciones sueltas.
- **Un presupuesto de despachos**, por trabajo y opcionalmente para toda la instalación: no hay «ilimitado» implícito, siempre lo elegís vos.

### Cada rol tiene su cara

- **Avatares propios**: el color sale del rol, la cara de una semilla, y hay doce accesorios. Al crear o editar un rol elegís entre ocho caras, también en los roles que Latte ya trae.

### Memoria

- **La memoria de marca viene puesta** (engram): lo aprendido de una marca viaja entre trabajos sin que haya que cablear nada.
- **Migración v11 → v12 con backup**: se hace sola al abrir, y deja una copia antes de tocar nada.

### Correcciones

- **Los adjuntos ya no se mandan solos.** Adjuntar un archivo enviaba el mensaje sin que lo pidieras.
- **Los errores de Claude Code y Codex se ven de verdad.** Cuando un runtime fallaba, la pantalla mostraba una frase genérica en vez de lo que el agente realmente dijo.

### Conocido

- El avatar de un rol todavía no se puede exportar como PNG.
- Los archivos que produce una tarea se leen del texto del reporte: si el reporte no los nombra, Latte no los lista.

## 1.1.0 — 2026-09-17

Primera versión de la familia 1.x. Es una release de correcciones: nada nuevo que aprender, varias cosas que dejan de estar mal. La mayoría se encontró revisando el producto antes de publicarlo, no después de que alguien se tropezara.

### Navegación

- **La barra de pestañas ya no se muda.** Estando en Documentos, Embudo o Decisiones aparecía arriba; en Resumen, Trabajo, Evidencia o Resultados caía al pie del contenido. La barra con la que navegás un trabajo era lo único que no se quedaba quieto.
- **Los links a un documento abren el documento.** «Abrir el brief» en el Resumen, una fila de «pendientes de revisión» en Inicio y elegir una pieza en el Embudo llevaban a la conversación, con el documento detrás de una pantalla inerte. Había que tocar «Revisar» a mano para ver lo que se había pedido.
- La barra lateral no marcaba el trabajo abierto mientras mirabas el Embudo.

### Lo que un agente tiene permitido

- **El modo de permisos ya no se cruza entre trabajos.** Cambiando rápido de un trabajo a otro, la respuesta del anterior podía llegar tarde y pisar la del actual: un trabajo que pide permiso antes de cada acción podía mostrarse como automático. Ese valor decide si un agente escribe sin preguntar, así que era el peor lugar posible para una carrera.
- Los archivos sueltos para adoptar y los traspasos entre roles también podían quedar mostrando los del trabajo anterior.
- Aprobar, editar, rechazar o archivar una decisión ahora refresca la lista de la marca en la que actuaste, no de la que quedó abierta después.

### Documentos

- **Un guardado lento ya no puede mezclar dos documentos.** Si la escritura resolvía después de que abrieras otro documento, el texto y la huella del primero aterrizaban en el editor del segundo. Con un guardado más, ese texto terminaba en el archivo equivocado.

### Idioma

- **Los documentos nuevos se generan en el idioma de contenido del trabajo.** Las plantillas (estrategia, calendario, investigación, piezas, nota) salían siempre en español, incluso con la interfaz en inglés. El idioma queda fijado por trabajo: cambiar la preferencia después no retraduce lo ya escrito.
- **Las etapas del recorrido y los estados de documento se traducen.** «Consideración», «En revisión» y compañía estaban escritas a mano en seis pantallas.
- **Acentos arruinados en el diccionario.** Veinte textos decían `versi?n`, `conversaci?n` o `?siempre?` en vez de las palabras completas. Estuvo escondido porque las pantallas que mostraban esa copia tenían su propia versión bien escrita al lado; cablearlas al diccionario habría puesto el error en pantalla. Hay un test que ahora lo impide.
- El aviso de versión nueva, los mensajes de conversación reanudada y las ayudas de modelo ya salen del diccionario en los dos idiomas.

### El arranque

- **El splash duraba menos que su propia animación.** Se mostraba 1200 ms cuando el dibujo de la taza necesita 1600 ms, y además aparecía antes de que el lienzo dibujara nada: lo que se veía era un rectángulo de papel en blanco que pestañeaba. Ahora aparece recién con el primer cuadro pintado y se queda hasta que la taza termina.

### Por dentro

- La app empaquetada solo navega a su propio documento, en vez de aceptar cualquier `file:`.
- Se quitó un mapa de etiquetas en español que ya no usaba nadie: código muerto con texto sin traducir es una trampa para el próximo que lo importe.

### Plataformas

Sin cambios: Windows x64 soportado, Linux x64 en empaquetado *alpha*, macOS sin artefacto hasta que haya firma y notarización.

## 1.0.0 — 2026-09-17

Latte deja de ser un editor con chat y pasa a ser un **espacio de trabajo operativo de marketing**. Es la primera versión estable del producto: marca nueva, activación guiada y un workspace reorganizado alrededor de cómo trabajás vos, no de cómo está construido por dentro. Se quitó la etiqueta «ALPHA» de la interfaz.

### La marca

- **Rediseño completo**: la L que humea en óxido plano (`#aa4e31`), estética de edición impresa (papel, pocas tintas, grano) en el sitio, el instalador y el splash de arranque.
- **Sistema de diseño (Capa 1)**: 188 colores sueltos pasaron a **tokens** (`--rust`, `--ink`, `--paper`, `--stage-1..4`, …); tipografías propias empaquetadas (Instrument Serif, Inter Tight, JetBrains Mono); radios y formas unificados; barra lateral en tinta plana.
- **Microinteracciones (Capa 2)**: sello de aprobación (la L en la espuma), taza de carga, vapor por rol trabajando, anillos de versión, etapa vacía del embudo. Todo en SVG/CSS plano, con `prefers-reduced-motion` y sin inventar estado.

### El workspace (BRIEF-02)

Nueve features que reorganizan la experiencia cotidiana:

- **Inicio** orientado a atención: qué cambió, qué necesita tu decisión, qué agente está trabajando, qué hacer ahora.
- **Resumen** por trabajo: objetivo, estado, decisiones pendientes y la siguiente acción recomendada, con el ciclo Observar → Entender → Decidir → Actuar → Medir.
- **Trabajo**: encargo, documentos, permisos y progreso en una sola superficie; «Conversar» abre el agente.
- **Evidencia**: archivos, datos y fuentes agrupados, con hecho / recomendación / decisión distinguidas (cálculo e hipótesis quedan como estados honestos, nunca inventados).
- **Decisiones** unificadas, con el principio explícito: **aprobar un análisis ≠ autorizar un cambio en una cuenta externa**.
- **Resultados**: no solo archivos — documento, decisión, entregable.
- **Embudo accionable**: una etapa vacía propone acciones (analizar, preparar, asociar una pieza, crear un experimento, marcar fuera de alcance).
- **Acción global neutral**: «Nuevo trabajo», con verbos específicos por contexto.
- **Modo simple/avanzado**: la infraestructura (runtime, modelo, terminal, MCP) queda oculta en el modo simple; los **permisos siempre están visibles**.

### Activación (BRIEF-01)

Onboarding marketer-first: entrás con una necesidad de negocio, Latte arma el trabajo, recomienda el rol y te lleva a un primer resultado útil sin jerga técnica (runtime, CLI, MCP, Markdown quedan en «Configuración avanzada»).

### Idioma

- **El idioma de contenido sigue al de la interfaz.** Antes caía a español sin mirar nada, así que una instalación en inglés mostraba la interfaz en inglés y generaba los documentos en español. Se siembra en el primer arranque desde el idioma ya elegido; una instalación que actualiza conserva la elección que hizo la persona.
- **El primer render ya nace en el idioma correcto.** La interfaz arrancaba en español y cambiaba un tick después, cuando llegaba la preferencia: una instalación en inglés parpadeaba en español en cada arranque.
- **Los diálogos del sistema hablan un solo idioma.** Actualizar, cerrar con cambios sin guardar, abrir HTML externo y «no pude abrir tus datos» mezclaban título traducido con botones en español. El diálogo de datos ilegibles corre con la base cerrada, así que ahora usa el idioma del sistema en vez de asumir español.

### Correcciones

- **El recorrido inicial ya no rebota.** Al volver a un paso anterior desde el resumen, la lectura del borrador guardado podía resolver después del click y devolver a la persona al resumen, con la respuesta obligatoria todavía vacía.

### Plataformas

- **Windows x64**: soportado — el único con ejecutable publicado.
- **Linux x64** y **macOS**: **no hay un ejecutable probado.** Los paquetes de Linux se publican en *alpha* (verificado en Linux Mint 22.3 con X11, no en Wayland ni otras distribuciones); macOS no publica artefacto: el workflow exige un build firmado y notarizado, que todavía no está configurado. La vía soportada es correr desde el código.
- El instalador de Windows todavía **no está firmado**.

### Requisitos

Al menos un agente instalado y con tu cuenta: Claude Code, Codex u OpenCode. La inferencia la paga tu proveedor.

### Conocido

- Algunos controles técnicos y acciones tienen cobertura de test parcial (el mapeo de acciones del embudo, el gating del tooltip de runtime). No es regresión: está registrado en `docs/`.
- El preview web (`npm run dev:web`) guarda en el navegador y **no ejecuta agentes**.

---

_Historia 0.x (resumida): 0.1.0 primera instalación verificada en Windows; 0.4.0 archivo/restauración de marcas; 0.5.0 memoria de marca entre trabajos; 0.5.1–0.5.4 correcciones de foco, consentimiento MCP y hardening de Linux._
