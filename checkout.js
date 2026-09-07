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
  agente: 49,          // licencia de Agente (solo formación)
  extraGerente: 49,    // lo que suma el rol de gerente
  multiBase: 179,      // pack Multi: 1 gerente + 3 agentes, solo formación
  agentesIncl: 3,      // agentes incluidos en el pack
  extraBase: 39,       // 1.ª licencia de agente adicional (parte de formación)
  descuento: 0.03,     // cada licencia adicional abarata un 3 % a TODAS
  suelo: 29,           // suelo de la licencia adicional de formación
  sueloPersona: 86,    // suelo por persona con la suite completa
  personasTope: 26,    // 25 agentes + el gerente: donde se toca el suelo
  factorAnual: 0.8,    // −20 % con facturación anual
  maxAgentes: 25,      // por encima de esto, se habla con ventas
  pruebaDias: 7        // días de prueba gratis (con tarjeta)
};
CFG.gerente = CFG.agente + CFG.extraGerente;   // 98

/* IVA · los precios de la web son SIN IVA, así que Stripe lo calcula
   y lo suma aparte según el país del cliente y su NIF-IVA.
   Requiere tener Stripe Tax dado de alta en el panel (Más > Impuestos:
   dirección de origen + registro fiscal en España).
   Si aún no lo está, la función lo detecta y cobra sin impuestos en
   lugar de dejar de vender — mira `intentaConImpuestos` más abajo.   */
const IVA_AUTOMATICO = true;

/* Cómo hay que entender los importes de arriba:
     'exclusive' -> son netos, el IVA se suma encima. (Es tu caso.)
     'inclusive' -> ya llevan el IVA dentro.                          */
const COMPORTAMIENTO_IVA = 'exclusive';

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

/* ===== CATÁLOGO DE MÓDULOS =====================================
   Estos precios y estas fórmulas tienen que ser IDÉNTICOS a los del
   bloque MODULOS de index.html. Si cambias uno, cambia los dos.
   El navegador manda solo las claves elegidas; el importe se calcula
   siempre aquí.                                                     */
const MODULOS = {
  form: { n: 'Formación',     p: 49, base: true },
  mkt:  { n: 'Marketing',     p: 19 },
  val:  { n: 'Valoración',    p: 19 },
  inv:  { n: 'Inversión',     p: 19 },
  pro:  { n: 'Prospección',   p: 19 },
  rec:  { n: 'Recomendación', p: 19 },
  cop:  { n: 'Copiloto',      p: 19 },
  exp:  { n: 'Expedientes',   p: 35 }   // Portales va dentro
};
/* suma de todo menos la formación: 149 -> techo del agente 198 */
const SUMA_MODS = Object.keys(MODULOS)
  .reduce((t, k) => (MODULOS[k].base ? t : t + MODULOS[k].p), 0);

/* limpia lo que llega del navegador y devuelve claves válidas */
function modulosValidos(lista) {
  if (!Array.isArray(lista)) return [];
  const vistos = {};
  return lista
    .map(function (k) { return String(k || '').toLowerCase(); })
    .filter(function (k) {
      if (!MODULOS[k] || MODULOS[k].base || vistos[k]) return false;
      vistos[k] = 1;
      return true;
    });
}
function sumaMods(claves) {
  return claves.reduce(function (t, k) { return t + MODULOS[k].p; }, 0);
}

/* --- precios por persona, sin tope: el precio ES la suma --- */
function pAgente(x)  { return CFG.agente  + x; }
function pGerente(x) { return CFG.gerente + x; }

/* --- la parte de formación de una oficina ---
   Todas las licencias adicionales van al precio de la última, así cada
   agente que se suma abarata de verdad a los anteriores.            */
function licenciaExtra(k) {
  if (k <= 0) return CFG.extraBase;
  return Math.max(CFG.suelo,
    Math.round(CFG.extraBase * Math.pow(1 - CFG.descuento, k - 1) * 100) / 100);
}
function basesOficina(agentes) {
  const extras = Math.max(0, agentes - CFG.agentesIncl);
  return CFG.multiBase + extras * licenciaExtra(extras);
}

/* --- descuento de los módulos según el tamaño de la oficina ---
   Curva saturante, derivada del suelo por persona de CFG. Una curva
   recta acabaría haciendo que sumar un agente ABARATASE la factura
   total; esta no. Cambia el suelo y la curva se recalcula sola.    */
const DM_MIN = 0.15;
const DM_TOPE = 1 - (CFG.personasTope * CFG.sueloPersona -
  basesOficina(CFG.personasTope - 1)) / (CFG.personasTope * SUMA_MODS);
const DM_D = DM_TOPE + 0.045;
const DM_R = Math.exp(Math.log(0.045 / (DM_D - DM_MIN)) / (CFG.personasTope - 4));
function dm(personas) {
  const p = Math.min(Math.max(personas, 4), CFG.personasTope);
  return DM_D - (DM_D - DM_MIN) * Math.pow(DM_R, p - 4);
}
function oficina(agentes, x) {
  const personas = agentes + 1;
  return basesOficina(agentes) + personas * x * (1 - dm(personas));
}
function pMulti(x) { return Math.round(oficina(CFG.agentesIncl, x)); }

/* texto legible de los módulos elegidos, para la descripción de la línea */
function textoMods(claves) {
  if (!claves.length) return 'Solo el módulo de Formación.';
  const nombres = claves.map(function (k) { return MODULOS[k].n; });
  const todos = claves.length === Object.keys(MODULOS).length - 1;
  return (todos ? 'Suite completa: Formación, ' : 'Módulos: Formación, ') +
         nombres.join(', ') + '.';
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
function lineas(plan, periodo, agentes, mods) {
  const intervalo = periodo === 'anual' ? 'year' : 'month';
  const sufijo = periodo === 'anual' ? ' · facturación anual' : '';
  const claves = mods || [];
  const x = sumaMods(claves);
  const detalle = textoMods(claves);

  if (plan === 'agente') {
    return [{
      nombre: 'Inmoprop · Licencia Agente' + sufijo,
      desc: detalle + ' 1 usuario.',
      importe: importe(pAgente(x), periodo, true),
      cantidad: 1,
      intervalo
    }];
  }

  if (plan === 'gerente') {
    return [{
      nombre: 'Inmoprop · Licencia Gerente' + sufijo,
      desc: detalle + ' 1 usuario con los dos roles.',
      importe: importe(pGerente(x), periodo, true),
      cantidad: 1,
      intervalo
    }];
  }

  /* ---- multi ----
     Tres conceptos, igual que el desglose que ve el cliente en la web:
       1) el pack de formación (gerente + 3 agentes)
       2) las licencias de agente adicionales, todas al precio de la última
       3) los módulos, por persona, con el descuento de tamaño        */
  const personas = agentes + 1;
  const extras = Math.max(0, agentes - CFG.agentesIncl);
  const items = [{
    nombre: 'Inmoprop · Licencia Multi' + sufijo,
    desc: '1 licencia de Gerente + 3 de Agente, oficina virtual incluida.',
    importe: importe(CFG.multiBase, periodo, true),
    cantidad: 1,
    intervalo
  }];

  if (extras > 0) {
    items.push({
      nombre: 'Inmoprop · Licencia de Agente adicional' + sufijo,
      desc: 'Precio por licencia con ' + extras + ' agentes adicionales en la oficina.',
      importe: importe(licenciaExtra(extras), periodo, false),
      cantidad: extras,
      intervalo
    });
  }

  if (x > 0) {
    const desc = dm(personas);
    items.push({
      nombre: 'Inmoprop · Módulos de la suite' + sufijo,
      desc: detalle + ' Precio por persona con el descuento de ' + personas +
            ' personas (−' + Math.round(desc * 100) + ' %).',
      importe: importe(x * (1 - desc), periodo, false),
      cantidad: personas,
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

/* --- lectura de datos en Stripe --- */
async function stripeGet(ruta, clave) {
  const r = await fetch('https://api.stripe.com/v1/' + ruta, {
    headers: { 'Authorization': 'Bearer ' + clave }
  });
  const datos = await r.json();
  if (!r.ok) {
    const msg = (datos && datos.error && datos.error.message) || 'Error de Stripe';
    throw new Error(msg);
  }
  return datos;
}

/* --- diagnóstico del IVA: ¿está Stripe Tax listo para cobrarlo? --- */
async function diagnosticoIva(clave) {
  const d = { stripeTax: 'desconocido', origen: null, registros: [], veredicto: '' };

  try {
    const ajustes = await stripeGet('tax/settings', clave);
    d.stripeTax = ajustes.status === 'active' ? 'activo' : 'pendiente';
    if (ajustes.head_office && ajustes.head_office.address) {
      d.origen = ajustes.head_office.address.country || null;
    }
    if (ajustes.status !== 'active') {
      d.detalle = ajustes.status_details || null;
    }
  } catch (e) {
    d.stripeTax = 'no disponible';
    d.detalle = e.message;
  }

  try {
    const regs = await stripeGet('tax/registrations?status=active&limit=100', clave);
    d.registros = (regs.data || []).map(function (r) { return r.country; });
  } catch (e) {
    d.registros = null;
  }

  const tieneEspana = Array.isArray(d.registros) && d.registros.indexOf('ES') !== -1;

  if (d.stripeTax !== 'activo') {
    d.veredicto = 'Stripe Tax NO está listo. Ve al panel de Stripe > Impuestos y ' +
                  'completa la dirección de origen del negocio. Mientras tanto se ' +
                  'cobra sin IVA.';
  } else if (!tieneEspana) {
    d.veredicto = 'Stripe Tax está activo pero NO hay registro fiscal en España, así ' +
                  'que calcula 0 € de IVA. Añádelo en Impuestos > Registros (país ' +
                  'España) y el 21 % empezará a aplicarse.';
  } else {
    d.veredicto = 'Todo listo: se aplica el 21 % a los clientes españoles. Recuerda que ' +
                  'durante los ' + CFG.pruebaDias + ' días de prueba el importe a pagar ' +
                  'hoy es 0 €, así que en la pantalla de pago el IVA sale 0 €: aparecerá ' +
                  'en la primera factura real.';
  }

  return d;
}

/* ¿El error de Stripe se debe a que Stripe Tax no está configurado? */
function esErrorDeImpuestos(e) {
  const m = String((e && e.message) || '').toLowerCase();
  return m.indexOf('tax') !== -1 || m.indexOf('impuesto') !== -1;
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
    const salida = {
      ok: true,
      modo: clave.startsWith('sk_live') ? 'real' : 'test'
    };
    /* /api/checkout?iva=1 -> además comprueba si el IVA está listo */
    if (req.query && (req.query.iva || req.query.diagnostico)) {
      salida.iva = await diagnosticoIva(clave);
    }
    return res.status(200).json(salida);
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

    const mods = modulosValidos(cuerpo.modulos);

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
      'custom_text[submit][message]':
        'Hoy no se te cobra nada. Empiezan ' + CFG.pruebaDias + ' días de prueba y ' +
        'el primer recibo, con el IVA que corresponda, sale el día ' +
        (CFG.pruebaDias + 1) + '. Puedes cancelar antes sin pagar nada.',
      'subscription_data[metadata][plan]': plan,
      'subscription_data[metadata][periodo]': periodo,
      'subscription_data[metadata][agentes]': String(plan === 'multi' ? agentes : 1),
      'subscription_data[metadata][modulos]': (['form'].concat(mods)).join(','),
      'subscription_data[metadata][personas]': String(plan === 'multi' ? agentes + 1 : 1)
    };

    if (!MANAGED_PAYMENTS) p['managed_payments[enabled]'] = 'false';

    lineas(plan, periodo, agentes, mods).forEach(function (item, i) {
      const k = 'line_items[' + i + ']';
      p[k + '[quantity]'] = String(item.cantidad);
      p[k + '[price_data][currency]'] = 'eur';
      p[k + '[price_data][unit_amount]'] = String(item.importe);
      p[k + '[price_data][recurring][interval]'] = item.intervalo;
      p[k + '[price_data][product_data][name]'] = item.nombre;
      p[k + '[price_data][product_data][description]'] = item.desc;
      p[k + '[price_data][product_data][tax_code]'] = CODIGO_FISCAL;
      p[k + '[price_data][tax_behavior]'] = COMPORTAMIENTO_IVA;
    });

    /* Intentamos cobrar con el IVA calculado por Stripe. Si Stripe Tax
       todavía no está configurado en el panel, Stripe devuelve un error
       de impuestos: en ese caso reintentamos sin impuestos para no dejar
       la web sin poder vender, y lo dejamos anotado en los registros.   */
    let sesion;
    if (IVA_AUTOMATICO) {
      try {
        sesion = await stripePost('checkout/sessions',
          Object.assign({ 'automatic_tax[enabled]': 'true' }, p), clave);
      } catch (e) {
        if (!esErrorDeImpuestos(e)) throw e;
        console.warn('checkout: Stripe Tax no está configurado todavía; ' +
                     'se cobra sin impuestos. Detalle:', e.message);
        sesion = await stripePost('checkout/sessions', p, clave);
      }
    } else {
      sesion = await stripePost('checkout/sessions', p, clave);
    }

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
