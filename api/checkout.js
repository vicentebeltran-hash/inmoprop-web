/* =============================================================
   INMOPROP · /api/checkout
   -------------------------------------------------------------
   Crea una sesión de pago de Stripe y devuelve la URL a la que
   hay que enviar al cliente.

   NO TIENE DEPENDENCIAS: habla con Stripe por HTTPS directamente,
   así que este fichero funciona en Vercel tal cual, sin instalar
   nada y sin package.json. Está escrito en CommonJS a propósito:
   sin un package.json que diga {"type":"module"}, Vercel lee los
   .js de /api como CommonJS y `export default` haría que la
   función reventara al arrancar (FUNCTION_INVOCATION_FAILED).

   REQUIERE una variable de entorno en Vercel:
     STRIPE_SECRET_KEY = sk_test_...   (modo prueba)
                         sk_live_...   (cuando pasemos a real)

   Para comprobar que está bien configurado, abre en el navegador:
     https://TU-DOMINIO/api/checkout
   Debe responder { "ok": true, "modo": "test" }.
   ============================================================= */

/* ===== PRECIOS · deben coincidir con el bloque CFG de index.html =====
   Ojo: aquí es donde se cobra de verdad. El navegador solo pide un
   plan; los importes se calculan SIEMPRE en el servidor.          */
const CFG = {
  multiBase: 179,      // Multi: 1 gerente + 3 agentes
  agentesIncl: 3,      // agentes incluidos en la Multi
  extraBase: 39,       // precio de la 1.ª licencia de agente adicional
  descuento: 0.05,     // 5 % menos por cada licencia adicional (acumulativo)
  suelo: 29,           // precio mínimo por licencia
  agente: 49,          // licencia de Agente suelta
  gerente: 98,         // licencia de Gerente suelta
  factorAnual: 0.8,    // −20 % con facturación anual
  maxAgentes: 25,      // por encima de esto, se habla con ventas
  pruebaDias: 7        // días de prueba gratis (con tarjeta)
};

/* Si tus precios son SIN IVA y quieres que Stripe lo calcule y lo
   sume aparte, pon esto a true DESPUÉS de activar Stripe Tax en el
   panel (Más > Impuestos). Si tus precios ya llevan el IVA dentro,
   déjalo en false. */
const IVA_AUTOMATICO = false;

/* MANAGED PAYMENTS · Stripe lo activa por defecto en las cuentas
   nuevas. Con él, quien vende de cara al cliente es Stripe: se
   encarga del IVA de cada país y te paga a ti el neto.
     false  ->  vende RK. Tú emites las facturas y liquidas el IVA,
                como haces ahora. (Opción por defecto aquí.)
     true   ->  vende Stripe como intermediario. Cómodo para vender
                fuera de España, pero cambia quién factura y las
                comisiones. Consúltalo con tu gestoría antes.       */
const MANAGED_PAYMENTS = false;

/* Código fiscal del producto. Inmoprop es software en la nube, sin
   descarga, vendido a empresas -> SaaS business use.
   Stripe lo exige con Managed Payments y lo usa Stripe Tax.        */
const CODIGO_FISCAL = 'txcd_10103001';

/* --- precio de cada licencia adicional según cuántas haya --- */
function unitario(n) {
  if (n <= 0) return CFG.extraBase;
  const p = CFG.extraBase * Math.pow(1 - CFG.descuento, n - 1);
  return Math.max(CFG.suelo, Math.round(p * 100) / 100);
}

/* --- convierte euros/mes en lo que se cobra de verdad ---
   Mensual: ese importe cada mes.
   Anual:   se aplica el −20 %, se redondea igual que en la web
            y se cobran 12 mensualidades de una vez al año.
   `entero` = true para los precios de las tarjetas (49 / 98 / 179),
   que en anual se muestran redondeados a euros (39 / 78 / 143).   */
function importe(eurosMes, periodo, entero) {
  if (periodo !== 'anual') return Math.round(eurosMes * 100);
  let mes = eurosMes * CFG.factorAnual;
  mes = entero ? Math.round(mes) : Math.round(mes * 100) / 100;
  return Math.round(mes * 12 * 100); // Stripe trabaja en céntimos
}

/* --- construye las líneas del carrito según el plan --- */
function lineas(plan, periodo, agentes) {
  const intervalo = periodo === 'anual' ? 'year' : 'month';
  const sufijo = periodo === 'anual' ? ' · facturación anual' : '';

  if (plan === 'agente') {
    return [{
      nombre: 'Inmoprop · Licencia Agente' + sufijo,
      desc: 'Formación completa y role play con IA. 1 usuario.',
      importe: importe(CFG.agente, periodo, true),
      cantidad: 1,
      intervalo
    }];
  }

  if (plan === 'gerente') {
    return [{
      nombre: 'Inmoprop · Licencia Gerente' + sufijo,
      desc: 'Todo lo de Agente más la parte de dirección. 1 usuario con los dos roles.',
      importe: importe(CFG.gerente, periodo, true),
      cantidad: 1,
      intervalo
    }];
  }

  // multi
  const extras = Math.max(0, agentes - CFG.agentesIncl);
  const items = [{
    nombre: 'Inmoprop · Licencia Multi' + sufijo,
    desc: '1 licencia de Gerente + 3 de Agente. Oficina virtual incluida.',
    importe: importe(CFG.multiBase, periodo, true),
    cantidad: 1,
    intervalo
  }];

  if (extras > 0) {
    const unit = unitario(extras);
    items.push({
      nombre: 'Inmoprop · Licencia de Agente adicional' + sufijo,
      desc: 'Precio por licencia con ' + extras + ' agentes adicionales en la oficina.',
      importe: importe(unit, periodo, false),
      cantidad: extras,
      intervalo
    });
  }

  return items;
}

/* --- llamada a Stripe (form-urlencoded, sin librería) --- */
async function stripePost(ruta, params, clave) {
  const cuerpo = new URLSearchParams(params).toString();
  const r = await fetch('https://api.stripe.com/v1/' + ruta, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + clave,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: cuerpo
  });
  const datos = await r.json();
  if (!r.ok) {
    const msg = (datos && datos.error && datos.error.message) || 'Error de Stripe';
    throw new Error(msg);
  }
  return datos;
}

async function handler(req, res) {
  const clave = process.env.STRIPE_SECRET_KEY;

  /* --- comprobación rápida desde el navegador --- */
  if (req.method === 'GET') {
    if (!clave) {
      return res.status(500).json({
        ok: false,
        error: 'Falta la variable STRIPE_SECRET_KEY en Vercel.'
      });
    }
    return res.status(200).json({
      ok: true,
      modo: clave.startsWith('sk_live') ? 'real' : 'test'
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Método no permitido' });
  }

  if (!clave) {
    return res.status(500).json({
      error: 'La pasarela de pago todavía no está configurada.'
    });
  }

  try {
    /* --- lo que llega del navegador (y de lo que hay que desconfiar) ---
       Vercel suele entregar el cuerpo ya convertido a objeto, pero
       según el content-type puede llegar como texto o como Buffer. */
    let cuerpo = req.body || {};
    if (Buffer.isBuffer(cuerpo)) cuerpo = cuerpo.toString('utf8');
    if (typeof cuerpo === 'string') {
      try { cuerpo = JSON.parse(cuerpo || '{}'); } catch (_) { cuerpo = {}; }
    }

    const plan = String(cuerpo.plan || '').toLowerCase();
    const periodo = cuerpo.periodo === 'anual' ? 'anual' : 'mes';
    let agentes = parseInt(cuerpo.agentes, 10);
    if (!Number.isFinite(agentes)) agentes = CFG.agentesIncl;
    agentes = Math.min(CFG.maxAgentes, Math.max(CFG.agentesIncl, agentes));

    if (['agente', 'gerente', 'multi'].indexOf(plan) === -1) {
      return res.status(400).json({ error: 'Plan no reconocido.' });
    }

    /* --- de dónde viene la petición, para las URL de vuelta --- */
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origen = proto + '://' + host;

    /* --- montamos los parámetros de la sesión --- */
    const p = {
      mode: 'subscription',
      locale: 'es',
      success_url: origen + '/gracias?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: origen + '/#precios',
      allow_promotion_codes: 'true',
      billing_address_collection: 'required',
      'tax_id_collection[enabled]': 'true',
      'subscription_data[trial_period_days]': String(CFG.pruebaDias),
      'subscription_data[metadata][plan]': plan,
      'subscription_data[metadata][periodo]': periodo,
      'subscription_data[metadata][agentes]': String(plan === 'multi' ? agentes : 1)
    };

    if (IVA_AUTOMATICO) p['automatic_tax[enabled]'] = 'true';
    if (!MANAGED_PAYMENTS) p['managed_payments[enabled]'] = 'false';

    lineas(plan, periodo, agentes).forEach(function (item, i) {
      const k = 'line_items[' + i + ']';
      p[k + '[quantity]'] = String(item.cantidad);
      p[k + '[price_data][currency]'] = 'eur';
      p[k + '[price_data][unit_amount]'] = String(item.importe);
      p[k + '[price_data][recurring][interval]'] = item.intervalo;
      p[k + '[price_data][product_data][name]'] = item.nombre;
      p[k + '[price_data][product_data][description]'] = item.desc;
      p[k + '[price_data][product_data][tax_code]'] = CODIGO_FISCAL;
      if (IVA_AUTOMATICO) {
        // 'exclusive' = el IVA se suma al precio; 'inclusive' = ya va dentro
        p[k + '[price_data][tax_behavior]'] = 'exclusive';
      }
    });

    const sesion = await stripePost('checkout/sessions', p, clave);
    return res.status(200).json({ url: sesion.url });

  } catch (e) {
    console.error('checkout:', e);
    return res.status(500).json({ error: e.message || 'No se pudo abrir el pago.' });
  }
}

/* Vercel lee los ficheros .js de /api como CommonJS, así que la
   función se exporta de esta manera (nada de `export default`). */
module.exports = handler;
module.exports.default = handler;
