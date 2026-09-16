# Instrucciones para agentes

## Producto y UX: lectura obligatoria

Antes de proponer, diseñar o implementar cambios de producto, navegación, onboarding, interfaz o experiencia de usuario, leer completos:

1. [`docs/ux/BRIEF-01-ACTIVACION-MARKETER-FIRST.md`](docs/ux/BRIEF-01-ACTIVACION-MARKETER-FIRST.md)
2. [`docs/ux/BRIEF-02-WORKSPACE-OPERATIVO-DE-MARKETING.md`](docs/ux/BRIEF-02-WORKSPACE-OPERATIVO-DE-MARKETING.md)

Estos documentos definen el posicionamiento y la dirección UX vigente. No comenzar trabajo de UX basándose sólo en capturas, nombres de componentes o una descripción resumida.

## Regla de posicionamiento

Latte es un **workspace operativo de marketing para dirigir trabajo realizado con agentes de IA**. Permite planificar, investigar, producir, operar, analizar, optimizar, decidir, reportar, ejecutar acciones autorizadas y verificar resultados.

Latte **no** debe diseñarse ni describirse como:

- un editor;
- una herramienta de diseño;
- un generador de contenido;
- un chatbot con documentos;
- una interfaz centrada exclusivamente en “crear”.

La creación de contenido es sólo una clase de trabajo. El modelo general es:

> Observar → Entender → Decidir → Actuar → Medir

Un resultado puede ser un documento, diagnóstico, decisión, experimento, cambio ejecutado, medición o entregable.

## Reglas para cambios de interfaz

- Empezar por la intención de marketing, no por agentes, modelos o infraestructura.
- Mantener separados los estados de propuesta, aprobación, ejecución y verificación.
- No presentar una acción externa como realizada sin confirmación de la herramienta.
- Preservar el control humano, el modelo local-first y los permisos explícitos.
- Ocultar runtime, CLI, MCP, modelos y archivos internos en la experiencia básica; conservarlos en modo avanzado.
- Usar **Nuevo trabajo** como concepto global antes que **Crear con Latte**.
- No eliminar capacidades para simplificar: aplicar divulgación progresiva.
- Validar cambios de terminología con comprensión de usuarios, no sólo con preferencia editorial.

## Orden de implementación

1. Implementar y validar el Brief 01.
2. Probar la activación con marketers sin experiencia técnica.
3. Corregir el recorrido según evidencia.
4. Implementar el Brief 02.

No implementar ambos briefs simultáneamente sin una decisión humana explícita: hacerlo impediría aislar el impacto de cada cambio.

## Desarrollo

- Escribir o actualizar tests antes de cambiar comportamiento.
- Ejecutar tests y typecheck cuando corresponda.
- **Nunca ejecutar builds.**
- No modificar ni descartar trabajo local preexistente sin autorización.
- No agregar atribución de IA ni `Co-Authored-By` en commits.
- Usar conventional commits.

