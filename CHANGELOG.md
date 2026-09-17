# Changelog

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

### Plataformas

- **Windows x64**: soportado — el único con ejecutable publicado.
- **Linux x64** y **macOS**: **no hay un ejecutable probado.** Los paquetes de Linux se publican en *alpha* (verificado en Linux Mint 22.3 con X11, no en Wayland ni otras distribuciones); macOS no tiene artefacto. La vía soportada es correr desde el código.
- El instalador de Windows todavía **no está firmado**.

### Requisitos

Al menos un agente instalado y con tu cuenta: Claude Code, Codex u OpenCode. La inferencia la paga tu proveedor.

### Conocido

- Algunos controles técnicos y acciones tienen cobertura de test parcial (el mapeo de acciones del embudo, el gating del tooltip de runtime). No es regresión: está registrado en `docs/`.
- El preview web (`npm run dev:web`) guarda en el navegador y **no ejecuta agentes**.

---

_Historia 0.x (resumida): 0.1.0 primera instalación verificada en Windows; 0.4.0 archivo/restauración de marcas; 0.5.0 memoria de marca entre trabajos; 0.5.1–0.5.4 correcciones de foco, consentimiento MCP y hardening de Linux._
