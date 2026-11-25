// Simulador local de los servicios de Apps Script: prueba el flujo completo SIN enviar correos reales.
const fs = require('fs'), vm = require('vm'), path = require('path');
const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const BIBS = JSON.parse(fs.readFileSync(path.join(__dirname, 'bibliotecas.json'), 'utf8')); // copia de la hoja real

let fallos = 0, pruebas = 0;
function ok(cond, msg) { pruebas++; if (!cond) { fallos++; console.log('  ✗ ' + msg); } }

function mundo(bibs) {
  const hojas = {}, correos = [], paginas = [];
  let ahora = new Date('2026-11-30T10:00:00-05:00');
  class Fecha extends Date { constructor(...a) { if (a.length) super(...a); else super(ahora.getTime()); } static now() { return ahora.getTime(); } }
  function Hoja(nombre, filas) {
    const d = filas.map(f => f.slice());
    const h = {
      d, getName: () => nombre,
      getLastRow: () => d.length, getLastColumn: () => Math.max(0, ...d.map(f => f.length)),
      getDataRange: () => h.getRange(1, 1, d.length, h.getLastColumn()),
      appendRow: f => d.push(f.slice()), setFrozenRows() {},
      getRange(r, c, nr = 1, nc = 1) {
        const rango = {
          getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (d[r - 1 + i] || [])[c - 1 + j] ?? '')),
          getDisplayValues: () => rango.getValues().map(f => f.map(String)),
          getValue: () => rango.getValues()[0][0],
          setValue: v => { while (d.length < r) d.push([]); d[r - 1][c - 1] = v; return rango; },
          setValues: vs => { vs.forEach((f, i) => f.forEach((v, j) => { while (d.length < r + i) d.push([]); d[r - 1 + i][c - 1 + j] = v; })); return rango; },
          setBackground: () => rango, setFontColor: () => rango, setFontWeight: () => rango,
          getSheet: () => h, getRow: () => r,
        };
        return rango;
      },
    };
    return h;
  }
  const dosD = n => String(n).padStart(2, '0');
  const ctx = {
    Date: Fecha, console,
    Logger: { log() {} },
    SpreadsheetApp: { openById: () => ({ getSheetByName: n => hojas[n], getFormUrl: () => null }) },
    MailApp: { sendEmail: (a, b, c) => correos.push(typeof a === 'string' ? { to: a, subject: b, body: c } : a), getRemainingDailyQuota: () => 1500 },
    CalendarApp: { getDefaultCalendar: () => ({ createAllDayEvent: () => ({ getId: () => 'ev1' }) }), getEventById: () => ({ deleteEvent() {} }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    HtmlService: { createHtmlOutput: html => { paginas.push(html); return { html, setTitle() { return this; } }; } },
    ScriptApp: { getProjectTriggers: () => [] },
    Utilities: { formatDate: (f, tz, formato) => {
      const t = new Date(f.getTime() - 5 * 36e5);
      const m = { yyyy: t.getUTCFullYear(), MM: dosD(t.getUTCMonth() + 1), dd: dosD(t.getUTCDate()), HH: dosD(t.getUTCHours()), mm: dosD(t.getUTCMinutes()), H: t.getUTCHours() };
      return formato.replace(/yyyy|MM|dd|HH|mm|H/g, k => m[k]);
    } },
  };
  vm.createContext(ctx);
  vm.runInContext(code + '\n;this.api={COL,ESTADOS,CONFIG,procesarFormularioReunir,doGet,verificarVencimientos,getDatosBiblioteca};', ctx);
  hojas.Bibliotecas = Hoja('Bibliotecas', bibs);
  hojas.Solicitudes = Hoja('Solicitudes', [Array(31).fill('h')]);
  const preguntas = ['Marca temporal', 'Nombre completo del solicitante', 'Correo institucional', 'Tipo de usuario', 'Número de documento de identificación',
    'Biblioteca solicitante (a la que perteneces)', 'Biblioteca prestamista (a la que se solicita el material)', 'Programa académico', 'Tipo de material', 'Título', 'Autor', 'Información adicional / Observaciones'];
  // Igual que la hoja real: columnas viejas duplicadas y vacías antes de las actuales
  const viejas = ['Marca temporal', 'Nombre completo del solicitante', 'Correo institucional', 'Tipo de material', 'Título', 'Autor'];
  hojas.Resp = Hoja('Resp', [viejas.concat(preguntas.slice(1))]);
  const w = {
    ctx, api: ctx.api, hojas, correos, paginas,
    avanzar(horas) { ahora = new Date(ahora.getTime() + horas * 36e5); },
    enviar(origen, prest, extra = {}) {
      const r = ['x', '', '', '', '', '', 'Ana Prueba', extra.correo || 'usuario@prueba.test', 'Estudiante', '123', origen, prest, 'Programa', 'Libro', extra.titulo || 'El principito', 'Autor', ''];
      hojas.Resp.d.push(r);
      const n = correos.length;
      ctx.api.procesarFormularioReunir({ range: hojas.Resp.getRange(hojas.Resp.d.length, 1) });
      return correos.slice(n);
    },
    fila(i) { return hojas.Solicitudes.d[i ?? hojas.Solicitudes.d.length - 1]; },
    accion(action, extra = {}) {
      const n = correos.length;
      const res = ctx.api.doGet({ parameter: Object.assign({ action, id: w.fila(extra.i)[0] }, extra.p) });
      return { nuevos: correos.slice(n), html: res.html };
    },
    revisar() { const n = correos.length; ctx.api.verificarVencimientos(); return correos.slice(n); },
  };
  return w;
}
const destinos = l => l.map(c => c.to).sort().join(' | ');
const lista = (...x) => x.filter(Boolean).sort().join(' | ');

const base = mundo(BIBS);
const info = BIBS.slice(1).map(f => base.api.getDatosBiblioteca(f[0]));
const ADMIN = base.api.CONFIG.ADMIN_EMAIL, USER = 'usuario@prueba.test';
console.log(`Bibliotecas: ${info.length} · con correo: ${info.filter(b => b.correo).length} · sin correo/inactivas: ${info.filter(b => !b.correo).length}`);

// 1) Flujo completo para TODAS las combinaciones origen → prestamista
let pares = 0, completos = 0, pendientes = 0;
for (const o of info) for (const p of info) {
  if (o === p) continue; pares++;
  const w = mundo(BIBS), E = w.api.ESTADOS, C = w.api.COL, t = `${o.nombre} → ${p.nombre}`;
  let m = w.enviar(o.nombre, p.nombre);
  const est = () => w.fila()[C.ESTADO - 1];
  if (!o.correo) {
    ok(est() === E.PEND_ORIGEN && destinos(m) === lista(ADMIN, USER), `${t}: pendiente origen → ${destinos(m)}`); pendientes++; continue;
  }
  ok(destinos(m) === lista(o.correo, USER), `${t}: envío formulario → ${destinos(m)}`);
  let r = w.accion('aprobar_origen'); ok(/target="_top"/.test(r.html), `${t}: página sin target _top`);
  r = w.accion('confirmar_aprobar_origen', { p: { funcionario: 'F', vigencia: '2026-12-31' } });
  if (!p.correo) { ok(est() === E.PEND_PRESTAMISTA && destinos(r.nuevos) === lista(ADMIN, USER), `${t}: pendiente prestamista → ${destinos(r.nuevos)}`); pendientes++; continue; }
  ok(destinos(r.nuevos) === lista(p.correo, USER), `${t}: aprueba origen → ${destinos(r.nuevos)}`);
  r = w.accion('confirmar_aprobar_origen', { p: { funcionario: 'F' } }); ok(r.nuevos.length === 0, `${t}: doble clic reenvía`);
  r = w.accion('confirmar_aprobar_prestamista', { p: { funcionario: 'G' } });
  ok(destinos(r.nuevos) === lista(USER, o.correo, p.correo), `${t}: aprueba prestamista → ${destinos(r.nuevos)}`);
  r = w.accion('confirmar_prestamo_final', { p: { funcionario: 'G' } });
  ok(destinos(r.nuevos) === lista(USER, p.correo, o.correo), `${t}: entrega → ${destinos(r.nuevos)}`);
  const btnDev = r.nuevos.filter(c => c.htmlBody.includes('confirmar_devolucion'));
  ok(btnDev.length === 1 && btnDev[0].to === p.correo, `${t}: botón de devolución debe llegar solo a la prestamista`);
  const dias = Math.round((w.fila()[C.FECHA_DEV_ESP - 1] - w.fila()[C.FECHA_PREST - 1]) / 864e5);
  ok(dias === p.diasPrestamo, `${t}: días ${dias} vs ${p.diasPrestamo}`);
  r = w.accion('confirmar_devolucion_final', { p: { funcionario: 'G' } });
  ok(est() === E.DEVUELTA && destinos(r.nuevos) === lista(USER, p.correo, o.correo), `${t}: devolución → ${destinos(r.nuevos)}`);
  completos++;
}
console.log(`Combinaciones probadas: ${pares} · flujo completo hasta devolución: ${completos} · quedan pendientes por falta de correo: ${pendientes}`);

// 2) Escenarios especiales
const conCorreo = info.filter(b => b.correo), sin = info.find(b => !b.correo);
const [A, B] = conCorreo;
const copia = () => BIBS.map(f => f.slice());
const idx = (bibs, nombre) => bibs.findIndex(f => f[0] === nombre);
{ // rechazos
  let w = mundo(BIBS); w.enviar(A.nombre, B.nombre);
  let r = w.accion('confirmar_rechazo_origen', { p: { motivo: 'multa', funcionario: 'F' } });
  ok(destinos(r.nuevos) === USER, 'rechazo origen → ' + destinos(r.nuevos));
  w = mundo(BIBS); w.enviar(A.nombre, B.nombre); w.accion('confirmar_aprobar_origen', { p: { funcionario: 'F' } });
  r = w.accion('confirmar_rechazo_prestamista', { p: { motivo: 'prestado', funcionario: 'F' } });
  ok(destinos(r.nuevos) === lista(USER, A.correo), 'rechazo prestamista → ' + destinos(r.nuevos));
}
{ // cambiar correo y días en la hoja a mitad del proceso
  const bibs = copia(), w = mundo(bibs); w.enviar(A.nombre, B.nombre);
  const h = w.hojas.Bibliotecas.d[idx(bibs, B.nombre)]; h[2] = 'nuevo@biblio.test'; h[3] = '30 días';
  let r = w.accion('confirmar_aprobar_origen', { p: { funcionario: 'F' } });
  ok(destinos(r.nuevos) === lista('nuevo@biblio.test', USER), 'correo nuevo de la hoja → ' + destinos(r.nuevos));
  ok(r.nuevos.some(c => c.htmlBody.includes('30 días')), 'plazo nuevo visible en el correo');
  w.accion('confirmar_aprobar_prestamista', { p: { funcionario: 'G' } }); w.accion('confirmar_prestamo_final', { p: { funcionario: 'G' } });
  const C = w.api.COL; ok(Math.round((w.fila()[C.FECHA_DEV_ESP - 1] - w.fila()[C.FECHA_PREST - 1]) / 864e5) === 30, 'plazo 30 días aplicado');
}
{ // Correo activo = No, dos correos en una celda y nombre con distinta escritura
  const bibs = copia(); bibs[idx(bibs, A.nombre)][5] = 'No'; bibs[idx(bibs, B.nombre)][2] = ' uno@b.test; dos@b.test ';
  const w = mundo(bibs);
  ok(w.api.getDatosBiblioteca(A.nombre).correo === null, 'Correo activo = No debe desactivar');
  ok(w.api.getDatosBiblioteca('  ' + B.nombre.toUpperCase() + ' ').correo === 'uno@b.test,dos@b.test', 'varios correos / mayúsculas');
}
{ // pendiente que se reanuda cuando el lunes se completa el correo
  const bibs = copia(), w = mundo(bibs), E = w.api.ESTADOS, C = w.api.COL;
  w.enviar(sin.nombre, B.nombre);
  ok(w.revisar().length === 0, 'sin correo no reenvía');
  const h = w.hojas.Bibliotecas.d[idx(bibs, sin.nombre)]; h[2] = 'lunes@biblio.test'; h[5] = 'Sí';
  const m = w.revisar(); ok(destinos(m) === 'lunes@biblio.test' && w.fila()[C.ESTADO - 1] === E.VALID_ORIGEN, 'reanuda pendiente → ' + destinos(m));
  ok(w.revisar().length === 0, 'no duplica al reanudar');
  ok(String(w.hojas.Bibliotecas.d[idx(bibs, sin.nombre)][6]).startsWith('✅'), 'columna de estado actualizada');
}
{ // retiro: recordatorio 24h, cierre 48h
  const w = mundo(BIBS), E = w.api.ESTADOS, C = w.api.COL;
  w.enviar(A.nombre, B.nombre); w.accion('confirmar_aprobar_origen', { p: { funcionario: 'F' } }); w.accion('confirmar_aprobar_prestamista', { p: { funcionario: 'G' } });
  w.avanzar(2); ok(w.revisar().length === 0, 'sin aviso antes de 24h');
  w.avanzar(23); let m = w.revisar(); ok(destinos(m) === USER, 'recordatorio 24h → ' + destinos(m));
  w.avanzar(1); ok(w.revisar().length === 0, 'recordatorio de retiro no se repite');
  w.avanzar(23); m = w.revisar(); ok(destinos(m) === lista(USER, A.correo, B.correo) && w.fila()[C.ESTADO - 1] === E.NO_RETIRADA, 'cierre 48h → ' + destinos(m));
}
{ // recordatorio y vencimiento (revisión cada hora durante todo el préstamo)
  const w = mundo(BIBS), E = w.api.ESTADOS, C = w.api.COL;
  w.enviar(A.nombre, B.nombre); w.accion('confirmar_aprobar_origen', { p: { funcionario: 'F' } }); w.accion('confirmar_aprobar_prestamista', { p: { funcionario: 'G' } }); w.accion('confirmar_prestamo_final', { p: { funcionario: 'G' } });
  const todos = []; for (let h = 0; h < 24 * (B.diasPrestamo + 4); h++) { w.avanzar(1); todos.push(...w.revisar()); }
  const rec = todos.filter(c => /Devolución el|próximo a vencer/.test(c.subject)), ven = todos.filter(c => /VENCIDO|vencido/i.test(c.subject));
  ok(destinos(rec) === lista(USER, B.correo), 'recordatorio una sola vez → ' + destinos(rec));
  ok(destinos(ven) === lista(USER, B.correo, A.correo, ADMIN), 'vencimiento una sola vez → ' + destinos(ven));
  ok(w.fila()[C.ESTADO - 1] === E.VENCIDA, 'estado vencida');
  const r = w.accion('confirmar_devolucion_final', { p: { funcionario: 'G' } }); ok(r.nuevos.length === 3, 'devolver un vencido');
}
{ // correo inválido y texto malicioso
  const w = mundo(BIBS);
  const m = w.enviar(A.nombre, B.nombre, { titulo: '<script>x</script>' });
  ok(!m.some(c => c.htmlBody && c.htmlBody.includes('<script>x')), 'HTML escapado en correos');
  const m2 = w.enviar(A.nombre, B.nombre, { correo: 'sin-arroba' });
  ok(destinos(m2) === ADMIN, 'correo de solicitante inválido avisa al admin → ' + destinos(m2));
}
console.log(`\nVerificaciones: ${pruebas} · fallos: ${fallos}`);
process.exit(fallos ? 1 : 0);
