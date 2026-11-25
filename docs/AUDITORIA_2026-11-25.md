# Auditoría del Sistema de Préstamo Interbibliotecario — Red REUNIR

**Fecha:** 25 de noviembre de 2026 · **Proyecto:** "SISTEMA REUNIR 1." (Apps Script) y su hoja de cálculo.

## Estado actual

| Punto | Estado |
|---|---|
| Código corregido (v16) guardado en el editor | ✅ Hecho |
| Formulario y revisión automática | ✅ Ya usan el código nuevo |
| Páginas de aprobación (Web App) | ⛔ **Siguen en la versión 15** hasta publicar desde la cuenta dueña |
| Revisión cada hora | ⛔ Falta ejecutar `configurarActivadores()` |
| Prueba con correos reales | ⛔ No se ha hecho |

## Qué pasó en la presentación (solicitud REQ-20261124-0009, 24/11)

| Hora | Hecho comprobado |
|---|---|
| 3:39 p. m. | Se envió el formulario: origen **Universidad Católica de Pereira**, prestamista **Fundación Universitaria del Área Andina**. |
| 3:39 p. m. | La validación fue al correo registrado de la **origen**: el de la biblioteca de la U. Católica (así está diseñado el flujo). |
| 3:46 p. m. | Origen autorizado. Tres ejecuciones de la página en 33 segundos (las dos últimas con 1 segundo de diferencia). |
| 3:46 p. m. | Los correos a la prestamista y al solicitante **sí salieron**, pero desde una segunda cuenta, no desde la cuenta del sistema (verificado en sus Enviados). |
| Después | La solicitud quedó en "Aprobada por origen — verificando disponibilidad". |

## Causas encontradas

| # | Gravedad | Problema | Corrección |
|---|---|---|---|
| 1 | Alta | El Web App se ejecuta como una segunda cuenta desde la versión 15 (4/11). La publicó Claude desde esa sesión y cambió la cuenta de ejecución. Los correos tras cada aprobación salen de otra cuenta y los eventos de Calendar quedan allí. | Publicar nueva versión **desde la cuenta dueña** (pasos abajo). |
| 2 | Alta | El formulario de confirmación no tenía `target="_top"`: la respuesta se carga dentro del marco de Google y suele verse en blanco, aunque la acción sí se registra. Explicación probable de los clics repetidos (no reproducido en vivo). | Agregado, más botón que se bloquea al confirmar. |
| 3 | Alta | El correo de cada biblioteca se copiaba al crear la solicitud: si se cambiaba en la hoja, las etapas siguientes usaban el viejo. | Se lee de la hoja en cada envío. |
| 4 | Alta | La columna **Correo activo** no se usaba. | Ahora manda la hoja: "No" = no recibe. |
| 5 | Alta | El botón **Registrar devolución** le llegaba al usuario: podía darse por devuelto él mismo. | Solo lo recibe la prestamista. |
| 6 | Media | La entrega, el recordatorio, el vencimiento y la devolución no avisaban a todas las bibliotecas. | Cada etapa avisa a origen y prestamista según la tabla de abajo. |
| 7 | Media | Los plazos se revisaban una vez al día: el aviso de 24 h y el cierre de 48 h podían atrasarse casi un día. | Revisión cada hora (avisos entre 7 a. m. y 8 p. m.). |
| 8 | Media | Un fallo de envío no quedaba registrado. | El **Historial** anota cada correo enviado o fallido y avisa al administrador. |
| 9 | Media | `ajustarFormularioReunir()` borraba las preguntas y creaba columnas duplicadas (hay 37 en las respuestas). | Ahora solo actualiza las listas. |
| 10 | Media | `poblarHojaBibliotecas()` borraba la hoja de bibliotecas y la reescribía con correos fijos. | Eliminada: la hoja es la única fuente. |
| 11 | Baja | El enlace del formulario seguía como texto de relleno. | Se obtiene automáticamente. |
| 12 | Baja | Textos del formulario se insertaban sin protección en correos y hoja. | Escapados. |

## Quién recibe cada correo (v16)

| Etapa | Usuario | Origen | Prestamista |
|---|:--:|:--:|:--:|
| Solicitud enviada | ✔ | ✔ validar | |
| Origen autoriza | ✔ | | ✔ disponibilidad |
| Origen rechaza | ✔ | | |
| Prestamista aprueba | ✔ 24 h | ✔ | ✔ confirmar entrega |
| Prestamista rechaza | ✔ | ✔ | |
| Entrega | ✔ | ✔ | ✔ registrar devolución |
| No retira en 48 h | ✔ | ✔ | ✔ |
| 3 días antes | ✔ | | ✔ |
| Vencido (+ administrador) | ✔ | ✔ | ✔ |
| Devolución | ✔ | ✔ | ✔ |

## Cómo se organiza desde la hoja "Bibliotecas"

- **Correo responsable:** uno o varios, separados por coma.
- **Días préstamo:** manda el de la biblioteca **prestamista** (1 a 120). Aparece en correos y páginas.
- **Correo activo:** "No" desactiva el envío.
- **Columna G (automática):** muestra "Recibe correos · préstamo N días" o el motivo por el que no.
- Las solicitudes pendientes por falta de correo **se envían solas** cuando se completa la hoja.

## Estado de las bibliotecas

**Con correo activo (8):** Libre Pereira, ESAP, Colombo Americano, Católica de Pereira, Área Andina, SENA Diseño e innovación, Autónoma de Manizales, Católica de Manizales.

**Para decidir:** la **Universidad Tecnológica de Pereira** tiene correo escrito pero **Correo activo = No**. Antes recibía; con v16 no recibe hasta ponerla en "Sí".

**Sin correo (17, para el lunes):** SENA Agropecuario, Comfamiliar (Fundación), Pública Municipal, Antonio Nariño, Uniclaretiana, CIAF, Alianza Francesa, Cooperativa, UNISARC, Pública Dptal Comfamiliar, UNIMINUTO, Banco de la República, Visión de las Américas, U. de Caldas, U. de Manizales, Nacional Manizales, Luis Amigó Manizales.

## Pruebas realizadas (simulación local, sin enviar correos)

- 650 combinaciones origen → prestamista con una copia de la hoja: 56 llegan hasta la devolución (las 8 con correo activo entre sí) y 594 quedan pendientes por falta de correo, avisando al administrador.
- **1.407 verificaciones, 0 fallos:** destinatarios por etapa, doble clic, rechazos, cambio de correo y días a mitad del proceso, reanudación de pendientes, retiro 24/48 h, recordatorio, vencimiento y devolución.
- Revisión visual de un correo y una página de aprobación.

La simulación imita los servicios de Google: **no demuestra** la entrega real, el spam ni los permisos.

## Pasos pendientes (con la cuenta dueña: [cuenta])

Usar una ventana de incógnito con **solo** esa cuenta.

1. Abrir el proyecto → elegir la función `configurarActivadores` → **Ejecutar** → autorizar.
2. En **Activadores** deben quedar solo 2: formulario y revisión cada hora. Si aparecen más de otro usuario, esa persona debe borrar los suyos (si no, habrá correos repetidos).
3. Ejecutar `diagnosticoSistema` y revisar la columna G de la hoja.
4. **Implementar → Administrar implementaciones → Editar → Nueva versión → Ejecutar como: Yo (alabrada3)** → Implementar. La URL no cambia.
5. **Prueba real:** poner temporalmente correos propios en dos bibliotecas, hacer una solicitud completa hasta la devolución y restaurar los correos.

## Recomendaciones para próximas demostraciones

- Crear en la hoja dos bibliotecas de prueba ("DEMO Origen", "DEMO Prestamista") con correos propios y ejecutar `sincronizarFormulario`.
- Quien aprueba desde un navegador con varias cuentas de Google puede ver "No se puede abrir el archivo": usar incógnito.
- Revisar la carpeta de spam la primera vez.
- Respaldo de la versión anterior: `Code_v15_respaldo.gs` (esta carpeta).
