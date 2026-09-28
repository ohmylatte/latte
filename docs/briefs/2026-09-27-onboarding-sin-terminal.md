# Onboarding sin terminal: instalar y loguear el agente por la persona

Brief para la revisión de UX/UI en curso. Define qué tiene que hacer Latte para que una marketera sin perfil técnico pase de "descargué Latte" a "mi primer equipo trabaja" sin abrir una terminal, sin pegar un comando y sin ver la palabra CLI. Decisiones del dueño (2026-09-27): el login es siempre por navegador para quien lo permita; nada de claves de API como camino principal; Latte es el arnés, no bundlea el agente.

## 1. Cómo es hoy (verificado en el código)

- Latte detecta si cada runtime está instalado (`runtimeStatus`) y el onboarding, cuando falta, dice: "{name} no está instalado en este equipo. Podés seguir con el proyecto demo o saltar." (`src/i18n.tsx`, clave `onboarding.connect.notInstalled`). La persona queda sola con Google.
- El login de una cuenta pasa por `startAccountLogin(runtime, accountId)` (`electron/services/latteService.ts`) y una terminal embebida (`electron/runtime/terminalManager.ts`, node-pty). Funciona, pero la persona ve una terminal: texto, cursor, y un URL que tiene que copiar.
- Las cuentas gestionadas ya existen: carpeta propia por cuenta (`CLAUDE_CONFIG_DIR` y equivalentes) y aislamiento del entorno personal, extendido a Grok y Hermes en 1.6.0.
- Manejar un login por terminal virtual capturando el URL y abriendo el navegador está probado: el agente que integró ACP lo hizo con `claude mcp login` (ver `docs/briefs/2026-09-25-runtimes-acp.md`, sección 7).

## 2. Principios

1. **Lenguaje de la persona.** "¿Con qué trabajás?" en vez de "Elegí un runtime". Nombres comerciales: Claude, ChatGPT, Grok, Hermes, OpenCode. Nunca "CLI", "PATH", "token", "OAuth".
2. **Instaladores oficiales, corridos por Latte.** Latte ejecuta el mismo instalador de una línea que la documentación oficial pide, en una terminal oculta, y traduce el progreso a dos frases. No redistribuye binarios ajenos.
3. **Login siempre por navegador.** Latte abre el navegador; la persona inicia sesión como en cualquier sitio; Latte espera y confirma. Una clave de API sólo se pide cuando el proveedor no ofrece otra cosa, y se pide como "pegá tu clave" con el enlace a dónde conseguirla, nunca como paso obligatorio del onboarding.
4. **Plan B visible.** Cada paso tiene "Ya lo hice, buscar de nuevo" y el enlace a la guía oficial. Latte nunca deja a la persona sin salida.
5. **Un solo diagnóstico.** Un botón "¿Qué falta?" en Ajustes que dice, en una frase, qué está instalado, qué cuenta está logueada y qué se rompió.

## 3. El asistente, en tres pantallas

**Pantalla 1 · ¿Con qué trabajás?**
Tarjetas: Claude (Pro o Max), ChatGPT (Codex), Grok, Hermes, OpenCode (para DeepSeek y otros). Cada tarjeta dice en una línea qué hace falta: "Necesitás una suscripción a Claude Pro o Max". La que ya está instalada y logueada aparece con tilde y "Listo".

**Pantalla 2 · Lo instalamos por vos.**
Estados, en este orden y con este copy:
- "Buscando Claude Code en tu equipo…" → si está: "Ya lo tenés: Claude Code 1.0.x" y pasa a la 3.
- "Instalando Claude Code…" con una barra indeterminada y una línea de detalle en gris ("Descargando…", "Comprobando…"). Debajo, un botón secundario "Ver detalle" que abre la terminal embebida de hoy, plegada, para quien quiera mirar.
- "Listo: Claude Code 1.0.x" con tilde.
- Error: una frase en llano + el plan B: "No pudimos instalarlo (Windows bloqueó el instalador). Probá con la guía oficial y volvé: [Ya lo instalé, buscar de nuevo]". Nunca el volcado de la terminal como mensaje.
- En Windows, antes de instalar: si falta Git para Windows y el runtime lo necesita, "Claude Code necesita Git para Windows. ¿Lo instalamos también?" con un botón. Si falta `winget`, enlace y plan B.

**Pantalla 3 · Iniciá sesión con tu cuenta.**
- "Se abrió tu navegador. Iniciá sesión con tu cuenta de Claude y volvé acá." Un spinner y el botón "Abrir de nuevo" por si la ventana se cerró.
- Latte corre el login en la terminal oculta, captura el URL, lo abre con el navegador del sistema, y espera la confirmación del CLI. Al terminar: "Conectado como {correo o nombre}" si el CLI lo informa; si no, "Conectado".
- Si el CLI no imprime un URL reconocible (versión nueva): cae a la terminal embebida con una línea arriba: "Este paso necesita que copies el enlace que aparece abajo en tu navegador".
- La cuenta queda gestionada por Latte, con su carpeta propia.

Después: la primera marca, como hoy.

## 4. Tabla por runtime (a verificar en la implementación, no inventar)

| Runtime | Detectar | Instalar (oficial) | Verificar | Login |
|---|---|---|---|---|
| Claude Code | `claude --version` en PATH o ruta conocida del instalador | Windows: `irm https://claude.ai/install.ps1 \| iex`; macOS/Linux: `curl -fsSL https://claude.ai/install.sh \| bash` | `claude --version` | `claude` interactivo → `/login` por navegador; Latte captura el URL |
| Codex | `codex --version` | `npm i -g @openai/codex` o el instalador que la doc oficial indique | `codex --version` | `codex login` por navegador |
| OpenCode | `opencode --version` | `curl -fsSL https://opencode.ai/install \| bash` (verificar el equivalente de Windows) | `opencode --version` | `opencode auth login`: por navegador para los proveedores que lo permiten; clave sólo cuando el proveedor no tiene otra cosa (DeepSeek) |
| Grok | `grok --version` | Instalador oficial de xAI (verificar) | `grok --version` | `grok` → login por navegador (`--reauth` existe) |
| Hermes | `hermes --version` | Instalador de Hermes Agent (verificar) | `hermes acp --check` | `hermes login` por navegador para proveedores OAuth |

Reglas: Latte guarda la ruta absoluta del ejecutable que el instalador dejó y la usa, sin depender de que el PATH se refresque en la sesión actual. Cada comando se corre con el entorno limpio de las cuentas gestionadas.

## 5. Riesgos y qué hacemos

- **Windows.** Política de ejecución de PowerShell (se lanza con `-ExecutionPolicy Bypass` sólo para ese proceso), Defender que frena binarios nuevos (mensaje claro y reintento), y la dependencia histórica de Git Bash de Claude Code (detectar; ofrecer `winget install Git.Git`; plan B con enlace). Probar en una máquina limpia, no en la del dueño.
- **Leer la salida del CLI es frágil.** Se reconoce por versión; si no se reconoce, se cae a la terminal embebida. Nunca se bloquea el flujo por no entender un texto.
- **Instaladores que cambian.** Las URLs viven en un solo archivo de configuración de runtimes, no repartidas por el código, con la fecha en que se verificaron.
- **Privacidad.** El asistente no manda nada afuera: sólo corre instaladores oficiales y abre el navegador. El diagnóstico se copia al portapapeles a pedido, para soporte.

## 6. Qué mide el éxito

Una persona sin terminal abierta, en una máquina Windows limpia con Claude Pro, llega a "mi primer equipo trabaja" en menos de diez minutos y sin buscar nada en Google. Ese es el test de aceptación, hecho por alguien que no sea del equipo.

## 7. Esfuerzo estimado

- Instalación asistida con estados y plan B, los cinco runtimes con la tabla en configuración: 2 a 3 días de agente.
- Login por navegador manejado por Latte con caída a la terminal embebida: 1 a 2 días.
- Diagnóstico "¿Qué falta?": medio día.
- Prueba en máquina limpia de Windows y macOS: medio día, humano.
