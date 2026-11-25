// ============================================================
//  SISTEMA DE PRÉSTAMO INTERBIBLIOTECARIO — RED REUNIR
//  Google Apps Script · v16 (auditoría 25/11/2026)
//  ----------------------------------------------------------
//  FLUJO Y DESTINATARIOS DE CADA CORREO
//   1. Formulario enviado ........ Origen (validar) + Usuario (recibido)
//   2. Origen aprueba ............ Prestamista (disponibilidad) + Usuario
//      Origen rechaza ............ Usuario
//   3. Prestamista aprueba ....... Usuario (24h) + Origen + Prestamista (entrega)
//      Prestamista rechaza ....... Usuario + Origen
//   4. Prestamista entrega ....... Usuario + Prestamista (registrar devolución) + Origen
//      No retiran en 48h ......... Usuario + Prestamista + Origen
//   5. 3 días antes .............. Usuario + Prestamista
//      Vencido ................... Usuario + Prestamista + Origen + Administrador
//   6. Prestamista registra devolución ... Usuario + Prestamista + Origen
//
//  LA HOJA "Bibliotecas" MANDA: correo, días de préstamo y si está activo
//  se leen en el momento de cada envío. No hay correos escritos en el código.
// ============================================================

// ─── CONFIGURACIÓN CENTRAL ───────────────────────────────────
const CONFIG = {
  SHEET_ID: "__SHEET_ID__",
  WEBAPP_URL: "__WEBAPP_URL__",
  HOJA_SOLICITUDES: "Solicitudes",
  HOJA_BIBLIOTECAS: "Bibliotecas",
  ADMIN_EMAIL: "__ADMIN_EMAIL__",
  NOMBRE_RED: "Red REUNIR — Préstamo Interbibliotecario",
  SHEET_URL: "https://docs.google.com/spreadsheets/d/__SHEET_ID__/edit",
  LOGO_URL: "https://www.reunir.com.co/wp-content/uploads/2025/04/LogoReunir1.jpg",
  SITIO_URL: "https://www.reunir.com.co/",
  DIAS_PRESTAMO_DEFAULT: 15,
  DIAS_PRESTAMO_MAXIMO: 120,
  DIAS_RECORDATORIO: 3,
  HORAS_RECORDATORIO_RETIRO: 24,  // a las 24h se envía UN recordatorio
  HORAS_EXPIRA_RETIRO: 48,        // a las 48h la solicitud expira
  HORA_INICIO_AVISOS: 7,          // los recordatorios solo salen entre estas horas
  HORA_FIN_AVISOS: 20,
};

// Colores oficiales (logo REUNIR)
const MARCA = {
  GRIS: "#3C3C3C", VERDE: "#57BA00", OLIVA: "#658B23", OSCURO: "#394E03",
  BOTON: "#3F6E00", ROJO: "#B3261E", AZUL: "#1F5F99", FONDO: "#F3F6EE", SUAVE: "#EAF3DC",
};

const SIN_CORREO = "SIN CORREO REGISTRADO";

// ─── COLUMNAS DE LA HOJA "Solicitudes" (1-indexed) ───────────
const COL = {
  ID: 1, FECHA: 2, NOMBRE: 3, CORREO_SOL: 4, TIPO_USUARIO: 5, DOCUMENTO: 6,
  PROGRAMA: 7, BIB_ORIGEN: 8, CORREO_ORIGEN: 9, BIB_PREST: 10, CORREO_PREST: 11,
  TIPO_MAT: 12, TITULO: 13, AUTOR: 14, INFO: 15, ESTADO: 16,
  AUT_ORIGEN: 17, VIGENCIA: 18, FUNC_ORIGEN: 19, FECHA_DEC_ORIGEN: 20, MOTIVO_ORIGEN: 21,
  DISP_PREST: 22, FUNC_PREST: 23, FECHA_DEC_PREST: 24, MOTIVO_PREST: 25,
  FECHA_PREST: 26, FECHA_DEV_ESP: 27, FECHA_DEV_REAL: 28, ENTREGADO: 29,
  CAL_ID: 30, HISTORIAL: 31,
};
const TOTAL_COLS = 31;

// ─── ESTADOS VÁLIDOS ─────────────────────────────────────────
const ESTADOS = {
  VALID_ORIGEN:          "En validación — biblioteca de origen",
  RECHAZADA_ORIGEN:      "Rechazada por biblioteca de origen",
  VALID_PRESTAMISTA:     "Aprobada por origen — verificando disponibilidad",
  RECHAZADA_PRESTAMISTA: "Rechazada por no disponibilidad",
  APROBADA:              "Aprobada — lista para retiro (24h)",
  NO_RETIRADA:           "No retirada — plazo de retiro vencido",
  EN_PRESTAMO:           "En préstamo",
  DEVUELTA:              "Devuelta",
  VENCIDA:               "Vencida",
  PEND_ORIGEN:           "Pendiente — sin correo biblioteca de origen",
  PEND_PRESTAMISTA:      "Pendiente — sin correo biblioteca prestamista",
};

// ============================================================
//  0. DIRECTORIO DE BIBLIOTECAS (hoja "Bibliotecas")
//  A=Nombre B=Institución C=Correo(s) D=Días préstamo
//  E=Ciudad/Red F=Correo activo (Sí/No) G=Estado en el sistema (automática)
// ============================================================
function normalizar(texto) {
  return String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

// Devuelve los correos válidos de una celda (admite varios separados por coma o ;)
function correosValidos(celda) {
  return String(celda || "").split(/[,;\s]+/)
    .map(c => c.trim())
    .filter(c => /^[^@\s<>"]+@[^@\s<>"]+\.[A-Za-z]{2,}$/.test(c));
}

function leerDias(celda) {
  const m = String(celda === null || celda === undefined ? "" : celda).match(/\d+/);
  const n = m ? Number(m[0]) : 0;
  if (!n) return CONFIG.DIAS_PRESTAMO_DEFAULT;
  return Math.min(n, CONFIG.DIAS_PRESTAMO_MAXIMO);
}

function interpretarFilaBiblioteca(f) {
  const correos = correosValidos(f[2]);
  const apagado = normalizar(f[5]) === "no";
  let motivo = "";
  if (!correos.length) motivo = "Sin correo válido";
  else if (apagado) motivo = 'Marcada "No" en la columna Correo activo';
  return {
    nombre: String(f[0] || "").trim(),
    correo: motivo ? null : correos.join(","),
    diasPrestamo: leerDias(f[3]),
    registrada: true,
    motivo: motivo,
  };
}

function getDatosBiblioteca(nombreBiblioteca) {
  const vacio = { nombre: String(nombreBiblioteca || ""), correo: null,
    diasPrestamo: CONFIG.DIAS_PRESTAMO_DEFAULT, registrada: false, motivo: "No está en la hoja Bibliotecas" };
  const buscado = normalizar(nombreBiblioteca);
  if (!buscado) return vacio;
  const hoja = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.HOJA_BIBLIOTECAS);
  const datos = hoja.getDataRange().getValues();
  for (let i = 1; i < datos.length; i++) {
    if (normalizar(datos[i][0]) === buscado) return interpretarFilaBiblioteca(datos[i]);
  }
  return vacio;
}

function getCorreoBiblioteca(nombre) { return getDatosBiblioteca(nombre).correo; }
function getDiasPrestamo(nombre) { return getDatosBiblioteca(nombre).diasPrestamo; }

// Lee el correo VIGENTE en la hoja Bibliotecas y lo deja escrito en la solicitud
function correoVigente(hoja, fila, datos, columnaBib, columnaCorreo) {
  const info = getDatosBiblioteca(datos[columnaBib - 1]);
  const valor = info.correo || SIN_CORREO;
  if (datos[columnaCorreo - 1] !== valor) {
    hoja.getRange(fila, columnaCorreo).setValue(valor);
    datos[columnaCorreo - 1] = valor;
  }
  return info.correo;
}

// Escribe en la columna G cómo ve el sistema cada biblioteca
function actualizarEstadoBibliotecas() {
  const hoja = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.HOJA_BIBLIOTECAS);
  const datos = hoja.getDataRange().getValues();
  if (datos.length < 2) return [];
  const estados = datos.slice(1).map(f => {
    if (!String(f[0] || "").trim()) return [""];
    const b = interpretarFilaBiblioteca(f);
    return [b.correo ? `✅ Recibe correos · préstamo ${b.diasPrestamo} días` : `⚠️ No recibe correos: ${b.motivo}`];
  });
  hoja.getRange(1, 7).setValue("Estado en el sistema (automático)");
  hoja.getRange(2, 7, estados.length, 1).setValues(estados);
  return estados.map((e, i) => `${datos[i + 1][0]} → ${e[0]}`);
}

// ============================================================
//  1. TRIGGER PRINCIPAL: procesarFormularioReunir
// ============================================================
function procesarFormularioReunir(e) {
  // Bloqueo: garantiza IDs consecutivos únicos si llegan varios envíos a la vez
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (err) { avisarAdmin("Error en sistema Reunir", "No se pudo obtener el bloqueo: " + err.message); return; }
  try { _procesarFormularioReunir(e); }
  finally { lock.releaseLock(); }
}

function _procesarFormularioReunir(e) {
  try {
    if (!e || !e.range) {
      throw new Error("Esta función se activa al enviar el formulario. No la ejecutes manualmente.");
    }
    const ss   = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const hoja = ss.getSheetByName(CONFIG.HOJA_SOLICITUDES);

    // Se lee la fila tal como quedó en la hoja de respuestas (encabezado ↔ valor)
    const origenHoja = e.range.getSheet();
    const ancho   = origenHoja.getLastColumn();
    const headers = origenHoja.getRange(1, 1, 1, ancho).getDisplayValues()[0];
    const valores = origenHoja.getRange(e.range.getRow(), 1, 1, ancho).getDisplayValues()[0];

    const get = (campo) => {
      const c = normalizar(campo);
      for (let i = headers.length - 1; i >= 0; i--) {
        if (normalizar(headers[i]) === c && String(valores[i] || "").trim() !== "") return String(valores[i]).trim();
      }
      return "";
    };

    const nombre            = get("Nombre completo del solicitante");
    const correoSolicitante = correosValidos(get("Correo institucional"))[0] || "";
    const tipoUsuario       = get("Tipo de usuario");
    const documento         = get("Número de documento de identificación");
    const bibOrigen         = get("Biblioteca solicitante (a la que perteneces)");
    const bibPrestamista    = get("Biblioteca prestamista (a la que se solicita el material)");
    const programa          = get("Programa académico");
    const tipo              = get("Tipo de material");
    const titulo            = get("Título");
    const autor             = get("Autor");
    const info              = get("Información adicional / Observaciones");

    if (!correoSolicitante) {
      throw new Error(`Solicitud de "${nombre}" sin un correo válido ("${get("Correo institucional")}").`);
    }
    if (!bibOrigen || !bibPrestamista) {
      throw new Error(`Solicitud de ${correoSolicitante} sin biblioteca de origen o prestamista. Revisa los nombres de las preguntas del formulario.`);
    }

    const origen      = getDatosBiblioteca(bibOrigen);
    const prestamista = getDatosBiblioteca(bibPrestamista);

    const id = nuevoId(hoja);

    let infoFinal = info;
    if (normalizar(bibOrigen) === normalizar(bibPrestamista)) {
      infoFinal = (info ? info + " | " : "") +
        "⚠️ Biblioteca solicitante y prestamista son la misma — verificar si corresponde a préstamo interno.";
    }

    const fila = new Array(TOTAL_COLS).fill("");
    fila[COL.ID - 1]            = id;
    fila[COL.FECHA - 1]         = new Date();
    fila[COL.NOMBRE - 1]        = textoSeguroHoja(nombre);
    fila[COL.CORREO_SOL - 1]    = correoSolicitante;
    fila[COL.TIPO_USUARIO - 1]  = tipoUsuario;
    fila[COL.DOCUMENTO - 1]     = textoSeguroHoja(documento);
    fila[COL.PROGRAMA - 1]      = textoSeguroHoja(programa);
    fila[COL.BIB_ORIGEN - 1]    = bibOrigen;
    fila[COL.CORREO_ORIGEN - 1] = origen.correo || SIN_CORREO;
    fila[COL.BIB_PREST - 1]     = bibPrestamista;
    fila[COL.CORREO_PREST - 1]  = prestamista.correo || SIN_CORREO;
    fila[COL.TIPO_MAT - 1]      = tipo;
    fila[COL.TITULO - 1]        = textoSeguroHoja(titulo);
    fila[COL.AUTOR - 1]         = textoSeguroHoja(autor);
    fila[COL.INFO - 1]          = textoSeguroHoja(infoFinal);
    fila[COL.ESTADO - 1]        = origen.correo ? ESTADOS.VALID_ORIGEN : ESTADOS.PEND_ORIGEN;
    fila[COL.HISTORIAL - 1]     = logEntry(origen.correo
      ? `Solicitud creada. Enviada a biblioteca de origen (${origen.correo}).`
      : `Solicitud creada. La biblioteca de origen "${bibOrigen}" no recibe correos (${origen.motivo}). Queda pendiente.`, correoSolicitante);
    hoja.appendRow(fila);
    const numFila = hoja.getLastRow();
    const datos = fila;

    if (origen.correo) {
      enviarValidacionOrigen(hoja, numFila, datos, origen.correo);
    } else {
      avisarAdmin(`[Reunir] ⚠️ Sin correo de biblioteca de origen: ${bibOrigen}`,
        `La solicitud ${id} de "${nombre}" (${correoSolicitante}) quedó pendiente: "${bibOrigen}" no recibe correos (${origen.motivo}).\n` +
        `Material: ${titulo}\nPrestamista: ${bibPrestamista}\n\n` +
        `Completa la hoja Bibliotecas y el sistema la enviará solo en la siguiente revisión (cada hora):\n${CONFIG.SHEET_URL}`);
    }

    enviarCorreo({
      hoja, fila: numFila, para: correoSolicitante,
      asunto: `Solicitud recibida [${id}] — Red REUNIR`,
      cuerpo: plantillaCorreo("confirmacion_solicitante", datosPlantilla(datos, { pendiente: !origen.correo })),
    });

  } catch (err) {
    Logger.log("Error en procesarFormularioReunir: " + err.message);
    avisarAdmin("Error en sistema Reunir", err.message);
  }
}

function nuevoId(hoja) {
  const ultima = hoja.getLastRow();
  let mayor = 0;
  if (ultima > 1) {
    hoja.getRange(2, COL.ID, ultima - 1, 1).getValues().forEach(r => {
      const m = String(r[0]).match(/-(\d+)$/);
      if (m) mayor = Math.max(mayor, Number(m[1]));
    });
  }
  return "REQ-" + Utilities.formatDate(new Date(), "America/Bogota", "yyyyMMdd")
    + "-" + String(mayor + 1).padStart(4, "0");
}

// Reúne los datos de una fila para las plantillas
function datosPlantilla(datos, extra) {
  const bibPrest = datos[COL.BIB_PREST - 1];
  return Object.assign({
    id: datos[COL.ID - 1],
    nombre: datos[COL.NOMBRE - 1],
    correoSol: datos[COL.CORREO_SOL - 1],
    tipoUsuario: datos[COL.TIPO_USUARIO - 1],
    documento: datos[COL.DOCUMENTO - 1],
    programa: datos[COL.PROGRAMA - 1],
    bibOrigen: datos[COL.BIB_ORIGEN - 1],
    bibPrestamista: bibPrest,
    tipo: datos[COL.TIPO_MAT - 1],
    titulo: datos[COL.TITULO - 1],
    autor: datos[COL.AUTOR - 1],
    info: datos[COL.INFO - 1],
    diasPrestamo: getDiasPrestamo(bibPrest),
    sheetUrl: CONFIG.SHEET_URL,
  }, extra || {});
}

function enviarValidacionOrigen(hoja, fila, datos, correo) {
  const id = datos[COL.ID - 1];
  return enviarCorreo({
    hoja, fila, para: correo,
    asunto: `Validar usuario [${id}] — Red REUNIR`,
    cuerpo: plantillaCorreo("validacion_origen", datosPlantilla(datos, {
      linkAprobar:  crearLinkAccion(id, "aprobar_origen"),
      linkRechazar: crearLinkAccion(id, "rechazar_origen"),
    })),
  });
}

function enviarValidacionPrestamista(hoja, fila, datos, correo) {
  const id = datos[COL.ID - 1];
  return enviarCorreo({
    hoja, fila, para: correo,
    asunto: `Solicitud de préstamo: confirmar disponibilidad [${id}] — Red REUNIR`,
    cuerpo: plantillaCorreo("validacion_prestamista", datosPlantilla(datos, {
      linkAprobar:  crearLinkAccion(id, "aprobar_prestamista"),
      linkRechazar: crearLinkAccion(id, "rechazar_prestamista"),
    })),
  });
}

// ============================================================
//  2. ROUTER: doGet
// ============================================================
function doGet(e) {
  // Bloqueo: evita que dos clics simultáneos procesen la misma solicitud dos veces
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (err) { return respuestaHTML("⏳ El sistema está ocupado. Intenta de nuevo en unos segundos."); }
  try { return _doGet(e); }
  catch (err) {
    Logger.log("Error en doGet: " + err.message);
    avisarAdmin("Error en sistema Reunir (página de aprobación)", err.message);
    return respuestaHTML("⚠️ No fue posible completar la acción. El administrador fue notificado.");
  }
  finally { lock.releaseLock(); }
}

function _doGet(e) {
  const p      = (e && e.parameter) || {};
  const action = p.action;
  const id     = p.id;

  if (!action && !id) {
    const url = urlFormulario();
    return respuestaHTML(url
      ? `Bienvenido a la Red REUNIR.<br><br><a href="${url}" target="_top" style="${estiloBoton(MARCA.BOTON)}">Solicitar un préstamo</a>`
      : "Bienvenido a la Red REUNIR.");
  }
  if (!action || !id) {
    return respuestaHTML("⚠️ Enlace incompleto. Abre de nuevo el botón desde el correo más reciente.");
  }

  const ss   = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const hoja = ss.getSheetByName(CONFIG.HOJA_SOLICITUDES);
  const fila = buscarFila(hoja, id);
  if (!fila) return respuestaHTML("❌ Solicitud no encontrada: " + escapeHtml(id));

  const datos  = hoja.getRange(fila, 1, 1, TOTAL_COLS).getValues()[0];
  const estado = datos[COL.ESTADO - 1];
  const ya = () => respuestaHTML(
    `ℹ️ Esta acción ya fue registrada o ya no aplica.<br><br>Estado actual de <strong>${escapeHtml(id)}</strong>:<br><strong>${escapeHtml(estado)}</strong>`);
  const resumen = `<strong>${escapeHtml(datos[COL.TITULO - 1])}</strong> · ${escapeHtml(datos[COL.NOMBRE - 1])}<br>` +
    `Origen: ${escapeHtml(datos[COL.BIB_ORIGEN - 1])}<br>Prestamista: ${escapeHtml(datos[COL.BIB_PREST - 1])}` +
    ` · plazo ${getDiasPrestamo(datos[COL.BIB_PREST - 1])} días`;

  switch (action) {
    // ── ETAPA 1: biblioteca de origen ──────────────────────
    case "aprobar_origen":
      if (estado !== ESTADOS.VALID_ORIGEN) return ya();
      return paginaAccion(id, "confirmar_aprobar_origen", "Autorizar usuario", MARCA.BOTON, resumen,
        "Confirma que el usuario está activo / matriculado y sin pendientes.", [
          { name: "vigencia",    label: "Vigencia del usuario (hasta)", type: "date", required: true },
          { name: "funcionario", label: "Funcionario que autoriza",     type: "text", required: true },
        ]);
    case "confirmar_aprobar_origen":
      if (estado !== ESTADOS.VALID_ORIGEN) return ya();
      return aprobarOrigen(hoja, fila, datos, id, p.vigencia, p.funcionario);
    case "rechazar_origen":
      if (estado !== ESTADOS.VALID_ORIGEN) return ya();
      return paginaAccion(id, "confirmar_rechazo_origen", "Rechazar solicitud", MARCA.ROJO, resumen,
        "Indica por qué no se autoriza al usuario (multa, carné inactivo, entregas pendientes, etc.).", [
          { name: "motivo",      label: "Motivo del rechazo",      type: "textarea", required: true },
          { name: "funcionario", label: "Funcionario que rechaza", type: "text",     required: true },
        ]);
    case "confirmar_rechazo_origen":
      if (estado !== ESTADOS.VALID_ORIGEN) return ya();
      return rechazarOrigen(hoja, fila, datos, id, p.motivo, p.funcionario);

    // ── ETAPA 2: biblioteca prestamista ────────────────────
    case "aprobar_prestamista":
      if (estado !== ESTADOS.VALID_PRESTAMISTA) return ya();
      return paginaAccion(id, "confirmar_aprobar_prestamista", "Aprobar préstamo", MARCA.BOTON, resumen,
        "Confirma que el material está disponible para préstamo.", [
          { name: "funcionario", label: "Funcionario que autoriza", type: "text", required: true },
        ]);
    case "confirmar_aprobar_prestamista":
      if (estado !== ESTADOS.VALID_PRESTAMISTA) return ya();
      return aprobarPrestamista(hoja, fila, datos, id, p.funcionario);
    case "rechazar_prestamista":
      if (estado !== ESTADOS.VALID_PRESTAMISTA) return ya();
      return paginaAccion(id, "confirmar_rechazo_prestamista", "Material no disponible", MARCA.ROJO, resumen,
        "Indica el motivo (material no disponible, en uso, no se presta, etc.).", [
          { name: "motivo",      label: "Motivo del rechazo",      type: "textarea", required: true },
          { name: "funcionario", label: "Funcionario que rechaza", type: "text",     required: true },
        ]);
    case "confirmar_rechazo_prestamista":
      if (estado !== ESTADOS.VALID_PRESTAMISTA) return ya();
      return rechazarPrestamista(hoja, fila, datos, id, p.motivo, p.funcionario);

    // ── ETAPA 3: entrega y devolución ──────────────────────
    case "confirmar_prestamo":
      if (estado !== ESTADOS.APROBADA) return ya();
      return paginaAccion(id, "confirmar_prestamo_final", "Confirmar entrega", MARCA.AZUL, resumen,
        "Confirma que el material fue entregado al usuario. Se calculará la fecha de devolución.", [
          { name: "funcionario", label: "Funcionario que realiza el préstamo", type: "text", required: true },
        ]);
    case "confirmar_prestamo_final":
      if (estado !== ESTADOS.APROBADA) return ya();
      return confirmarPrestamo(hoja, fila, datos, id, p.funcionario);
    case "confirmar_devolucion":
      if (estado !== ESTADOS.EN_PRESTAMO && estado !== ESTADOS.VENCIDA) return ya();
      return paginaAccion(id, "confirmar_devolucion_final", "Registrar devolución", MARCA.BOTON, resumen,
        "Confirma que la biblioteca recibió el material.", [
          { name: "funcionario",   label: "Funcionario que recibe la devolución", type: "text",     required: true },
          { name: "observaciones", label: "Observaciones (opcional)",             type: "textarea", required: false },
        ]);
    case "confirmar_devolucion_final":
      if (estado !== ESTADOS.EN_PRESTAMO && estado !== ESTADOS.VENCIDA) return ya();
      return confirmarDevolucion(hoja, fila, datos, id, p.funcionario, p.observaciones);

    default:
      if (["aprobar", "rechazar", "confirmar_rechazo"].indexOf(action) !== -1) {
        return respuestaHTML("🔄 Este botón pertenece a una <strong>versión anterior</strong> del sistema. Pide que la solicitud se reenvíe.");
      }
      return respuestaHTML(`❌ Acción no reconocida: <code>${escapeHtml(action)}</code>`);
  }
}

// ============================================================
//  3. ETAPA 1 — BIBLIOTECA DE ORIGEN
// ============================================================
function aprobarOrigen(hoja, fila, datos, id, vigencia, funcionario) {
  hoja.getRange(fila, COL.AUT_ORIGEN).setValue("SI");
  hoja.getRange(fila, COL.VIGENCIA).setValue(vigencia ? parseFecha(vigencia) : "");
  hoja.getRange(fila, COL.FUNC_ORIGEN).setValue(textoSeguroHoja(funcionario));
  hoja.getRange(fila, COL.FECHA_DEC_ORIGEN).setValue(fmtHora(new Date()));
  appendLog(hoja, fila, `Usuario VALIDADO por origen. Vigencia: ${vigencia || "—"}. Funcionario: ${funcionario || "—"}`);

  const bibPrest    = datos[COL.BIB_PREST - 1];
  const correoPrest = correoVigente(hoja, fila, datos, COL.BIB_PREST, COL.CORREO_PREST);
  const hayCorreo   = !!correoPrest;
  hoja.getRange(fila, COL.ESTADO).setValue(hayCorreo ? ESTADOS.VALID_PRESTAMISTA : ESTADOS.PEND_PRESTAMISTA);

  if (hayCorreo) {
    enviarValidacionPrestamista(hoja, fila, datos, correoPrest);
  } else {
    appendLog(hoja, fila, `La prestamista "${bibPrest}" no recibe correos. Queda pendiente; administrador notificado.`);
    avisarAdmin(`[Reunir] ⚠️ Sin correo de prestamista: ${bibPrest}`,
      `La solicitud ${id} fue autorizada por origen, pero "${bibPrest}" no recibe correos.\n` +
      `Completa la hoja Bibliotecas y se enviará sola en la siguiente revisión:\n${CONFIG.SHEET_URL}`);
  }

  enviarCorreo({
    hoja, fila, para: datos[COL.CORREO_SOL - 1],
    asunto: `Tu biblioteca autorizó tu solicitud [${id}] — Red REUNIR`,
    cuerpo: plantillaCorreo("info_origen_aprobado", datosPlantilla(datos, { pendiente: !hayCorreo })),
  });

  return respuestaHTML(hayCorreo
    ? `✅ Usuario autorizado. La solicitud <strong>${escapeHtml(id)}</strong> fue enviada a <strong>${escapeHtml(bibPrest)}</strong> para verificar disponibilidad.`
    : `✅ Usuario autorizado para <strong>${escapeHtml(id)}</strong>. La prestamista aún no recibe correos; el administrador fue notificado.`);
}

function rechazarOrigen(hoja, fila, datos, id, motivo, funcionario) {
  hoja.getRange(fila, COL.ESTADO).setValue(ESTADOS.RECHAZADA_ORIGEN);
  hoja.getRange(fila, COL.AUT_ORIGEN).setValue("NO");
  hoja.getRange(fila, COL.FUNC_ORIGEN).setValue(textoSeguroHoja(funcionario));
  hoja.getRange(fila, COL.FECHA_DEC_ORIGEN).setValue(fmtHora(new Date()));
  hoja.getRange(fila, COL.MOTIVO_ORIGEN).setValue(textoSeguroHoja(motivo));
  appendLog(hoja, fila, `RECHAZADA por origen. Funcionario: ${funcionario || "—"}. Motivo: ${motivo}`);

  enviarCorreo({
    hoja, fila, para: datos[COL.CORREO_SOL - 1],
    asunto: `Solicitud no autorizada [${id}] — Red REUNIR`,
    cuerpo: plantillaCorreo("rechazada_origen", datosPlantilla(datos, { motivo })),
  });
  return respuestaHTML(`Solicitud <strong>${escapeHtml(id)}</strong> rechazada. El solicitante fue notificado.`);
}

// ============================================================
//  4. ETAPA 2 — BIBLIOTECA PRESTAMISTA
// ============================================================
function aprobarPrestamista(hoja, fila, datos, id, funcionario) {
  hoja.getRange(fila, COL.ESTADO).setValue(ESTADOS.APROBADA);
  hoja.getRange(fila, COL.DISP_PREST).setValue("SI");
  hoja.getRange(fila, COL.FUNC_PREST).setValue(textoSeguroHoja(funcionario));
  hoja.getRange(fila, COL.FECHA_DEC_PREST).setValue(new Date());
  appendLog(hoja, fila, `Disponibilidad CONFIRMADA. Funcionario: ${funcionario || "—"}. Aprobada — 24h para retiro.`);

  const correoOrigen = correoVigente(hoja, fila, datos, COL.BIB_ORIGEN, COL.CORREO_ORIGEN);
  const correoPrest  = correoVigente(hoja, fila, datos, COL.BIB_PREST, COL.CORREO_PREST);
  const d = datosPlantilla(datos);

  enviarCorreo({
    hoja, fila, para: datos[COL.CORREO_SOL - 1],
    asunto: `¡Préstamo aprobado! Retira en 24h [${id}] — Red REUNIR`,
    cuerpo: plantillaCorreo("aprobada_final", d),
  });
  if (correoOrigen) {
    enviarCorreo({
      hoja, fila, para: correoOrigen,
      asunto: `Préstamo aprobado para tu usuario [${id}] — Red REUNIR`,
      cuerpo: plantillaCorreo("aviso_origen_aprobado", d),
    });
  }
  enviarABiblioteca(hoja, fila, correoPrest, datos[COL.BIB_PREST - 1],
    `Pendiente de entrega [${id}] — Red REUNIR`,
    plantillaCorreo("confirmar_entrega", datosPlantilla(datos, { linkPrestamo: crearLinkAccion(id, "confirmar_prestamo") })));

  return respuestaHTML(`✅ Préstamo <strong>${escapeHtml(id)}</strong> aprobado. El usuario tiene 24h para retirar. Cuando lo entregues, usa el botón <strong>Confirmar entrega</strong> que te llegó al correo.`);
}

function rechazarPrestamista(hoja, fila, datos, id, motivo, funcionario) {
  hoja.getRange(fila, COL.ESTADO).setValue(ESTADOS.RECHAZADA_PRESTAMISTA);
  hoja.getRange(fila, COL.DISP_PREST).setValue("NO");
  hoja.getRange(fila, COL.FUNC_PREST).setValue(textoSeguroHoja(funcionario));
  hoja.getRange(fila, COL.FECHA_DEC_PREST).setValue(new Date());
  hoja.getRange(fila, COL.MOTIVO_PREST).setValue(textoSeguroHoja(motivo));
  appendLog(hoja, fila, `RECHAZADA por prestamista. Funcionario: ${funcionario || "—"}. Motivo: ${motivo}`);

  const d = datosPlantilla(datos, { motivo });
  enviarCorreo({
    hoja, fila, para: datos[COL.CORREO_SOL - 1],
    asunto: `Material no disponible [${id}] — Red REUNIR`,
    cuerpo: plantillaCorreo("rechazada_prestamista", d),
  });
  const correoOrigen = correoVigente(hoja, fila, datos, COL.BIB_ORIGEN, COL.CORREO_ORIGEN);
  if (correoOrigen) {
    enviarCorreo({
      hoja, fila, para: correoOrigen,
      asunto: `Solicitud rechazada por no disponibilidad [${id}] — Red REUNIR`,
      cuerpo: plantillaCorreo("aviso_origen_rechazo", d),
    });
  }
  return respuestaHTML(`Solicitud <strong>${escapeHtml(id)}</strong> rechazada por no disponibilidad. El solicitante fue notificado.`);
}

// ============================================================
//  5. ETAPA 3 — ENTREGA Y DEVOLUCIÓN
// ============================================================
function confirmarPrestamo(hoja, fila, datos, id, funcionario) {
  const ahora      = new Date();
  const diasPrest  = getDiasPrestamo(datos[COL.BIB_PREST - 1]);
  const devolucion = new Date(ahora.getTime() + diasPrest * 24 * 60 * 60 * 1000);

  hoja.getRange(fila, COL.ESTADO).setValue(ESTADOS.EN_PRESTAMO);
  hoja.getRange(fila, COL.FECHA_PREST).setValue(ahora);
  hoja.getRange(fila, COL.FECHA_DEV_ESP).setValue(devolucion);
  hoja.getRange(fila, COL.ENTREGADO).setValue("SI");
  if (funcionario) hoja.getRange(fila, COL.FUNC_PREST).setValue(textoSeguroHoja(funcionario));
  appendLog(hoja, fila, `Material ENTREGADO por ${funcionario || "—"}. Plazo: ${diasPrest} días. Devolución: ${fmt(devolucion)}`);

  try {
    const ev = CalendarApp.getDefaultCalendar().createAllDayEvent(
      `📚 Devolución préstamo ${id} — ${datos[COL.TITULO - 1]}`, devolucion,
      { description: `Solicitud: ${id}\nSolicitante: ${datos[COL.NOMBRE - 1]}\nPlazo: ${diasPrest} días`,
        guests: datos[COL.CORREO_SOL - 1] });
    hoja.getRange(fila, COL.CAL_ID).setValue(ev.getId());
  } catch (err) { Logger.log("Calendar error: " + err.message); }

  const correoPrest  = correoVigente(hoja, fila, datos, COL.BIB_PREST, COL.CORREO_PREST);
  const correoOrigen = correoVigente(hoja, fila, datos, COL.BIB_ORIGEN, COL.CORREO_ORIGEN);
  const d = datosPlantilla(datos, {
    diasPrestamo: diasPrest, fechaDevolucion: fmt(devolucion),
    linkDevolucion: crearLinkAccion(id, "confirmar_devolucion"),
  });

  enviarCorreo({
    hoja, fila, para: datos[COL.CORREO_SOL - 1],
    asunto: `Material entregado: devuélvelo antes del ${fmt(devolucion)} [${id}] — Red REUNIR`,
    cuerpo: plantillaCorreo("en_prestamo", d),
  });
  enviarABiblioteca(hoja, fila, correoPrest, datos[COL.BIB_PREST - 1],
    `Préstamo en curso: registrar devolución [${id}] — Red REUNIR`, plantillaCorreo("prestamo_en_curso", d));
  if (correoOrigen) {
    enviarCorreo({
      hoja, fila, para: correoOrigen,
      asunto: `Material entregado a tu usuario [${id}] — Red REUNIR`,
      cuerpo: plantillaCorreo("aviso_origen_entregado", d),
    });
  }

  return respuestaHTML(`✅ Entrega de <strong>${escapeHtml(id)}</strong> registrada.<br>Plazo: <strong>${diasPrest} días</strong><br>Devolución: <strong>${fmt(devolucion)}</strong>`);
}

function confirmarDevolucion(hoja, fila, datos, id, funcionario, observaciones) {
  const ahora = new Date();
  hoja.getRange(fila, COL.ESTADO).setValue(ESTADOS.DEVUELTA);
  hoja.getRange(fila, COL.FECHA_DEV_REAL).setValue(ahora);
  appendLog(hoja, fila, `Material DEVUELTO. Recibe: ${funcionario || "—"}.${observaciones ? " Obs: " + observaciones : ""}`);

  const calId = datos[COL.CAL_ID - 1];
  if (calId) {
    try { CalendarApp.getEventById(calId).deleteEvent(); }
    catch (err) { Logger.log("No se pudo borrar evento: " + err.message); }
  }

  const d = datosPlantilla(datos, { fechaDevolucion: fmt(ahora), observaciones: observaciones || "" });
  const correoPrest  = correoVigente(hoja, fila, datos, COL.BIB_PREST, COL.CORREO_PREST);
  const correoOrigen = correoVigente(hoja, fila, datos, COL.BIB_ORIGEN, COL.CORREO_ORIGEN);
  enviarCorreo({
    hoja, fila, para: datos[COL.CORREO_SOL - 1],
    asunto: `Devolución registrada [${id}] — Red REUNIR`,
    cuerpo: plantillaCorreo("devuelta", d),
  });
  unirDestinatarios([correoPrest, correoOrigen]).forEach(correo => enviarCorreo({
    hoja, fila, para: correo,
    asunto: `Material devuelto [${id}] — Red REUNIR`,
    cuerpo: plantillaCorreo("devuelta_biblioteca", d),
  }));

  return respuestaHTML(`✅ Devolución de <strong>${escapeHtml(id)}</strong> registrada correctamente.`);
}

// ============================================================
//  6. REVISIÓN AUTOMÁTICA (cada hora)
// ============================================================
function verificarVencimientos() {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (err) { Logger.log("Ocupado: " + err.message); return; }
  try {
    try { actualizarEstadoBibliotecas(); } catch (err) { Logger.log("Estado bibliotecas: " + err.message); }
    reanudarPendientes();
    revisarPlazos();
  } finally { lock.releaseLock(); }
}

// Envía las solicitudes que esperaban un correo que ya fue completado en la hoja
function reanudarPendientes() {
  const hoja = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.HOJA_SOLICITUDES);
  const todo = hoja.getDataRange().getValues();
  for (let i = 1; i < todo.length; i++) {
    const datos = todo[i], fila = i + 1, estado = datos[COL.ESTADO - 1];
    try {
      if (estado === ESTADOS.PEND_ORIGEN) {
        const correo = correoVigente(hoja, fila, datos, COL.BIB_ORIGEN, COL.CORREO_ORIGEN);
        if (correo && enviarValidacionOrigen(hoja, fila, datos, correo)) {
          hoja.getRange(fila, COL.ESTADO).setValue(ESTADOS.VALID_ORIGEN);
          appendLog(hoja, fila, `Correo de origen completado (${correo}). Solicitud enviada.`);
        }
      } else if (estado === ESTADOS.PEND_PRESTAMISTA) {
        const correo = correoVigente(hoja, fila, datos, COL.BIB_PREST, COL.CORREO_PREST);
        if (correo && enviarValidacionPrestamista(hoja, fila, datos, correo)) {
          hoja.getRange(fila, COL.ESTADO).setValue(ESTADOS.VALID_PRESTAMISTA);
          appendLog(hoja, fila, `Correo de prestamista completado (${correo}). Solicitud enviada.`);
        }
      }
    } catch (err) { Logger.log(`Pendiente fila ${fila}: ${err.message}`); }
  }
}

function revisarPlazos() {
  const hoja  = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.HOJA_SOLICITUDES);
  const todo  = hoja.getDataRange().getValues();
  const hoy   = new Date();
  const hora  = Number(Utilities.formatDate(hoy, "America/Bogota", "H"));
  const enHorario = hora >= CONFIG.HORA_INICIO_AVISOS && hora < CONFIG.HORA_FIN_AVISOS;

  for (let i = 1; i < todo.length; i++) {
    const datos = todo[i], fila = i + 1;
    const estado    = datos[COL.ESTADO - 1];
    const id        = datos[COL.ID - 1];
    const correo    = datos[COL.CORREO_SOL - 1];
    const historial = String(datos[COL.HISTORIAL - 1] || "");
    try {
      // ── VENTANA DE RETIRO ────────────────────────────────
      if (estado === ESTADOS.APROBADA) {
        const aprob = parseFechaHora(datos[COL.FECHA_DEC_PREST - 1]);
        if (!aprob) {
          if (historial.indexOf("Fecha de aprobación no legible") === -1) {
            appendLog(hoja, fila, "Fecha de aprobación no legible. Revisar manualmente.");
            avisarAdmin(`[Reunir] Revisar ${id}`, `No se pudo leer la fecha de aprobación de ${id}.\n${CONFIG.SHEET_URL}`);
          }
          continue;
        }
        const horas = (hoy - aprob) / 36e5;
        if (horas >= CONFIG.HORAS_EXPIRA_RETIRO) {
          hoja.getRange(fila, COL.ESTADO).setValue(ESTADOS.NO_RETIRADA);
          appendLog(hoja, fila, `Plazo de retiro VENCIDO (${Math.floor(horas)}h). Solicitud cerrada como no retirada.`);
          const d = datosPlantilla(datos);
          enviarCorreo({ hoja, fila, para: correo, asunto: `Plazo de retiro vencido [${id}] — Red REUNIR`, cuerpo: plantillaCorreo("retiro_vencido", d) });
          unirDestinatarios([
            correoVigente(hoja, fila, datos, COL.BIB_PREST, COL.CORREO_PREST),
            correoVigente(hoja, fila, datos, COL.BIB_ORIGEN, COL.CORREO_ORIGEN),
          ]).forEach(c => enviarCorreo({ hoja, fila, para: c, asunto: `Material no retirado [${id}] — Red REUNIR`, cuerpo: plantillaCorreo("retiro_vencido_biblioteca", d) }));
        } else if (enHorario && horas >= CONFIG.HORAS_RECORDATORIO_RETIRO && historial.indexOf("Recordatorio de retiro enviado") === -1) {
          const ok = enviarCorreo({
            hoja, fila, para: correo, asunto: `Última oportunidad para retirar tu material [${id}] — Red REUNIR`,
            cuerpo: plantillaCorreo("recordatorio_retiro", datosPlantilla(datos, { horasRestantes: Math.max(1, Math.floor(CONFIG.HORAS_EXPIRA_RETIRO - horas)) })),
          });
          if (ok) appendLog(hoja, fila, `Recordatorio de retiro enviado (${Math.floor(horas)}h transcurridas).`);
        }
        continue;
      }

      // ── PRÉSTAMOS ACTIVOS ────────────────────────────────
      if (estado !== ESTADOS.EN_PRESTAMO) continue;
      const fechaDev = parseFechaHora(datos[COL.FECHA_DEV_ESP - 1]);
      if (!fechaDev) continue;
      const dias = diasEntre(hoy, fechaDev);
      const d = datosPlantilla(datos, {
        fechaDevolucion: fmt(fechaDev), diasRestantes: dias, diasVencido: Math.abs(dias),
        linkDevolucion: crearLinkAccion(id, "confirmar_devolucion"),
      });

      if (enHorario && dias >= 0 && dias <= CONFIG.DIAS_RECORDATORIO && historial.indexOf("Recordatorio enviado (") === -1) {
        const ok = enviarCorreo({ hoja, fila, para: correo, asunto: `Devolución el ${fmt(fechaDev)} [${id}] — Red REUNIR`, cuerpo: plantillaCorreo("recordatorio", d) });
        enviarABiblioteca(hoja, fila, correoVigente(hoja, fila, datos, COL.BIB_PREST, COL.CORREO_PREST), datos[COL.BIB_PREST - 1],
          `Préstamo próximo a vencer [${id}] — Red REUNIR`, plantillaCorreo("recordatorio_biblioteca", d));
        if (ok) appendLog(hoja, fila, `Recordatorio enviado (${dias} días para vencer).`);
      }

      if (enHorario && dias < 0) {
        hoja.getRange(fila, COL.ESTADO).setValue(ESTADOS.VENCIDA);
        appendLog(hoja, fila, `Estado → VENCIDA (${Math.abs(dias)} días de retraso).`);
        enviarCorreo({ hoja, fila, para: correo, asunto: `Material VENCIDO [${id}] — Red REUNIR`, cuerpo: plantillaCorreo("vencida", d) });
        enviarABiblioteca(hoja, fila, correoVigente(hoja, fila, datos, COL.BIB_PREST, COL.CORREO_PREST), datos[COL.BIB_PREST - 1],
          `Préstamo vencido [${id}] — Red REUNIR`, plantillaCorreo("vencida_biblioteca", d));
        const origen = correoVigente(hoja, fila, datos, COL.BIB_ORIGEN, COL.CORREO_ORIGEN);
        if (origen) enviarCorreo({ hoja, fila, para: origen, asunto: `Usuario con préstamo vencido [${id}] — Red REUNIR`, cuerpo: plantillaCorreo("vencida_origen", d) });
        avisarAdmin(`[Reunir] Material vencido: ${id}`, `El préstamo ${id} (${datos[COL.TITULO - 1]}) venció el ${fmt(fechaDev)}. Solicitante: ${datos[COL.NOMBRE - 1]} (${correo}).`);
      }
    } catch (err) { Logger.log(`Plazos fila ${fila}: ${err.message}`); }
  }
}

// ============================================================
//  7. PLANTILLAS DE CORREO (identidad REUNIR)
// ============================================================
function estiloBoton(color) {
  return `display:inline-block;padding:14px 26px;background:${color};color:#ffffff;text-decoration:none;border-radius:30px;font-weight:bold;font-size:15px;margin:6px 6px 6px 0`;
}

function encabezadoMarca() {
  return `<div style="background:#ffffff;padding:18px 20px 12px;text-align:center">
      <img src="${CONFIG.LOGO_URL}" alt="REUNIR — Red de Unidades de Información de Risaralda y Eje Cafetero" width="460" style="width:100%;max-width:460px;height:auto">
    </div>
    <div style="height:6px;background:${MARCA.VERDE};background:linear-gradient(90deg,${MARCA.OSCURO},${MARCA.OLIVA},${MARCA.VERDE})"></div>
    <div style="background:${MARCA.SUAVE};color:${MARCA.OSCURO};text-align:center;padding:8px;font-size:13px;font-weight:bold">Servicio de Préstamo Interbibliotecario</div>`;
}

function plantillaCorreo(tipo, datos) {
  // Todo texto que viene del formulario o de la hoja se escapa antes de ponerlo en HTML
  const d = {};
  Object.keys(datos).forEach(k => {
    d[k] = /^link|Url$/.test(k) ? datos[k] : escapeHtml(datos[k] === undefined || datos[k] === null ? "" : datos[k]);
  });

  const titulo = (t) => `<h2 style="color:${MARCA.OSCURO};font-size:20px;margin:0 0 12px">${t}</h2>`;
  const saludo = `<p>Hola <strong>${d.nombre}</strong>,</p>`;
  const tabla = (filas) => `<table style="width:100%;border-collapse:collapse;margin:14px 0">` + filas.map((f, i) =>
    `<tr style="${i % 2 ? "" : "background:" + MARCA.FONDO}"><td style="padding:9px 10px;font-weight:bold;width:40%;color:${MARCA.GRIS}">${f[0]}</td><td style="padding:9px 10px">${f[1] || "—"}</td></tr>`
  ).join("") + `</table>`;
  const aviso = (t, color) => `<div style="background:${color || MARCA.SUAVE};border-left:5px solid ${MARCA.OLIVA};padding:12px 14px;border-radius:6px;margin:14px 0">${t}</div>`;
  const boton = (link, texto, color) => `<a href="${link}" style="${estiloBoton(color || MARCA.BOTON)}">${texto}</a>`;
  const basicos = () => tabla([["ID de solicitud", `<strong>${d.id}</strong>`], ["Material", d.titulo],
    ["Biblioteca de origen", d.bibOrigen], ["Biblioteca prestamista", d.bibPrestamista], ["Plazo de préstamo", `${d.diasPrestamo} días`]]);
  const conUsuario = () => tabla([["ID de solicitud", `<strong>${d.id}</strong>`], ["Usuario", d.nombre], ["Correo del usuario", d.correoSol],
    ["Material", d.titulo], ["Biblioteca de origen", d.bibOrigen], ["Biblioteca prestamista", d.bibPrestamista]]);

  const plantillas = {
    validacion_origen: () => titulo("Validación de usuario") +
      `<p><strong>${d.bibOrigen}</strong>: un usuario de tu biblioteca pidió un préstamo interbibliotecario. Verifica su <strong>vigencia, multas y entregas pendientes</strong>.</p>` +
      tabla([["ID de solicitud", d.id], ["Usuario", d.nombre], ["Correo", d.correoSol], ["Tipo de usuario", d.tipoUsuario], ["Documento", d.documento], ["Programa", d.programa],
        ["Biblioteca prestamista", d.bibPrestamista], ["Tipo de material", d.tipo], ["Título", d.titulo], ["Autor", d.autor], ["Observaciones", d.info], ["Plazo si se aprueba", `${d.diasPrestamo} días`]]) +
      boton(d.linkAprobar, "✔ Autorizar usuario") + boton(d.linkRechazar, "✖ Rechazar", MARCA.ROJO) +
      `<p style="font-size:12px;color:#777">Control: <a href="${d.sheetUrl}">hoja de solicitudes</a></p>`,

    confirmacion_solicitante: () => titulo("Recibimos tu solicitud") + saludo +
      (d.pendiente === "true"
        ? aviso("Tu biblioteca aún no tiene habilitado el correo en la red. La solicitud quedó registrada y la administración la gestionará.", "#FFF3D6")
        : `<p>Primero tu biblioteca verificará tu estado de usuario y después se gestionará con la biblioteca que tiene el material.</p>`) +
      basicos() + `<p>Guarda el ID <strong>${d.id}</strong> para tus consultas.</p>`,

    info_origen_aprobado: () => titulo("Tu biblioteca autorizó tu solicitud") + saludo +
      (d.pendiente === "true"
        ? aviso("La biblioteca prestamista aún no tiene habilitado el correo en la red. La administración gestionará tu solicitud.", "#FFF3D6")
        : `<p>Ahora <strong>${d.bibPrestamista}</strong> verificará la disponibilidad del material.</p>`) + basicos(),

    rechazada_origen: () => titulo("Solicitud no autorizada") + saludo +
      `<p><strong>${d.bibOrigen}</strong> no autorizó esta solicitud.</p>` + basicos() + aviso(`<strong>Motivo:</strong> ${d.motivo}`, "#FDECEA"),

    validacion_prestamista: () => titulo("Solicitud de préstamo para tu biblioteca") +
      `<p><strong>${d.bibPrestamista}</strong>: la biblioteca de origen ya validó al usuario. Verifica la <strong>disponibilidad del material</strong>.</p>` +
      tabla([["ID de solicitud", d.id], ["Usuario", d.nombre], ["Correo", d.correoSol], ["Tipo de usuario", d.tipoUsuario], ["Programa", d.programa], ["Biblioteca de origen", d.bibOrigen],
        ["Tipo de material", d.tipo], ["Título", d.titulo], ["Autor", d.autor], ["Observaciones", d.info], ["Plazo de préstamo", `${d.diasPrestamo} días`]]) +
      boton(d.linkAprobar, "✔ Disponible: aprobar") + boton(d.linkRechazar, "✖ No disponible", MARCA.ROJO) +
      `<p style="font-size:12px;color:#777">Control: <a href="${d.sheetUrl}">hoja de solicitudes</a></p>`,

    aprobada_final: () => titulo("¡Tu préstamo fue aprobado!") + saludo +
      aviso(`Tienes <strong>24 horas</strong> para retirar el material en <strong>${d.bibPrestamista}</strong>.`) + basicos(),

    aviso_origen_aprobado: () => titulo("Préstamo aprobado para tu usuario") + conUsuario() +
      `<p>El usuario tiene 24 horas para retirar el material.</p>`,

    confirmar_entrega: () => titulo("Pendiente: entregar el material") +
      `<p>Cuando el usuario retire el material, confirma la entrega para iniciar el plazo de <strong>${d.diasPrestamo} días</strong>.</p>` + conUsuario() +
      boton(d.linkPrestamo, "Confirmar entrega del material", MARCA.AZUL),

    rechazada_prestamista: () => titulo("Material no disponible") + saludo +
      `<p><strong>${d.bibPrestamista}</strong> no pudo facilitar el material.</p>` + basicos() + aviso(`<strong>Motivo:</strong> ${d.motivo}`, "#FDECEA") +
      `<p>Puedes intentar con otra biblioteca de la red.</p>`,

    aviso_origen_rechazo: () => titulo("Solicitud rechazada por no disponibilidad") + conUsuario() + aviso(`<strong>Motivo:</strong> ${d.motivo}`, "#FDECEA"),

    en_prestamo: () => titulo("Material entregado") + saludo + `<p>Disfruta tu lectura y devuélvelo a tiempo en tu biblioteca o donde lo hayas acordado.</p>` +
      basicos() + aviso(`Fecha límite de devolución: <strong>${d.fechaDevolucion}</strong>`),

    prestamo_en_curso: () => titulo("Préstamo en curso") + conUsuario() + aviso(`Fecha límite de devolución: <strong>${d.fechaDevolucion}</strong> (${d.diasPrestamo} días)`) +
      `<p>Cuando <strong>recibas el material de vuelta</strong>, regístralo con este botón:</p>` + boton(d.linkDevolucion, "Registrar devolución"),

    aviso_origen_entregado: () => titulo("Material entregado a tu usuario") + conUsuario() + aviso(`Fecha límite de devolución: <strong>${d.fechaDevolucion}</strong>`),

    recordatorio: () => titulo("Recordatorio de devolución") + saludo +
      aviso(`Tu préstamo vence el <strong>${d.fechaDevolucion}</strong> (faltan ${d.diasRestantes} día(s)).`, "#FFF3D6") + basicos(),

    recordatorio_biblioteca: () => titulo("Préstamo próximo a vencer") + conUsuario() + aviso(`Vence el <strong>${d.fechaDevolucion}</strong>.`, "#FFF3D6") +
      boton(d.linkDevolucion, "Registrar devolución"),

    recordatorio_retiro: () => titulo("Última oportunidad para retirar tu material") + saludo +
      aviso(`Te quedan aproximadamente <strong>${d.horasRestantes} hora(s)</strong> para retirarlo en <strong>${d.bibPrestamista}</strong>. Después la solicitud se cierra.`, "#FFF3D6") + basicos(),

    retiro_vencido: () => titulo("Plazo de retiro vencido") + saludo +
      `<p>La solicitud fue cerrada y la reserva liberada. Si aún necesitas el material, envía una nueva solicitud.</p>` + basicos(),

    retiro_vencido_biblioteca: () => titulo("Material no retirado") + `<p>La solicitud se cerró automáticamente. La reserva puede liberarse.</p>` + conUsuario(),

    vencida: () => titulo("Material vencido") + saludo + aviso(`El plazo venció el <strong>${d.fechaDevolucion}</strong>. Días de retraso: <strong>${d.diasVencido}</strong>.`, "#FDECEA") +
      basicos() + `<p>Por favor devuélvelo lo antes posible.</p>`,

    vencida_biblioteca: () => titulo("Préstamo vencido") + conUsuario() + aviso(`Venció el <strong>${d.fechaDevolucion}</strong>.`, "#FDECEA") +
      boton(d.linkDevolucion, "Registrar devolución"),

    vencida_origen: () => titulo("Tu usuario tiene un préstamo vencido") + conUsuario() + aviso(`Venció el <strong>${d.fechaDevolucion}</strong>.`, "#FDECEA"),

    devuelta: () => titulo("Devolución registrada") + saludo + `<p>La biblioteca registró la devolución. ¡Gracias por usar la Red REUNIR!</p>` + basicos(),

    devuelta_biblioteca: () => titulo("Material devuelto") + conUsuario() + aviso(`Devolución registrada el <strong>${d.fechaDevolucion}</strong>. ${d.observaciones}`),
  };

  if (!plantillas[tipo]) throw new Error("Plantilla de correo no definida: " + tipo);

  return `<html><body style="margin:0;padding:0;background:${MARCA.FONDO}">
    <div style="max-width:620px;margin:20px auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #dfe7d3;font-family:Arial,Helvetica,sans-serif;color:${MARCA.GRIS};font-size:15px;line-height:1.5">
      ${encabezadoMarca()}
      <div style="padding:24px">${plantillas[tipo]()}</div>
      <div style="background:${MARCA.GRIS};color:#ffffff;padding:14px;text-align:center;font-size:12px">
        REUNIR · Red de Unidades de Información de Risaralda y Eje Cafetero<br>
        <a href="${CONFIG.SITIO_URL}" style="color:#B9E68A">www.reunir.com.co</a>
      </div>
    </div></body></html>`;
}

// ============================================================
//  8. PÁGINAS WEB DE ACCIÓN
// ============================================================
function paginaBase(contenido) {
  return `<!DOCTYPE html><html><head><base target="_top"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="font-family:Arial,Helvetica,sans-serif;background:${MARCA.FONDO};margin:0;padding:24px 12px;color:${MARCA.GRIS}">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #dfe7d3">
        ${encabezadoMarca()}
        <div style="padding:24px">${contenido}</div>
      </div>
    </body></html>`;
}

function paginaAccion(id, action, titulo, color, resumen, intro, campos) {
  const estilo = "width:100%;padding:10px;box-sizing:border-box;border:1px solid #c9d3bb;border-radius:8px;font-size:15px";
  const inputs = campos.map(c => {
    const req = c.required ? "required" : "";
    const field = c.type === "textarea"
      ? `<textarea name="${c.name}" rows="4" ${req} style="${estilo}"></textarea>`
      : `<input type="${c.type === "date" ? "date" : "text"}" name="${c.name}" ${req} style="${estilo}">`;
    return `<label style="display:block;margin:14px 0 4px;font-weight:bold;font-size:14px">${c.label}</label>${field}`;
  }).join("");

  // target="_top" es obligatorio: sin él la confirmación queda en blanco dentro del marco de Google
  const contenido = `
    <h3 style="margin-top:0;color:${MARCA.OSCURO}">${titulo} — ${escapeHtml(id)}</h3>
    <div style="background:${MARCA.SUAVE};padding:12px;border-radius:8px;font-size:14px">${resumen}</div>
    <p style="font-size:14px">${intro}</p>
    <form method="get" action="${CONFIG.WEBAPP_URL}" target="_top"
      onsubmit="var b=this.querySelector('button');if(b.disabled)return false;setTimeout(function(){b.disabled=true;b.textContent='Registrando…';},0);">
      <input type="hidden" name="action" value="${action}">
      <input type="hidden" name="id" value="${escapeHtml(id)}">
      ${inputs}
      <br><br>
      <button type="submit" style="background:${color};color:#fff;padding:13px 30px;border:none;border-radius:30px;cursor:pointer;font-weight:bold;font-size:15px">Confirmar</button>
    </form>`;
  return HtmlService.createHtmlOutput(paginaBase(contenido)).setTitle(titulo + " — Red REUNIR");
}

function respuestaHTML(msg) {
  return HtmlService.createHtmlOutput(paginaBase(
    `<div style="text-align:center"><p style="font-size:18px">${msg}</p><p style="color:#999;font-size:13px">Puedes cerrar esta ventana.</p></div>`
  )).setTitle("Red REUNIR");
}

// ============================================================
//  9. FUNCIONES AUXILIARES
// ============================================================
// Envía un correo. Si falla, lo deja en el Historial y avisa al administrador (no detiene el flujo).
function enviarCorreo({ para, asunto, cuerpo, hoja, fila }) {
  const destinatarios = correosValidos(para).join(",");
  try {
    if (!destinatarios) throw new Error(`Destinatario no válido: "${para}"`);
    MailApp.sendEmail({
      to: destinatarios, subject: asunto, htmlBody: cuerpo,
      name: CONFIG.NOMBRE_RED, replyTo: CONFIG.ADMIN_EMAIL,
    });
    if (hoja && fila) appendLog(hoja, fila, `✉ Correo enviado a ${destinatarios}: ${asunto}`);
    return true;
  } catch (err) {
    Logger.log(`Fallo de correo a ${para}: ${err.message}`);
    if (hoja && fila) appendLog(hoja, fila, `⚠ NO se pudo enviar a ${para}: ${err.message}`);
    avisarAdmin("[Reunir] Falló el envío de un correo", `Destinatario: ${para}\nAsunto: ${asunto}\nError: ${err.message}\n${CONFIG.SHEET_URL}`);
    return false;
  }
}

// Correo que le corresponde a una biblioteca; si no tiene, llega al administrador para gestionarlo
function enviarABiblioteca(hoja, fila, correo, nombreBib, asunto, cuerpo) {
  if (correo) return enviarCorreo({ hoja, fila, para: correo, asunto, cuerpo });
  return enviarCorreo({ hoja, fila, para: CONFIG.ADMIN_EMAIL, asunto: `[Sin correo: ${nombreBib}] ${asunto}`, cuerpo });
}

function avisarAdmin(asunto, texto) {
  try { MailApp.sendEmail({ to: CONFIG.ADMIN_EMAIL, subject: asunto, body: texto, name: CONFIG.NOMBRE_RED }); }
  catch (err) { Logger.log("No se pudo avisar al administrador: " + err.message); }
}

function unirDestinatarios(lista) {
  return lista.filter(Boolean).filter((c, i, a) => a.indexOf(c) === i);
}

function crearLinkAccion(id, action) {
  return `${CONFIG.WEBAPP_URL}?action=${action}&id=${encodeURIComponent(id)}`;
}

function buscarFila(hoja, id) {
  const vals = hoja.getRange(1, COL.ID, hoja.getLastRow(), 1).getValues();
  for (let i = 1; i < vals.length; i++) {
    if (vals[i][0] === id) return i + 1;
  }
  return null;
}

// Evita que un texto del formulario se interprete como fórmula en la hoja
function textoSeguroHoja(v) {
  const s = String(v === null || v === undefined ? "" : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function fmt(d) {
  if (!d) return "";
  if (!(d instanceof Date)) d = new Date(d);
  if (isNaN(d.getTime())) return "";
  return Utilities.formatDate(d, "America/Bogota", "dd/MM/yyyy");
}
function fmtHora(d) {
  return Utilities.formatDate(d, "America/Bogota", "dd/MM/yyyy HH:mm");
}
// Días calendario (hora de Colombia) desde "desde" hasta "hasta"
function diasEntre(desde, hasta) {
  const dia = (x) => Date.parse(Utilities.formatDate(x, "America/Bogota", "yyyy-MM-dd") + "T00:00:00Z");
  return Math.round((dia(hasta) - dia(desde)) / 864e5);
}
function parseFecha(str) {
  if (!str) return "";
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(str);
  return isNaN(d.getTime()) ? str : d;
}
// Acepta un Date o texto "dd/MM/yyyy" / "dd/MM/yyyy HH:mm"
function parseFechaHora(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return isNaN(valor.getTime()) ? null : valor;
  const m = String(valor).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || 12), Number(m[5] || 0));
  const d = new Date(valor);
  return isNaN(d.getTime()) ? null : d;
}
function logEntry(msg, actor) {
  return `[${fmtHora(new Date())}] ${actor ? actor + ": " : ""}${msg}`;
}
function appendLog(hoja, fila, msg) {
  const cell = hoja.getRange(fila, COL.HISTORIAL);
  const prev = cell.getValue() || "";
  cell.setValue(prev + (prev ? "\n" : "") + logEntry(msg));
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ============================================================
//  10. INSTALACIÓN, ACTIVADORES Y DIAGNÓSTICO
//  Ejecutar SIEMPRE con la cuenta dueña del proyecto.
// ============================================================
function setupInicial() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let hoja = ss.getSheetByName(CONFIG.HOJA_SOLICITUDES);
  if (!hoja) hoja = ss.insertSheet(CONFIG.HOJA_SOLICITUDES);
  const encabezados = [
    "ID", "Fecha solicitud", "Nombre solicitante", "Correo solicitante",
    "Tipo de usuario", "Número de documento", "Programa académico",
    "Biblioteca solicitante (origen)", "Correo biblioteca origen",
    "Biblioteca prestamista (destino)", "Correo biblioteca prestamista",
    "Tipo material", "Título", "Autor", "Información / Observaciones", "Estado",
    "Autorización origen (SI/NO)", "Vigencia del usuario", "Funcionario origen", "Fecha decisión origen", "Motivo rechazo origen",
    "Disponibilidad (SI/NO)", "Funcionario prestamista", "Fecha decisión prestamista", "Motivo rechazo prestamista",
    "Fecha préstamo", "Fecha devolución esperada", "Fecha devolución real", "Se entregó material", "ID Calendar", "Historial",
  ];
  hoja.getRange(1, 1, 1, encabezados.length).setValues([encabezados]);
  hoja.getRange(1, 1, 1, encabezados.length).setBackground(MARCA.OSCURO).setFontColor("white").setFontWeight("bold");
  hoja.setFrozenRows(1);

  let hojaBib = ss.getSheetByName(CONFIG.HOJA_BIBLIOTECAS);
  if (!hojaBib) hojaBib = ss.insertSheet(CONFIG.HOJA_BIBLIOTECAS);
  const encBib = ["Nombre biblioteca", "Institución", "Correo responsable", "Días préstamo", "Ciudad / Red", "Correo activo"];
  hojaBib.getRange(1, 1, 1, encBib.length).setValues([encBib]);
  hojaBib.getRange(1, 1, 1, encBib.length).setBackground(MARCA.OSCURO).setFontColor("white").setFontWeight("bold");
  hojaBib.setFrozenRows(1);

  configurarActivadores();
}

// Deja exactamente un activador de formulario y una revisión cada hora
function configurarActivadores() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (["onFormSubmit", "procesarFormularioReunir", "verificarVencimientos"].indexOf(fn) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("procesarFormularioReunir").forSpreadsheet(CONFIG.SHEET_ID).onFormSubmit().create();
  ScriptApp.newTrigger("verificarVencimientos").timeBased().everyHours(1).create();
  Logger.log("✅ Activadores listos: formulario + revisión cada hora.");
}
function repararTriggerFormulario() { configurarActivadores(); }

function formularioVinculado() {
  const url = SpreadsheetApp.openById(CONFIG.SHEET_ID).getFormUrl();
  return url ? FormApp.openByUrl(url) : null;
}
function urlFormulario() {
  try { const f = formularioVinculado(); return f ? f.getPublishedUrl() : ""; }
  catch (err) { Logger.log("Formulario: " + err.message); return ""; }
}
function verUrlFormulario() { Logger.log(urlFormulario() || "No hay formulario vinculado a la hoja."); }

// Solo para una instalación nueva (crea el formulario desde cero)
function _camposFormulario(form) {
  const ss      = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const hojaBib = ss.getSheetByName(CONFIG.HOJA_BIBLIOTECAS);
  const filas   = hojaBib.getRange(2, 1, Math.max(hojaBib.getLastRow() - 1, 1), 1).getValues();
  const bibliotecas = filas.map(f => f[0]).filter(n => n !== "");

  form.setTitle("PRÉSTAMO INTERBIBLIOTECARIO - RED REUNIR");
  form.setDescription("RED DE UNIDADES DE INFORMACIÓN DE RISARALDA Y EJE CAFETERO");
  form.setConfirmationMessage("Solicitud registrada. Tu biblioteca validará tu usuario y luego se gestionará el préstamo. Recibirás notificaciones por correo.");

  form.addSectionHeaderItem()
    .setTitle("FORMULARIO DE SOLICITUD")
    .setHelpText("Diligencia completamente este formulario para iniciar la solicitud de préstamo interbibliotecario.");

  form.addTextItem().setTitle("Nombre completo del solicitante").setRequired(true);
  form.addTextItem().setTitle("Correo institucional").setRequired(true);
  form.addListItem().setTitle("Tipo de usuario").setChoiceValues(["Estudiante", "Docente", "Administrativo", "Egresado", "Otro"]).setRequired(true);
  form.addTextItem().setTitle("Número de documento de identificación").setRequired(true);
  form.addListItem().setTitle("Biblioteca solicitante (a la que perteneces)").setChoiceValues(bibliotecas).setRequired(true);
  form.addListItem().setTitle("Biblioteca prestamista (a la que se solicita el material)").setChoiceValues(bibliotecas).setRequired(true);
  form.addTextItem().setTitle("Programa académico").setRequired(true);
  form.addListItem().setTitle("Tipo de material").setChoiceValues(["Libro", "Revista", "Artículo", "Otro"]).setRequired(true);
  form.addTextItem().setTitle("Título").setRequired(true);
  form.addTextItem().setTitle("Autor").setRequired(false);
  form.addParagraphTextItem().setTitle("Información adicional / Observaciones").setRequired(false);
}

function crearFormularioReunir() {
  const form = FormApp.create("Solicitud de Préstamo Interbibliotecario - Red Reunir");
  _camposFormulario(form);
  form.setDestination(FormApp.DestinationType.SPREADSHEET, CONFIG.SHEET_ID);
  Logger.log("Formulario creado: " + form.getPublishedUrl());
}

// Actualiza las listas de bibliotecas del formulario con la hoja, SIN borrar preguntas ni crear columnas nuevas
function sincronizarFormulario() {
  const hojaBib = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.HOJA_BIBLIOTECAS);
  const nombres = unirDestinatarios(hojaBib.getDataRange().getValues().slice(1).map(f => String(f[0]).trim()));
  const form = formularioVinculado();
  if (!form) throw new Error("No hay formulario vinculado a la hoja.");
  let n = 0;
  form.getItems(FormApp.ItemType.LIST).forEach(item => {
    if (/^biblioteca (solicitante|prestamista)/.test(normalizar(item.getTitle()))) {
      item.asListItem().setChoiceValues(nombres); n++;
    }
  });
  Logger.log(`✅ ${n} listas actualizadas con ${nombres.length} bibliotecas.`);
}
function ajustarFormularioReunir() { sincronizarFormulario(); }

// Reporte de salud del sistema (no envía correos)
function diagnosticoSistema() {
  const lineas = actualizarEstadoBibliotecas();
  Logger.log("Correos disponibles hoy: " + MailApp.getRemainingDailyQuota());
  Logger.log("Activadores de esta cuenta: " + ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction()).join(", "));
  Logger.log("Formulario: " + (urlFormulario() || "NO VINCULADO"));
  Logger.log("Bibliotecas:\n" + lineas.join("\n"));
}
