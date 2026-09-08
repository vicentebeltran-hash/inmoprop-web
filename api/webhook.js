/* =============================================================
   INMOPROP · /api/webhook
   -------------------------------------------------------------
   ⚠  PROVISIONAL · SOLO PARA LAS PRUEBAS  ⚠

   El envío por email a vicente.beltran@realmark.es es un APAÑO
   TEMPORAL para poder ver qué se está vendiendo mientras el back
   office no tiene un punto de entrada propio. NO es la forma
   definitiva de dar de alta licencias:

     · Nadie debe dar de alta una licencia leyendo un email a
       mano. El email es para VER las ventas, no para operarlas.
     · No hay reintentos ni control de duplicados por nuestra
       parte: si un email se pierde o llega dos veces, no se
       entera nadie.
     · Los datos personales del comprador viajan por correo, con
       lo que eso implica de cara al RGPD. Cuanto menos tiempo
       esté así, mejor.

   LO DEFINITIVO es rellenar BACKOFFICE_URL con el endpoint del
   back office: entonces el MISMO JSON se manda por HTTPS y el
   alta se hace sola. El email puede quedarse como copia de
   cortesía o apagarse poniendo AVISOS_PARA en blanco. El código
   ya está preparado para las dos cosas: no hay que reescribir
   nada, solo poner la variable de entorno.

   Mientras BACKOFFICE_URL esté vacía, todo lo que sale de aquí
   va marcado como "provisional": true en el JSON y con un aviso
   en el email.
   -------------------------------------------------------------
   El puente entre Stripe y nuestro back office.

   CÓMO FUNCIONA ESTO, EN CORTO
   Stripe llama a esta URL cada vez que pasa algo con una compra.
   Aquí no nos creemos nada de lo que llega: cogemos solo el id
   del evento y se lo volvemos a preguntar a Stripe con nuestra
   clave secreta. Si Stripe lo confirma, es auténtico. Con esos
   datos montamos un fichero JSON con TODO lo que se ha comprado
   y lo mandamos por email (y, si está configurada, también por
   HTTPS al back office).

   NUNCA se debe dar de alta una licencia desde el navegador, al
   volver de la pasarela: si el cliente cierra la pestaña, la
   venta existe y el sistema no se entera. Stripe, en cambio,
   reintenta este webhook hasta que responde 200.

   QUÉ HAY QUE DAR DE ALTA EN VERCEL (Settings > Environment Variables)
     STRIPE_SECRET_KEY   sk_test_... / sk_live_...   (ya la tienes)
     RESEND_API_KEY      re_...        para poder enviar el email
     AVISOS_PARA         vicente.beltran@realmark.es
     AVISOS_DESDE        Inmoprop <ventas@realmark.es>
     ACTIVACION_SECRET   una frase larga inventada, para firmar
                         el token de activación de licencias
     BACKOFFICE_URL      (opcional) si algún día quieres que el
                         mismo JSON se mande por POST a tu back
                         office, pones la URL aquí y ya está
     BACKOFFICE_TOKEN    (opcional) se envía como Authorization

   Y EN EL PANEL DE STRIPE
     Developers > Webhooks > Add endpoint
       URL:     https://TU-DOMINIO/api/webhook
       Eventos: checkout.session.completed
                invoice.paid
                invoice.payment_failed
                customer.subscription.deleted

   Para comprobar que está viva, abre en el navegador:
     https://TU-DOMINIO/api/webhook
   ============================================================= */

const crypto = require('crypto');

/* Los nombres de los módulos, para que el fichero se entienda sin
   tener que mirar el código. Deben coincidir con checkout.js.     */
const NOMBRES = {
  form: 'Formación',
  mkt:  'Marketing',
  val:  'Valorador',
  inv:  'Inversión',
  pro:  'Prospección',
  rec:  'Recomendación',
  cop:  'Copiloto',
  exp:  'Expedientes y Portales'
};

/* Los paquetes de la web, para que el fichero hable como la web. */
const PAQUETES = {
  form: 'Formación por IA',
  cap:  'Captación por IA',
  ope:  'Gestión de operaciones por IA'
};

const EU = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE',
            'IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];

/* ---------------------------------------------------------------
   Hablar con Stripe (sin librería, form-urlencoded)
   --------------------------------------------------------------- */
async function stripeGet(ruta, clave) {
  const r = await fetch('https://api.stripe.com/v1/' + ruta, {
    headers: { Authorization: 'Bearer ' + clave }
  });
  const d = await r.json();
  if (!r.ok) throw new Error((d && d.error && d.error.message) || 'Error de Stripe');
  return d;
}

/* ---------------------------------------------------------------
   Utilidades
   --------------------------------------------------------------- */
const cent = c => (typeof c === 'number' ? Math.round(c) / 100 : null);
const iso  = s => (s ? new Date(s * 1000).toISOString() : null);
const dia  = s => (s ? new Date(s * 1000).toISOString().slice(0, 10) : null);

function eur(n) {
  if (n === null || n === undefined) return null;
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

/* Token de activación: va firmado, así que el back office puede
   comprobar que es nuestro sin consultarnos nada.                */
function tokenActivacion(idSuscripcion) {
  const secreto = process.env.ACTIVACION_SECRET || 'inmoprop-sin-secreto-configurado';
  const firma = crypto.createHmac('sha256', secreto).update(idSuscripcion).digest('hex').slice(0, 32);
  return Buffer.from(idSuscripcion + '.' + firma).toString('base64url');
}

/* Cómo hay que facturarle el IVA a este cliente. Esto es lo que
   de verdad quiere ver la gestoría.                              */
function regimenFiscal(pais, exencion, tieneNif) {
  if (!pais) return { codigo: 'desconocido', texto: 'Sin dirección todavía' };
  if (pais === 'ES') return { codigo: 'nacional', texto: 'España · IVA 21 % repercutido' };
  if (EU.indexOf(pais) !== -1) {
    if (exencion === 'reverse' || tieneNif) {
      return {
        codigo: 'inversion_sujeto_pasivo',
        texto: 'Empresa de la UE con NIF-IVA intracomunitario · inversión del sujeto ' +
               'pasivo, sin IVA (art. 196 Directiva 2006/112/CE). Va al modelo 349.'
      };
    }
    return {
      codigo: 'b2c_ue',
      texto: 'Particular o empresa sin NIF-IVA de la UE · se repercute el IVA de su ' +
             'país por el régimen de ventanilla única (OSS).'
    };
  }
  return { codigo: 'fuera_ue', texto: 'Fuera de la UE · operación no sujeta a IVA español' };
}

/* Qué licencias se han vendido, leído de los metadatos que puso
   /api/checkout al crear la sesión.                              */
function licencias(meta) {
  const plan = meta.plan || 'desconocido';
  const claves = String(meta.modulos || 'form').split(',').filter(Boolean);
  const agentes = parseInt(meta.agentes, 10) || 1;
  const paqs = String(meta.paquetes || 'form').split(',').filter(Boolean);

  const l = {
    plan,
    plan_texto: plan === 'multi' ? 'Licencia Multi (oficina virtual)'
              : plan === 'gerente' ? 'Licencia Gerente' : 'Licencia Agente',
    periodo: meta.periodo || 'mes',
    gerente: plan === 'agente' ? 0 : 1,
    agente: plan === 'multi' ? agentes : 0,
    modulos: claves,
    modulos_texto: claves.map(k => NOMBRES[k] || k),
    paquetes: paqs,
    paquetes_texto: paqs.map(k => PAQUETES[k] || k),
    suite_completa: claves.length === Object.keys(NOMBRES).length
  };
  l.total_usuarios = l.gerente + l.agente || 1;
  l.asignable_por_el_cliente = plan === 'multi';
  return l;
}

/* ---------------------------------------------------------------
   El fichero: todo lo que el back office necesita saber
   --------------------------------------------------------------- */
function ficha(tipo, evento, ses, sub, fac) {
  const meta = (sub && sub.metadata) || (ses && ses.metadata) || {};
  const cd = (ses && ses.customer_details) || {};
  const dir = cd.address || (fac && fac.customer_address) || {};
  const nifs = cd.tax_ids || (fac && fac.customer_tax_ids) || [];
  const nif = nifs.find(t => t && t.value) || null;
  const pais = dir.country || null;
  const lic = licencias(meta);

  /* impuestos: en la sesión aún no están (la prueba es a 0 €);
     los definitivos llegan con la primera factura de verdad.   */
  let impuestos;
  if (fac) {
    const tramos = (fac.total_taxes || fac.total_tax_amounts || []).map(t => ({
      importe: cent(t.amount),
      tipo_pct: t.tax_rate_details ? t.tax_rate_details.percentage_decimal
              : (t.tax_rate && t.tax_rate.percentage) || null,
      motivo: t.taxability_reason || null
    }));
    impuestos = {
      estado: 'calculado',
      importe_total: cent(fac.tax != null ? fac.tax : (fac.total_tax || 0)),
      tramos
    };
  } else {
    impuestos = {
      estado: 'pendiente',
      nota: 'Durante los días de prueba el importe a cobrar es 0 €, así que ' +
            'Stripe todavía no ha calculado el IVA. El definitivo viaja en el ' +
            'fichero de tipo "cobro_confirmado" del primer recibo.',
      importe_total: cent((ses && ses.total_details && ses.total_details.amount_tax) || 0),
      tramos: []
    };
  }

  const reg = regimenFiscal(pais, cd.tax_exempt, !!nif);

  /* las líneas de lo comprado, con sus importes sin IVA */
  const fuente = (fac && fac.lines && fac.lines.data) ||
                 (ses && ses.line_items && ses.line_items.data) || [];
  const lineas = fuente.map(li => {
    const cantidad = li.quantity || 1;
    /* el precio unitario recurrente: lo que se paga cada periodo */
    const unit = (li.price && li.price.unit_amount != null) ? li.price.unit_amount
      : (li.pricing && li.pricing.unit_amount_decimal != null) ? Number(li.pricing.unit_amount_decimal)
      : (li.amount_excluding_tax != null ? li.amount_excluding_tax / cantidad : null);
    /* lo facturado en ESTE mensaje (en una factura real) o, si estamos en la
       sesión de compra con prueba gratis, el importe recurrente que vendrá */
    const facturado = li.amount_excluding_tax != null ? li.amount_excluding_tax
      : li.amount_subtotal != null ? li.amount_subtotal : li.amount;
    const recurrente = unit != null ? unit * cantidad : facturado;
    return {
      concepto: li.description || (li.price && li.price.nickname) || '—',
      cantidad,
      unitario_sin_iva: cent(unit),
      total_sin_iva: cent(fac ? facturado : recurrente)
    };
  });
  const sumaLineas = lineas.reduce((t, l) => t + (l.total_sin_iva || 0), 0);

  const idSub = (sub && sub.id) || (ses && ses.subscription) || null;

  /* mientras no haya endpoint del back office, esto es un apaño */
  const porEmail = !process.env.BACKOFFICE_URL;

  return {
    version: '1.0',
    tipo,                                  // reserva_licencias | cobro_confirmado | cobro_fallido | baja
    generado: new Date().toISOString(),
    entorno: evento.livemode ? 'real' : 'pruebas',

    provisional: porEmail,
    nota_interna: porEmail
      ? 'PROVISIONAL. Este fichero viaja por email porque el back office ' +
        'todavía no tiene un punto de entrada. En cuanto se rellene la variable ' +
        'BACKOFFICE_URL, el mismo JSON llegará por HTTPS y el alta de licencias ' +
        'dejará de depender de que alguien lea un correo. No dar de alta nada a ' +
        'mano sin apuntar el id de evento, que es lo que evita duplicados.'
      : 'Entrega automática al back office por HTTPS.',

    /* el back office debe descartar un evento que ya haya procesado */
    idempotencia: {
      evento: evento.id,
      sesion: (ses && ses.id) || null,
      suscripcion: idSub,
      factura: (fac && fac.id) || null
    },

    comprador: {
      nombre: cd.name || (fac && fac.customer_name) || null,
      email: cd.email || (fac && fac.customer_email) || null,
      telefono: cd.phone || (fac && fac.customer_phone) || null,
      nif: nif ? { tipo: nif.type, valor: nif.value } : null,
      direccion: {
        linea1: dir.line1 || null,
        linea2: dir.line2 || null,
        cp: dir.postal_code || null,
        ciudad: dir.city || null,
        provincia: dir.state || null,
        pais: pais
      },
      id_cliente_stripe: (ses && ses.customer) || (fac && fac.customer) || null
    },

    licencias: lic,

    compra: {
      moneda: ((ses && ses.currency) || (fac && fac.currency) || 'eur').toUpperCase(),
      facturacion: lic.periodo === 'anual' ? 'anual (12 meses de una vez)' : 'mensual',
      lineas,
      /* en la reserva es el importe recurrente que se cobrará cada periodo;
         en un cobro, lo que se ha facturado en ese recibo */
      subtotal_sin_iva: fac
        ? cent(fac.subtotal_excluding_tax != null ? fac.subtotal_excluding_tax : fac.subtotal)
        : Math.round(sumaLineas * 100) / 100,
      impuestos,
      regimen_fiscal: reg,
      total: fac ? cent(fac.total) : Math.round(sumaLineas * 100) / 100,
      /* lo que se ha cargado hoy en la tarjeta: 0 durante la prueba */
      cobrado_hoy: cent(fac ? (fac.amount_paid != null ? fac.amount_paid : fac.total)
                            : (ses && ses.amount_total) || 0),
      descuento: cent(
        (fac && fac.total_discount_amounts && fac.total_discount_amounts[0] &&
         fac.total_discount_amounts[0].amount) ||
        (ses && ses.total_details && ses.total_details.amount_discount) || 0
      )
    },

    suscripcion: sub ? {
      estado: sub.status,
      prueba_hasta: dia(sub.trial_end),
      primer_cobro: dia(sub.trial_end || sub.current_period_end),
      periodo_actual: { desde: dia(sub.current_period_start), hasta: dia(sub.current_period_end) },
      cancela_al_final: !!sub.cancel_at_period_end,
      id: sub.id
    } : null,

    /* Lo que el cliente tiene que hacer ahora: una reserva de
       licencias que él activa y, en la Multi, reparte.          */
    activacion: idSub ? {
      token: tokenActivacion(idSub),
      url: (process.env.URL_ACTIVACION || 'https://inmoprop-web.vercel.app/activar') +
           '?t=' + tokenActivacion(idSub),
      instrucciones: lic.asignable_por_el_cliente
        ? 'El gerente entra con este enlace, se queda la licencia de Gerente y asigna ' +
          'las ' + lic.agente + ' de Agente a las personas de su oficina.'
        : 'El titular entra con este enlace y su licencia queda activada a su nombre.'
    } : null,

    /* De dónde venía el comprador. Lo captura /api/checkout en el
       momento de abrir la pasarela y lo guarda en los metadatos. */
    procedencia: {
      ip: meta.ip || null,
      pais_ip: meta.pais_ip || null,
      navegador: meta.navegador || null,
      pagina: meta.pagina || null,
      referente: meta.referente || null,
      campana: meta.campana || null,
      idioma: meta.idioma || null,
      abierto: meta.abierto || null
    }
  };
}

/* ---------------------------------------------------------------
   El email con el fichero adjunto
   --------------------------------------------------------------- */
const TITULOS = {
  reserva_licencias: 'Nueva compra · reserva de licencias',
  cobro_confirmado: 'Primer cobro confirmado',
  cobro_fallido: 'AVISO · cobro fallido',
  baja: 'Baja de suscripción'
};

function resumenHtml(f) {
  const fila = (k, v) => v == null || v === '' ? '' :
    '<tr><td style="padding:6px 14px 6px 0;color:#666;white-space:nowrap">' + k +
    '</td><td style="padding:6px 0;font-weight:600">' + String(v) + '</td></tr>';

  const lineas = f.compra.lineas.map(l =>
    '<tr><td style="padding:4px 14px 4px 0">' + l.concepto + '</td>' +
    '<td style="padding:4px 14px 4px 0;text-align:right">' + l.cantidad + '</td>' +
    '<td style="padding:4px 0;text-align:right">' + eur(l.total_sin_iva) + '</td></tr>').join('');

  const aviso = f.provisional ? `<p style="margin:0 0 16px;padding:10px 14px;
    background:#fff4e5;border-left:3px solid #f5a623;border-radius:6px;font-size:12px;color:#7a5200">
    <b>Envío provisional, solo para las pruebas.</b> Este correo existe porque el back office
    todavía no tiene un punto de entrada propio. Sirve para ver la venta, no para dar de alta
    licencias a mano: cuando se conecte el back office el alta será automática y este aviso
    desaparecerá.</p>` : '';

  return `<div style="font:14px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#1d1f33;max-width:640px">
  <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6c5ce7">
    Inmoprop · ${f.entorno === 'pruebas' ? 'ENTORNO DE PRUEBAS' : 'venta real'}</p>
  ${aviso}
  <h2 style="margin:0 0 18px;font-size:20px">${TITULOS[f.tipo] || f.tipo}</h2>

  <table style="border-collapse:collapse;margin-bottom:20px">
    ${fila('Empresa / nombre', f.comprador.nombre)}
    ${fila('Email', f.comprador.email)}
    ${fila('Teléfono', f.comprador.telefono)}
    ${fila('NIF', f.comprador.nif ? f.comprador.nif.valor + ' (' + f.comprador.nif.tipo + ')' : null)}
    ${fila('Dirección', [f.comprador.direccion.linea1, f.comprador.direccion.cp,
                          f.comprador.direccion.ciudad, f.comprador.direccion.pais]
                          .filter(Boolean).join(', '))}
  </table>

  <table style="border-collapse:collapse;margin-bottom:20px">
    ${fila('Producto', f.licencias.plan_texto)}
    ${fila('Facturación', f.compra.facturacion)}
    ${fila('Licencias', f.licencias.gerente + ' de Gerente + ' + f.licencias.agente +
                        ' de Agente · ' + f.licencias.total_usuarios + ' usuarios')}
    ${fila('Paquetes', f.licencias.paquetes_texto.join(' · ') +
                       (f.licencias.suite_completa ? ' — SUITE COMPLETA' : ''))}
    ${fila('Módulos', f.licencias.modulos_texto.join(' · '))}
    ${fila('Estado', f.suscripcion ? f.suscripcion.estado : null)}
    ${fila('Prueba hasta', f.suscripcion ? f.suscripcion.prueba_hasta : null)}
    ${fila('Primer cobro', f.suscripcion ? f.suscripcion.primer_cobro : null)}
  </table>

  <table style="border-collapse:collapse;width:100%;margin-bottom:8px;font-size:13px">
    <tr style="color:#666"><td style="padding-bottom:4px">Concepto</td>
      <td style="text-align:right;padding-bottom:4px">Cant.</td>
      <td style="text-align:right;padding-bottom:4px">Sin IVA</td></tr>
    ${lineas}
    <tr><td colspan="3" style="border-top:1px solid #ddd;padding-top:8px"></td></tr>
    <tr><td colspan="2" style="padding:2px 0">Subtotal sin IVA</td>
      <td style="text-align:right;font-weight:600">${eur(f.compra.subtotal_sin_iva)}</td></tr>
    <tr><td colspan="2" style="padding:2px 0">IVA (${f.compra.impuestos.estado})</td>
      <td style="text-align:right;font-weight:600">${eur(f.compra.impuestos.importe_total)}</td></tr>
    <tr><td colspan="2" style="padding:2px 0">${f.tipo === 'reserva_licencias' ? 'Recurrente por periodo (sin IVA)' : 'Total del recibo'}</td>
      <td style="text-align:right;font-weight:600">${eur(f.compra.total)}</td></tr>
    <tr><td colspan="2" style="padding:2px 0;font-size:15px"><b>Cobrado hoy</b></td>
      <td style="text-align:right;font-size:15px"><b>${eur(f.compra.cobrado_hoy)}</b></td></tr>
  </table>

  <p style="margin:14px 0 20px;padding:10px 14px;background:#f2f0ff;border-left:3px solid #6c5ce7;
            border-radius:6px;font-size:13px"><b>Régimen fiscal:</b> ${f.compra.regimen_fiscal.texto}
  ${f.compra.impuestos.estado === 'pendiente'
    ? '<br><span style="color:#666">' + f.compra.impuestos.nota + '</span>' : ''}</p>

  ${f.activacion ? `<p style="margin:0 0 20px;font-size:13px">
    <b>Activación:</b> ${f.activacion.instrucciones}<br>
    <a href="${f.activacion.url}" style="color:#6c5ce7">${f.activacion.url}</a></p>` : ''}

  <p style="margin:0;font-size:12px;color:#999">
    Evento ${f.idempotencia.evento} · suscripción ${f.idempotencia.suscripcion || '—'}<br>
    Procedencia: ${[f.procedencia.pais_ip, f.procedencia.ip, f.procedencia.referente,
                    f.procedencia.campana].filter(Boolean).join(' · ') || 'sin datos'}<br>
    El detalle completo va en el JSON adjunto. Es el fichero que hay que cargar en el back office.</p>
</div>`;
}

async function enviarEmail(f) {
  const clave = process.env.RESEND_API_KEY;
  const para = process.env.AVISOS_PARA || 'vicente.beltran@realmark.es';
  const desde = process.env.AVISOS_DESDE || 'Inmoprop <onboarding@resend.dev>';

  const nombre = 'inmoprop-' + f.tipo + '-' +
    (f.idempotencia.suscripcion || f.idempotencia.evento) + '.json';
  const json = JSON.stringify(f, null, 2);

  if (!clave) {
    console.log('[webhook] Sin RESEND_API_KEY: el fichero no se ha enviado por email. ' +
                'Queda aquí en el registro, que no se pierde nada:');
    console.log(json);
    return { enviado: false, motivo: 'falta RESEND_API_KEY' };
  }

  const asunto = '[Inmoprop' + (f.entorno === 'pruebas' ? ' · PRUEBAS' : '') +
    (f.provisional ? ' · PROVISIONAL' : '') + '] ' +
    (TITULOS[f.tipo] || f.tipo) + ' · ' +
    (f.comprador.nombre || f.comprador.email || 'sin nombre') + ' · ' +
    f.licencias.plan_texto;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + clave, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: desde,
      to: para.split(',').map(s => s.trim()),
      subject: asunto,
      html: resumenHtml(f),
      attachments: [{ filename: nombre, content: Buffer.from(json).toString('base64') }]
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('[webhook] Resend ha fallado:', d);
    console.log(json);                      // que no se pierda
    return { enviado: false, motivo: (d && d.message) || 'error de Resend' };
  }
  return { enviado: true, id: d.id };
}

/* Si algún día el back office expone una URL, el mismo JSON viaja
   solo. Es cambiar una variable de entorno, sin tocar código.    */
async function enviarBackOffice(f) {
  const url = process.env.BACKOFFICE_URL;
  if (!url) return { enviado: false, motivo: 'BACKOFFICE_URL sin configurar' };
  const cab = { 'Content-Type': 'application/json' };
  if (process.env.BACKOFFICE_TOKEN) cab.Authorization = 'Bearer ' + process.env.BACKOFFICE_TOKEN;
  try {
    const r = await fetch(url, { method: 'POST', headers: cab, body: JSON.stringify(f) });
    return { enviado: r.ok, estado: r.status };
  } catch (e) {
    return { enviado: false, motivo: e.message };
  }
}

/* ---------------------------------------------------------------
   Comprobación de firma (si podemos leer el cuerpo en crudo).
   Da igual si no se puede: la verificación de verdad es volver a
   preguntarle el evento a Stripe con nuestra clave secreta.
   --------------------------------------------------------------- */
async function leerCrudo(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  /* si Vercel no ha tocado el cuerpo, todavía podemos leerlo del stream */
  if (req.readable !== false && typeof req[Symbol.asyncIterator] === 'function') {
    try {
      const trozos = [];
      for await (const t of req) trozos.push(Buffer.from(t));
      const txt = Buffer.concat(trozos).toString('utf8');
      return txt || null;
    } catch (_) { return null; }
  }
  return null;
}

function firmaValida(crudo, cabecera) {
  const secreto = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secreto || !crudo || !cabecera) return null;      // no se puede comprobar
  const partes = {};
  String(cabecera).split(',').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) partes[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  if (!partes.t || !partes.v1) return false;
  const esperada = crypto.createHmac('sha256', secreto)
    .update(partes.t + '.' + crudo).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(partes.v1));
  } catch (_) { return false; }
}

/* ---------------------------------------------------------------
   El handler
   --------------------------------------------------------------- */
async function handler(req, res) {
  const clave = process.env.STRIPE_SECRET_KEY;

  /* --- comprobación rápida desde el navegador --- */
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      servicio: 'webhook de Inmoprop',
      modo: !clave ? 'sin clave de Stripe' : clave.startsWith('sk_live') ? 'real' : 'test',
      configurado: {
        stripe: !!clave,
        email: !!process.env.RESEND_API_KEY,
        avisos_para: process.env.AVISOS_PARA || 'vicente.beltran@realmark.es',
        firma: !!process.env.STRIPE_WEBHOOK_SECRET,
        back_office: !!process.env.BACKOFFICE_URL,
        secreto_activacion: !!process.env.ACTIVACION_SECRET
      },
      eventos: ['checkout.session.completed', 'invoice.paid',
                'invoice.payment_failed', 'customer.subscription.deleted'],
      entrega: process.env.BACKOFFICE_URL
        ? 'definitiva · POST al back office'
        : 'PROVISIONAL · por email, hasta que se configure BACKOFFICE_URL'
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Método no permitido' });
  }
  if (!clave) return res.status(500).json({ error: 'Falta STRIPE_SECRET_KEY' });

  try {
    /* --- lo que llega, de lo que NO nos creemos nada --- */
    const crudo = await leerCrudo(req);
    let cuerpo = {};
    if (crudo) {
      try { cuerpo = JSON.parse(crudo); } catch (_) { cuerpo = {}; }
    } else if (req.body && typeof req.body === 'object') {
      cuerpo = req.body;
    }

    const firma = firmaValida(crudo, req.headers['stripe-signature']);
    if (firma === false) return res.status(400).json({ error: 'Firma no válida' });

    const idEvento = String(cuerpo.id || '');
    if (!/^evt_/.test(idEvento)) return res.status(400).json({ error: 'Evento no reconocido' });

    /* LA VERIFICACIÓN DE VERDAD: se lo volvemos a preguntar a Stripe.
       Nadie puede inventarse un id de evento que Stripe confirme.   */
    const evento = await stripeGet('events/' + idEvento, clave);
    const obj = (evento.data && evento.data.object) || {};

    let tipo = null, ses = null, sub = null, fac = null;

    if (evento.type === 'checkout.session.completed') {
      tipo = 'reserva_licencias';
      ses = await stripeGet('checkout/sessions/' + obj.id +
        '?expand[]=line_items&expand[]=total_details.breakdown', clave);
      if (ses.subscription) sub = await stripeGet('subscriptions/' + ses.subscription, clave);

    } else if (evento.type === 'invoice.paid' || evento.type === 'invoice.payment_failed') {
      tipo = evento.type === 'invoice.paid' ? 'cobro_confirmado' : 'cobro_fallido';
      fac = await stripeGet('invoices/' + obj.id + '?expand[]=lines', clave);
      /* Al arrancar una prueba gratis Stripe emite una factura de 0 € y la marca
         pagada. No es un cobro: la reserva ya se creó con la sesión, y el IVA
         real llega con el primer recibo del día 8. Se acepta y se ignora. */
      if (evento.type === 'invoice.paid' && !(fac.amount_paid > 0) && !(fac.total > 0)) {
        console.log('[webhook] factura de 0 € (arranque de prueba) ignorada:', fac.id);
        return res.status(200).json({ recibido: true, ignorado: 'factura de 0 € al iniciar la prueba', factura: fac.id });
      }
      const idSub = fac.subscription || (fac.parent && fac.parent.subscription_details &&
                                         fac.parent.subscription_details.subscription);
      if (idSub) sub = await stripeGet('subscriptions/' + idSub, clave);

    } else if (evento.type === 'customer.subscription.deleted') {
      tipo = 'baja';
      sub = obj;

    } else {
      /* cualquier otro evento se acepta y se ignora, que Stripe no
         reintente eternamente algo que no nos interesa */
      return res.status(200).json({ recibido: true, ignorado: evento.type });
    }

    const f = ficha(tipo, evento, ses, sub, fac);

    const email = await enviarEmail(f);
    const back = await enviarBackOffice(f);

    console.log('[webhook]', f.provisional ? '(PROVISIONAL)' : '',
                tipo, f.idempotencia.suscripcion || f.idempotencia.evento,
                '· email:', email.enviado ? 'enviado' : email.motivo,
                '· back office:', back.enviado ? 'enviado' : back.motivo);

    return res.status(200).json({ recibido: true, tipo, email, back_office: back });

  } catch (e) {
    /* Devolvemos 500 a propósito: Stripe lo reintentará y no
       perderemos la venta por un fallo puntual del email.        */
    console.error('[webhook] ERROR', e && e.message);
    return res.status(500).json({ error: (e && e.message) || 'Error procesando el evento' });
  }
}

module.exports = handler;
module.exports.default = handler;

/* Vercel, dame el cuerpo tal cual llegó: lo necesito para comprobar la
   firma de Stripe. Si tu versión de Vercel lo ignora y entrega el cuerpo
   ya convertido a objeto, no pasa nada: la verificación buena es volver
   a preguntarle el evento a Stripe, y eso se hace siempre. */
module.exports.config = { api: { bodyParser: false } };
