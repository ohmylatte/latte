# Brief 02 — Workspace operativo de marketing

## Dependencia

Comenzar después de implementar y validar el Brief 01.

## Propósito

Reorganizar la experiencia cotidiana para hacer visible, comprensible y emocionante la potencia que Latte ya tiene. El usuario debe entender dónde está, qué objetivo persigue, qué ocurrió, qué requiere atención y cuál es el próximo paso.

Latte debe percibirse como un espacio de trabajo para planificar, producir, operar, analizar, optimizar, decidir, reportar y entregar marketing con agentes. No como editor, herramienta de diseño o generador de contenido.

## Problema

La interfaz actual muestra simultáneamente múltiples objetos y controles:

- marca, contexto y memoria;
- trabajos y documentos;
- Conversar y Revisar;
- Documentos, Embudo y Decisiones;
- equipo, roles, proveedor y modelo;
- versiones, entregables y carpetas.

Cada capacidad es valiosa, pero la organización refleja el sistema interno más que el trabajo que una persona intenta realizar. El resultado es una experiencia potente pero densa, donde el siguiente paso no siempre es evidente.

## Principios

1. Una pantalla responde una pregunta principal y presenta una acción principal.
2. La creación es sólo una clase de trabajo.
3. Un resultado puede ser un documento, diagnóstico, decisión, experimento, cambio ejecutado o medición.
4. La infraestructura se revela progresivamente.
5. Proponer, aprobar, ejecutar y verificar son estados distintos.
6. El control humano y el modelo local-first no se ocultan ni se debilitan.

## Arquitectura de información propuesta

### Navegación global

1. **Inicio**
2. **Trabajos**
3. **Biblioteca**
4. **Marca**
5. **Ajustes**

### Dentro de un trabajo

1. **Resumen**
2. **Trabajo**
3. **Evidencia**
4. **Decisiones**
5. **Resultados**

### Redistribución de capacidades

| Capacidad existente | Ubicación propuesta |
| --- | --- |
| Conversaciones y agentes | Trabajo |
| Documentos en elaboración | Trabajo |
| Archivos, datos y fuentes | Evidencia |
| Hipótesis y recomendaciones | Decisiones |
| Aprobaciones y permisos | Decisiones |
| Versiones e historial | Decisiones / detalle del documento |
| Embudo | Resumen y Resultados |
| Entregables | Resultados |
| Cambios externos ejecutados | Resultados |
| Contexto y memoria | Marca |
| Equipo | Configuración secundaria del trabajo |
| Runtime, modelo, MCP y terminal | Ajustes avanzados |

## Feature 1 — Inicio orientado a atención

Debe responder:

- ¿Qué cambió desde la última sesión?
- ¿Qué necesita mi decisión?
- ¿Qué agente está trabajando?
- ¿Qué acción está bloqueada?
- ¿Qué resultado está listo?
- ¿Qué debería hacer ahora?

Contenido sugerido:

- Continuar donde lo dejaste.
- Trabajos activos.
- Resultados listos para revisar.
- Permisos y decisiones pendientes.
- Acciones ejecutadas que necesitan verificación.
- Revisiones programadas.
- Entregables recientes.

No llenar el inicio con métricas decorativas. Cada tarjeta debe conducir a una acción.

## Feature 2 — Resumen del trabajo

Mostrar:

- objetivo;
- tipo de trabajo;
- resultado esperado;
- marca y alcance;
- estado actual;
- hallazgos principales;
- decisiones pendientes;
- acciones autorizadas;
- próxima revisión;
- siguiente acción recomendada.

Representar el ciclo de forma flexible:

> Observar → Entender → Decidir → Actuar → Medir

No convertirlo en un wizard rígido. Un trabajo puede comenzar o terminar en cualquier punto.

## Feature 3 — Acción global neutral

CTA global: **Nuevo trabajo**.

No utilizar “Crear con Latte” como entrada universal. La creación es sólo uno de los posibles objetivos.

Dentro del contexto, usar verbos específicos:

- Analizar campañas.
- Preparar estrategia.
- Crear piezas.
- Revisar resultados.
- Aprobar cambios.
- Aplicar cambios.
- Verificar ejecución.
- Preparar informe.

Latte puede recomendar el rol adecuado sin obligar al usuario a elegirlo. La selección manual permanece bajo **Personalizar equipo**.

## Feature 4 — Superficie Trabajo

Debe permitir conversar, investigar, analizar, producir u operar sin obligar a cambiar entre subsistemas incomprensibles.

La superficie debe mostrar:

- encargo actual;
- conversación o actividad;
- documentos relacionados;
- solicitudes de permiso;
- progreso real;
- próximos pasos sugeridos.

Los términos runtime, modelo y nivel de esfuerzo sólo aparecen en detalles avanzados.

## Feature 5 — Evidencia

Agrupar:

- archivos de marca y trabajo;
- datos importados;
- resultados de consultas;
- fuentes externas;
- período, filtros y alcance;
- fecha de extracción;
- limitaciones conocidas.

La persona debe poder distinguir:

- hecho observado;
- cálculo;
- hipótesis;
- recomendación;
- decisión aprobada.

## Feature 6 — Decisiones y control

Unificar:

- recomendaciones;
- decisiones pendientes;
- aprobaciones;
- permisos;
- cambios solicitados;
- razones;
- responsables;
- historial.

Acciones principales según estado:

- Aprobar.
- Pedir cambios.
- Rechazar.
- Comparar versiones.
- Autorizar acción.
- Revocar autorización pendiente.

Nunca confundir aprobación de un análisis con autorización para modificar una cuenta externa.

## Feature 7 — Resultados

No limitar Resultados a archivos o entregables.

Tipos posibles:

- documento;
- diagnóstico;
- decisión;
- experimento;
- cambio ejecutado;
- medición;
- entregable para cliente.

Para acciones externas mostrar:

- qué se solicitó;
- qué se autorizó;
- qué ejecutó la herramienta;
- resultado confirmado;
- elementos que fallaron;
- próxima medición.

Para archivos permitir:

- previsualizar;
- abrir;
- descargar o guardar copia;
- mostrar en carpeta;
- asociar como resultado principal.

## Feature 8 — Embudo accionable

Mantener el embudo como diferencial estratégico, pero convertir vacíos y desbalances en acciones:

- Analizar este hueco.
- Preparar una propuesta.
- Asociar una pieza existente.
- Crear un experimento.
- Marcar como fuera de alcance.

Evitar “clasificación virtual” en la interfaz principal. Utilizar “Etapas del recorrido” o terminología validada con usuarios.

## Feature 9 — Modo simple y avanzado

### Simple, predeterminado

- lenguaje de marketing;
- configuración recomendada;
- una acción primaria;
- contexto, permisos y resultados visibles;
- infraestructura oculta.

### Avanzado

- runtime;
- proveedor y modelo exactos;
- terminal;
- MCP;
- perfiles técnicos;
- rutas y archivos internos;
- tokens y parámetros.

La preferencia debe persistir. Simplificar no significa ocultar riesgos ni permisos.

## Mejoras visuales y de accesibilidad

- Texto principal de 14–16 px.
- Texto secundario mínimo de 12–13 px.
- Contraste WCAG AA.
- Controles de 40–44 px cuando sean operativos.
- Componente compartido de diálogo con focus trap, Escape y restauración.
- Soporte para `prefers-reduced-motion`.
- Estados acompañados por texto o forma, no sólo color.
- Sidebar compactable.
- Panel del agente como drawer en ventanas pequeñas.
- Pruebas con escalado de Windows a 125% y 150%.
- Corrección de mojibake visible.

## Terminología a validar

| Actual o propuesta anterior | Alternativa a probar |
| --- | --- |
| Crear con Latte | Nuevo trabajo |
| Crear | Trabajo |
| Entregables | Resultados / Entregables según el caso |
| Conservar versión | Crear punto de restauración |
| Clasificación virtual | Etapas del recorrido |
| Adoptar archivo | Agregar al trabajo |
| Runtime | Motor de IA, sólo si debe mostrarse |
| Equipo de agentes | Equipo, con detalle técnico expandible |

No cambiar terminología sólo por intuición: validarla con pruebas de comprensión.

## Fuera de alcance

- Cambiar almacenamiento local-first.
- Reemplazar documentos Markdown como implementación.
- Modificar el protocolo de agentes sin necesidad demostrada.
- Publicar, gastar o cambiar cuentas sin autorización explícita.
- Colaboración multiusuario.
- Agregar proveedores o roles sólo para completar el rediseño.
- Rediseño cosmético sin mejora de journeys.

## Criterios de aceptación

- La persona puede explicar dónde trabajar, revisar decisiones y comprobar resultados.
- Inicio muestra aquello que necesita atención.
- Cada pantalla presenta una acción primaria reconocible.
- El usuario básico no necesita ver runtime, CLI, MCP ni archivos internos.
- Un trabajo operativo no se representa como creación de contenido.
- Los resultados incluyen documentos y acciones verificadas.
- Propuesta, aprobación, ejecución y verificación aparecen como estados diferentes.
- El producto conserva el control experto existente.
- Los diálogos funcionan completamente con teclado.
- Textos operativos cumplen WCAG AA.
- La ventana mínima no corta contenido.
- Español e inglés mantienen terminología consistente.

## Métricas

- 80% encuentra el pendiente principal sin ayuda.
- 80% puede explicar qué resultado produjo el trabajo.
- 80% distingue recomendación de acción ejecutada.
- Reducción de retrocesos entre Conversar y Revisar.
- Menos aperturas innecesarias de Ajustes.
- SEQ mínimo de 5.5/7.
- SUS mínimo de 80.
- “Sé qué debería hacer ahora”: 4/5 o superior.
- “Entiendo qué hizo Latte”: 4/5 o superior.
- Cero acciones presentadas como exitosas sin verificación.

## Archivos probablemente afectados

- `src/App.tsx`
- `src/DocumentsView.tsx`
- `src/DocumentList.tsx`
- `src/ChatPane.tsx`
- `src/TeamPanel.tsx`
- `src/FunnelView.tsx`
- `src/Deliverables.tsx`
- `src/WorkOutcome.tsx`
- `src/SettingsScreen.tsx`
- archivos de i18n;
- `src/styles.css`;
- tests asociados.

## Instrucciones de implementación

- Mapear primero las capacidades y estados existentes.
- No eliminar funcionalidades.
- Evitar una reescritura total; migrar progresivamente.
- Extraer componentes compartidos antes de duplicar layouts.
- Escribir tests para navegación, estados, permisos y preferencias.
- Ejecutar tests y typecheck.
- **Nunca ejecutar build.**
- Mantener compatibilidad con datos existentes.
- Registrar decisiones de terminología.
- No diseñar Latte como editor, generador de contenido ni herramienta de diseño.

