# Brief 01 — Activación marketer-first

## Propósito

Hacer visible, comprensible y emocionante la potencia que Latte ya tiene para realizar trabajo de marketing. La primera sesión debe llevar a una persona sin experiencia técnica desde una necesidad de negocio hasta un primer resultado útil, sin exigirle entender agentes, runtimes, CLI, modelos, MCP, Markdown o Engram.

Latte no debe presentarse como editor, generador de contenido ni herramienta de diseño. Es un espacio de trabajo para dirigir, ejecutar y revisar trabajo de marketing con agentes de IA.

## Problema

La aplicación permite crear marcas y trabajos, conectar proveedores, formar equipos, conversar, revisar documentos, registrar decisiones y administrar entregables. Sin embargo, estas capacidades aparecen como subsistemas separados y el usuario debe descubrir por su cuenta cómo combinarlas.

La configuración técnica aparece antes que el beneficio. El resultado diferencial existe, pero no hay un recorrido explícito que conduzca hasta él ni un momento que explique qué consiguió Latte.

## Usuario principal

Profesional de marketing que:

- sabe describir una necesidad de negocio;
- trabaja con campañas, contenidos, datos, clientes o equipos;
- puede utilizar Canva, Notion, hojas de cálculo o ChatGPT;
- no necesita ni quiere comprender infraestructura de agentes;
- espera conservar control sobre decisiones, permisos y cambios externos.

## Job to be done

> Cuando tengo una necesidad de marketing, quiero explicarle a Latte qué resultado busco y darle el contexto disponible, para que organice el trabajo, me ayude a llegar a una decisión o acción útil y me muestre claramente qué hizo y qué requiere mi aprobación.

## Principio rector

La creación de contenido es sólo una clase de trabajo. La primera experiencia debe soportar el ciclo completo:

> Observar → Entender → Decidir → Actuar → Medir

## Experiencia propuesta

### 1. Entrada: “¿En qué querés trabajar?”

Presentar trabajos reconocibles, agrupados por intención:

#### Planificar

- Diseñar una campaña.
- Preparar una estrategia.
- Definir un experimento.
- Armar un calendario.

#### Producir

- Crear contenido.
- Adaptar piezas.
- Preparar una presentación.
- Generar variantes.

#### Operar

- Revisar campañas activas.
- Aplicar cambios aprobados.
- Organizar tareas recurrentes.
- Verificar implementaciones.

#### Analizar

- Diagnosticar performance.
- Comparar períodos.
- Auditar una cuenta.
- Encontrar oportunidades.

#### Optimizar

- Priorizar acciones.
- Revisar presupuesto.
- Detectar fatiga creativa.
- Mejorar conversión.

#### Reportar

- Preparar un informe.
- Resumir resultados.
- Documentar decisiones.
- Crear un reporte para cliente.

Incluir siempre **Empezar libremente**.

### 2. Contexto mínimo y adaptativo

El recorrido debe solicitar únicamente la información que cambia la recomendación. Las preguntas dependen del tipo de trabajo.

#### Campaña nueva

- objetivo;
- audiencia;
- oferta;
- canales;
- restricciones.

#### Análisis de paid media

- cuenta;
- período y comparación;
- objetivo de campaña;
- definición de conversión;
- moneda y zona horaria;
- ventana o modelo de atribución.

#### Operación de campañas

- cuenta y entidades dentro del alcance;
- acciones autorizadas;
- límites de presupuesto;
- cambios que requieren aprobación;
- método de verificación.

#### Reporte

- audiencia del informe;
- período;
- fuentes;
- indicadores;
- decisión que debe facilitar.

No convertir el onboarding en un cuestionario obligatorio. Si falta algo no bloqueante, Latte debe declarar el supuesto y continuar.

### 3. Marca y fuentes

Permitir:

- elegir una marca existente;
- crear una marca;
- vincular una carpeta o archivos;
- utilizar un proyecto demo.

Latte debe resumir **Esto es lo que entendí** y permitir corregirlo antes de continuar.

### 4. Conectar IA en lenguaje no técnico

Opciones principales:

- Usar mi cuenta de Claude.
- Usar mi cuenta de Codex.
- Conectar otro proveedor.
- Explorar con un proyecto demo.

Ocultar inicialmente runtime, CLI, MCP, identificador exacto del modelo, endpoints y parámetros técnicos. Conservarlos bajo **Configuración avanzada**.

### 5. Preparar el trabajo

Antes de ejecutar, mostrar:

- qué resultado se espera;
- qué contexto utilizará Latte;
- qué acciones puede realizar;
- qué acciones requieren aprobación;
- cómo se verificará el resultado.

Latte debe seleccionar automáticamente el rol y configuración recomendados. La personalización manual continúa disponible como opción secundaria.

CTA principal: **Empezar trabajo**.

### 6. Progreso comprensible

Evitar un spinner opaco. Mostrar pasos de negocio, por ejemplo:

- Revisando el contexto.
- Consultando campañas autorizadas.
- Comparando períodos.
- Preparando recomendaciones.
- Esperando tu aprobación.
- Aplicando los cambios aprobados.
- Verificando el resultado.

Cada bloqueo debe explicar qué sucede, por qué importa y cómo continuar.

### 7. Momento de valor

El cierre debe adaptarse al tipo de trabajo.

#### Ejemplo creativo

> Latte utilizó el contexto de la marca, preparó una estrategia y cuatro piezas, y detectó dos decisiones para revisar.

#### Ejemplo analítico

> Latte analizó 14 campañas, encontró tres desvíos relevantes y preparó cinco acciones priorizadas con su evidencia.

#### Ejemplo operativo

> Latte aplicó los tres cambios autorizados, verificó su estado en la cuenta y dejó programada la próxima revisión.

Acciones posibles:

- Ver resultado.
- Revisar decisiones.
- Aprobar cambios.
- Verificar acciones.
- Continuar con el próximo paso.

## Requisitos funcionales

- Onboarding persistente y reanudable.
- Posibilidad de omitirlo.
- Proyecto demo sin proveedor real.
- Catálogo de trabajos definido mediante datos extensibles.
- Preguntas adaptativas según intención.
- Selección recomendada de rol, runtime y modelo.
- Diferenciación explícita entre propuesta, aprobación, ejecución y verificación.
- Resumen final basado en eventos reales; nunca inventado.
- Preservación del modo experto y de la configuración actual.
- Español e inglés completos.

## Estados que deben diseñarse

- Ningún proveedor disponible.
- Proveedor detectado sin sesión.
- Autenticación fallida.
- Fuente o cuenta sin permisos.
- Datos insuficientes o incompatibles.
- Trabajo creado pero no iniciado.
- Ejecución interrumpida.
- Permiso pendiente.
- Resultado parcial.
- Propuesta esperando aprobación.
- Acción aprobada pero no ejecutada.
- Acción ejecutada sin verificación.
- Resultado completo y verificado.

## Fuera de alcance

- Nuevos proveedores o runtimes.
- Nuevos roles como requisito del recorrido.
- Rediseño completo del workspace.
- Publicación o gasto sin autorización explícita.
- Colaboración multiusuario.
- Automatizaciones recurrentes.
- Modificación del modelo local-first.

## Criterios de aceptación

- Un usuario nuevo completa un trabajo inicial sin abrir Ajustes.
- No necesita comprender CLI, runtime, MCP, Markdown o Engram.
- Puede ejecutar un proyecto demo sin proveedor conectado.
- Siempre existe una acción primaria reconocible.
- Las preguntas se adaptan al tipo de trabajo.
- El sistema distingue propuesta, aprobación, ejecución y verificación.
- Ninguna acción externa se presenta como realizada sin confirmación de la herramienta.
- El resultado explica qué contexto, fuentes y permisos utilizó.
- Todo error conocido ofrece una acción de recuperación.
- El recorrido puede abandonarse y retomarse.
- Funciona con teclado, español e inglés.
- No rompe el flujo avanzado existente.

## Métricas

- Mediana hasta primer resultado útil: menos de 5 minutos con proveedor conectado.
- Menos de 8 minutos sin proveedor conectado.
- Al menos 70% completa el proyecto demo.
- Al menos 50% completa el primer trabajo con datos propios.
- Al menos 80% entiende qué hizo Latte y qué requiere aprobación.
- Menos de 10% intenta configurar runtime o MCP para completar una tarea básica.
- Cero acciones externas realizadas sin autorización explícita.

## Archivos probablemente afectados

- `src/App.tsx`
- `src/DocumentsView.tsx`
- `src/ProvidersView.tsx`
- `src/TeamPanel.tsx`
- `src/ChatPane.tsx`
- `src/WorkOutcome.tsx`
- archivos de i18n;
- `src/styles.css`;
- contratos compartidos sólo si el progreso requiere persistencia adicional.

## Instrucciones de implementación

- Investigar primero y reutilizar capacidades existentes.
- No duplicar conexión, creación de trabajos, permisos ni ejecución.
- Escribir tests antes de modificar comportamiento.
- Ejecutar tests y typecheck.
- **Nunca ejecutar build.**
- No eliminar opciones avanzadas: reubicarlas.
- No inventar respuestas, estados, fuentes ni proveedores disponibles.
- No tratar creación de contenido como caso principal universal.

