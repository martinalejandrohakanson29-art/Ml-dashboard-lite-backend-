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

  // --- helpers ---
// helpers (top-level)
function normId(v){ return String(v ?? '').trim().toUpperCase(); }

function inWindowDateStr(whenStr, fromStr, toStr) {
  const d = String(whenStr || '').slice(0,10); // 'YYYY-MM-DD'
  return d >= fromStr && d < toStr;            // [from, to)
}

// Parser de fechas (solo parsea, no declare helpers aquí)
function parseDateToMs(s){
  if (!s) return null;
  const t = +new Date(s);
  if (!Number.isNaN(t)) return t;
  const m = String(s).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const d = parseInt(m[1],10), mo = parseInt(m[2],10)-1, y = parseInt(m[3],10);
    return +new Date(y, mo, d);
  }
  return null;
}

function getSalesQty(row){
  const candidates = [
    row?.orders,
    row?.orders_count,
    row?.quantity,
    row?.qty,
    row?.units,
    row?.count,
    row?.sold,
    row?.sold_qty,
    row?.sold_quantity,
    row?.sold_units
  ];
  for (const v of candidates){
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
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



app.get('/full/decisions', requireAuth, async (req, res) => {
  try {
    const windowDays = Number(req.query.window || 30);
    const leadTimeDays = Number(req.query.lead_time || 7);
    const { fromStr, toStr } = windowRange(windowDays);

    // --- STOCK
    const { data: fRows, error: fErr } = await supabase
      .from('full_stock_min')
      .select('*');
    if (fErr) throw fErr;

    const stockByItem = {};
    for (const r of fRows || []) {
      const itemId = normId(r?.item_id ?? r?.ml_item_id ?? r?.ml_id ?? r?.itemId);
      if (!itemId) continue;
      const stock = Number(
        r?.total ?? r?.qty ?? r?.available_quantity ??
        r?.available ?? r?.stock ?? r?.available_stock ??
        r?.quantity ?? 0
      ) || 0;
      stockByItem[itemId] = stock;
    }

    // --- VISITAS (filtrado en la query, límite alto)
    const { data: vRows, error: vErr } = await supabase
      .from('visits_raw')
      .select('*')
      .gte('date', fromStr)
      .lt('date', toStr)
      .order('date', { ascending: true })
      .limit(50000);
    if (vErr) throw vErr;

    const visitsByItem = {};
    for (const r of vRows || []) {
      const itemId = normId(r?.item_id ?? r?.ml_item_id ?? r?.ml_id ?? r?.itemId ?? r?.id);
      if (!itemId) continue;
      const add = Number(r?.visits ?? r?.count ?? 0);
      if (!Number.isFinite(add) || add <= 0) continue;
      visitsByItem[itemId] = (visitsByItem[itemId] || 0) + add;
    }

    // --- VENTAS (filtrado en la query, límite alto)
    const { data: sRows, error: sErr } = await supabase
      .from('sales_raw')
      .select('*')
      .gte('date', fromStr)
      .lt('date', toStr)
      .order('date', { ascending: true })
      .limit(50000);
    if (sErr) throw sErr;

    const salesByItem = {};
    for (const r of sRows || []) {
      const itemId = normId(r?.item_id ?? r?.ml_item_id ?? r?.ml_id ?? r?.itemId ?? r?.id);
      if (!itemId) continue;
      const q = getSalesQty(r);
      if (q <= 0) continue;
      salesByItem[itemId] = (salesByItem[itemId] || 0) + q;
    }

    // --- COMBINAR RESULTADOS
    const itemIds = new Set([
      ...Object.keys(stockByItem),
      ...Object.keys(visitsByItem),
      ...Object.keys(salesByItem)
    ]);

    const items = [];
    for (const id of itemIds) {
      const stock = stockByItem[id] || 0;
      const visits = visitsByItem[id] || 0;
      const sales = salesByItem[id] || 0;

      const demanda_diaria = visits > 0 ? sales / visits : 0;
      const coverage = demanda_diaria > 0 ? stock / demanda_diaria : 0;

      items.push({
        item_id: id,
        stock_full: stock,
        visitas_nd: visits,
        ventas_nd: sales,
        demanda_diaria,
        days_coverage: coverage,
        window_days: windowDays,
        lead_time_days: leadTimeDays,
        from: fromStr,
        to: toStr
      });
    }

    res.json({
      ok: true,
      count: items.length,
      items
    });
  } catch (err) {
    console.error('Error /full/decisions:', err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});



  // Orden sugerido: menor cobertura primero
items.sort((a,b) => {
  const ax = Number.isFinite(a.days_coverage) ? a.days_coverage : 1e12;
  const bx = Number.isFinite(b.days_coverage) ? b.days_coverage : 1e12;
  return ax - bx;
});


/* ===== DEBUG OPCIONAL ===== */
if (String(req.query.debug || '') === '1') {
  const allDatesV = (vRows || [])
    .map(r => parseDateToMs(r?.date || r?.created_at || null))
    .filter(t => t !== null)
    .sort((a,b) => a-b);

  const allDatesS = (sRows || [])
    .map(r => parseDateToMs(r?.date || r?.created_at || null))
    .filter(t => t !== null)
    .sort((a,b) => a-b);

  return res.json({
    ok: true,
    window: { from: fromStr, to: toStr },
    counts: {
      full_stock_min_rows: fRows?.length || 0,
      visits_rows: vRows?.length || 0,
      sales_rows: sRows?.length || 0,
      items_stock: Object.keys(stockByItem).length,
      items_visits: Object.keys(visitsByItem).length,
      items_sales: Object.keys(salesByItem).length,
    },
    dates: {
      visits_min: allDatesV[0] ? new Date(allDatesV[0]).toISOString().slice(0,10) : null,
      visits_max: allDatesV.at(-1) ? new Date(allDatesV.at(-1)).toISOString().slice(0,10) : null,
      sales_min:  allDatesS[0] ? new Date(allDatesS[0]).toISOString().slice(0,10) : null,
      sales_max:  allDatesS.at(-1) ? new Date(allDatesS.at(-1)).toISOString().slice(0,10) : null,
    }
  });
}
/* ===== /DEBUG ===== */



    
    res.json({ ok: true, count: items.length, items, from: fromStr, to: toStr });
  } catch (err) {
    console.error('Error /full/decisions:', err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});


// DEBUG profundo: cruce de tablas sin filtrar por ventana
app.get('/full/decisions/debug2', requireAuth, async (req, res) => {
  try {
    // traigo todo lo justo (sin dobles select)
    const { data: fRows, error: fErr } = await supabase.from('full_stock_min').select('item_id,title,total,inventory_id');
    if (fErr) throw fErr;
    const { data: vRows, error: vErr } = await supabase.from('visits_raw').select('item_id,date,visits');
    if (vErr) throw vErr;
   const { data: sRows, error: sErr } = await supabase
  .from('sales_raw')
  .select('*');
if (sErr) throw sErr;


    // sets de IDs
    const stockIds  = new Set((fRows||[]).map(r => String(r?.item_id||'').trim()));
    const visitIds  = new Set((vRows||[]).map(r => String(r?.item_id||'').trim()));
    const salesIds  = new Set((sRows||[]).map(r => String(r?.item_id||'').trim()));

    // intersecciones
    const intersectSV = [...stockIds].filter(x => visitIds.has(x));
    const intersectSS = [...stockIds].filter(x => salesIds.has(x));

    // elegimos un item que esté tanto en stock como en visitas (si existe)
    const probe = intersectSV[0] || [...stockIds][0] || null;

    // sumas “sin ventana” para el probe
    let visitsAll = 0, salesAll = 0, visits30d = 0, sales30d = 0;
    const today = new Date();            // ventana de 30 días alineada a medianoche
    const to = new Date(today.getFullYear(), today.getMonth(), today.getDate()+1);
    const from = new Date(to.getTime() - 30*24*60*60*1000);

    for (const r of (vRows||[])) {
      if (String(r?.item_id||'').trim() !== probe) continue;
      const t = new Date(r?.date).getTime();
      const v = Number(r?.visits||0);
      visitsAll += Number.isFinite(v) ? v : 0;
      if (t >= +from && t < +to) visits30d += Number.isFinite(v) ? v : 0;
    }
    for (const r of (sRows||[])) {
      if (String(r?.item_id||'').trim() !== probe) continue;
      const t = new Date(r?.date).getTime();
      const q = Number(
        r?.orders ?? r?.quantity ?? r?.qty ?? r?.units ?? r?.count ?? 0
      );
      salesAll  += Number.isFinite(q) && q > 0 ? q : 0;
      if (t >= +from && t < +to) sales30d += (Number.isFinite(q) && q > 0 ? q : 0);
    }

    // stock para el probe (leyendo 'total' primero)
    const stockRow = (fRows||[]).find(r => String(r?.item_id||'').trim() === probe) || {};
    const stock =
      Number(
        stockRow?.total ?? stockRow?.qty ?? stockRow?.available_quantity ??
        stockRow?.available ?? stockRow?.stock ?? stockRow?.available_stock ??
        stockRow?.quantity ?? 0
      ) || 0;

    return res.json({
      ok: true,
      probe_item_id: probe,
      counts: {
        full_stock_min_rows: fRows?.length || 0,
        visits_rows: vRows?.length || 0,
        sales_rows: sRows?.length || 0,
        unique_ids: {
          stock: stockIds.size, visits: visitIds.size, sales: salesIds.size
        },
        intersections: {
          stock_visits: intersectSV.length,
          stock_sales:  intersectSS.length
        }
      },
      probe_summary: {
        stock_total_col: stock,
        visits_all_time: visitsAll,
        visits_last_30d: visits30d,
        sales_all_time:  salesAll,
        sales_last_30d:  sales30d
      },
      window_used_30d: { from: from.toISOString().slice(0,10), to: to.toISOString().slice(0,10) }
    });
  } catch (err) {
    console.error('Error /full/decisions/debug2:', err);
    res.status(500).json({ ok:false, error:String(err?.message||err) });
  }
});



// ---- start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API lista en http://localhost:${PORT}`)
})
