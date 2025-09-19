// back.js — versión mínima funcional
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const PORT = process.env.PORT || 3000
const API_SECRET = process.env.API_SECRET
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY


// ---- Parser de fechas robusto (ISO o DD/MM/YYYY)
function parseDateToMs(s) {
  if (!s) return null;
  const t = +new Date(s);
  if (!Number.isNaN(t)) return t; // ya es ISO u otro formato parseable por JS

  // dd/mm/yyyy o d/m/yyyy
  const m = String(s).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1; // 0..11
    const y = parseInt(m[3], 10);
    const dt = new Date(y, mo, d);
    return +dt;
  }
  return null; // no reconocida
}

// Prioriza 'orders' (ventas del día). Si no hay, usa 'quantity'. Si no, 0.
function getSalesQty(row) {
  const raw = row?.orders ?? row?.quantity ?? row?.qty ?? row?.units ?? row?.count ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}


// CORS (habilitamos Authorization)
const corsOpts = {
  origin: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  maxAge: 86400,
}

const app = express()
app.use(cors(corsOpts))
app.options('*', cors(corsOpts))
app.use(morgan('tiny'))

// Supabase (service role para lecturas/joins)
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltan vars de entorno de Supabase')
}
const supabase = createClient(SUPABASE_URL || '', SUPABASE_SERVICE_ROLE_KEY || '')

// Auth simple por API_SECRET
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'] || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token || token !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// --- util fechas (ventana por días, cierre a medianoche)
function windowRange(days) {
  const now = new Date()
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const from = new Date(tomorrow.getTime() - days*24*60*60*1000)
  const fromStr = from.toISOString().slice(0,10)
  const toStr   = tomorrow.toISOString().slice(0,10)
  return { fromStr, toStr, fromMs: +new Date(fromStr), toMs: +new Date(toStr) }
}

// --- health/env
app.get('/health', (_req, res) => res.json({ ok: true }))
app.get('/env-check', (_req, res) => {
  res.json({
    ok: true,
    hasApiSecret: !!API_SECRET,
    hasUrl: !!SUPABASE_URL,
    hasServiceRole: !!SUPABASE_SERVICE_ROLE_KEY,
    port: PORT,
  })
})

// --- stock FULL (devuelve {rows: [...]}, como espera tu front)
app.get('/stock/full', requireAuth, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('full_stock_min')
      .select('*') // dejamos comodín para no romper si faltan columnas
    if (error) throw error
    res.json({ rows: data || [] })
  } catch (err) {
    console.error('Error /stock/full:', err)
    res.status(500).json({ error: String(err?.message || err) })
  }
})




// --- FULL: decisiones de reposición (ventas/visitas últimos N días)
app.get('/full/decisions', requireAuth, async (req, res) => {
  try {
    // Parámetros
    const windowDays = Math.max(1, parseInt(String(req.query.window || '30'), 10));
    const leadDays   = Math.max(1, parseInt(String(req.query.lead_time || '7'), 10));

    const nowMs  = Date.now();
    const toMs   = nowMs;                                  // hoy
    const fromMs = nowMs - windowDays * 24 * 60 * 60 * 1000; // hoy - ventana

    const toStr   = new Date(toMs).toISOString().slice(0,10);
    const fromStr = new Date(fromMs).toISOString().slice(0,10);

    // 1) Stock FULL (base de items que evaluamos)
    const { data: fRows, error: fErr } = await supabase
      .from('full_stock_min')
      .select('*');
    if (fErr) throw fErr;

    // 2) Visitas (sumar dentro de ventana)
    const { data: vRows, error: vErr } = await supabase
      .from('visits_raw').select('item_id,date,visits')
      .select('*');
    if (vErr) throw vErr;

    // 3) Ventas (sumar dentro de ventana; defensivo con cantidad)
   const { data: sRows, error: sErr } = await supabase
  .from('sales_raw').select('item_id,date,orders,quantity')
  .select('item_id,date,orders,quantity,ingested_at');
if (sErr) throw sErr;


   // stockByItem (reemplazá el bloque actual)
const stockByItem = {};
for (const r of fRows || []) {
  const itemId = String(r?.item_id ?? r?.ml_item_id ?? r?.ml_id ?? '').trim();
  if (!itemId) continue;

  const qtyRaw =
    r?.total ??              // ← primero 'total'
    r?.qty ??
    r?.available_quantity ??
    r?.available ??
    r?.stock ??
    r?.available_stock ??
    r?.quantity ?? 0;

  const qty = Number(qtyRaw);
  stockByItem[itemId] = {
    stock: Number.isFinite(qty) && qty >= 0 ? qty : 0,
    title: String(r?.title ?? r?.item_title ?? r?.name ?? ''),
    inventory_id: String(r?.inventory_id ?? r?.inventoryId ?? '')
  };
}


    const visitsByItem = {};  // item_id -> total visitas en ventana
    for (const r of vRows || []) {
      const itemId = String(r?.item_id ?? '').trim();
      if (!itemId) continue;
      const whenStr = r?.date || r?.created_at || null;
      const t = parseDateToMs(whenStr);
      if (t === null || t < fromMs || t >= toMs) continue;
      const add = Number(r?.visits ?? r?.count ?? 0);
      visitsByItem[itemId] = (visitsByItem[itemId] || 0) + (Number.isFinite(add) ? add : 0);
    }

    const salesByItem = {};   // item_id -> total ventas (unidades) en ventana
   for (const r of sRows || []) {
  const itemId = String(r?.item_id ?? '').trim();
  if (!itemId) continue;
  const whenStr = r?.date || r?.created_at || null;
  const t = parseDateToMs(whenStr);
  if (t === null || t < fromMs || t >= toMs) continue;

  const q = getSalesQty(r) || 1;   // <-- reemplazo
  salesByItem[itemId] = (salesByItem[itemId] || 0) + q;
}


    // --- Armar salida
    const items = [];
    for (const itemId of Object.keys(stockByItem)) {
      const base = stockByItem[itemId];
      const stock  = base.stock || 0;
      const sales  = salesByItem[itemId]  || 0;
      const visits = visitsByItem[itemId] || 0;

      const conv = visits > 0 ? (sales / visits) : 0;                 // tasa de conversión (0..1)
      const demandPerDay = windowDays > 0 ? (sales / windowDays) : 0; // ventas/día
      const coverageDays = demandPerDay > 0 ? (stock / demandPerDay) : Infinity; // días que cubre el stock

      items.push({
        item_id: itemId,
        title: base.title,
        inventory_id: base.inventory_id,
        stock,

        sales,
        visits,
        conv,                // proporción (ej: 0.05 = 5%)
        demand_per_day: demandPerDay,
        coverage_days: coverageDays,

        // por si el front lo quiere mostrar
        window_days: windowDays,
        lead_time_days: leadDays,
        from: fromStr,
        to: toStr,
      });
    }

    // Orden sugerido: menor cobertura primero
    items.sort((a,b) => {
      const ax = Number.isFinite(a.coverage_days) ? a.coverage_days : 1e12;
      const bx = Number.isFinite(b.coverage_days) ? b.coverage_days : 1e12;
      return ax - bx;
    });

    res.json({ ok: true, count: items.length, items, from: fromStr, to: toStr });
  } catch (err) {
    console.error('Error /full/decisions:', err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});





// ---- start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API lista en http://localhost:${PORT}`)
})
