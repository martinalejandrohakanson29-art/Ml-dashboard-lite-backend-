// src/index.js — back mínimo y estable (ESM)
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

/* ================== Config ================== */
const PORT = process.env.PORT || 3000
const API_SECRET = process.env.API_SECRET
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

/* ================== Helpers ================== */
function normId(v) {
  return String(v ?? '').trim().toUpperCase()
}

function parseDateToMs(s) {
  if (!s) return null
  const t = +new Date(s)
  if (!Number.isNaN(t)) return t
  const m = String(s).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
  if (m) {
    const d = parseInt(m[1], 10)
    const mo = parseInt(m[2], 10) - 1
    const y = parseInt(m[3], 10)
    return +new Date(y, mo, d)
  }
  return null
}

function windowRange(days) {
  const now = new Date()
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const from = new Date(tomorrow.getTime() - days * 24 * 60 * 60 * 1000)
  const fromStr = from.toISOString().slice(0, 10)
  const toStr = tomorrow.toISOString().slice(0, 10)
  return { fromStr, toStr, fromMs: +new Date(fromStr), toMs: +new Date(toStr) }
}

function getSalesQty(row) {
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
  ]
  for (const v of candidates) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 0
}

/* ================== App base ================== */
const corsOpts = {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}

const app = express()
app.use(cors(corsOpts))
app.options('*', cors(corsOpts))
app.use(morgan('tiny'))

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltan vars de entorno de Supabase')
}
const supabase = createClient(SUPABASE_URL || '', SUPABASE_SERVICE_ROLE_KEY || '')

function requireAuth(req, res, next) {
  const auth = req.headers['authorization'] || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token || token !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

/* ================== Health/env ================== */
app.get('/health', (_req, res) => res.json({ ok: true }))
app.get('/env-check', (_req, res) => {
  res.json({
    ok: true,
    hasApiSecret: !!API_SECRET,
    hasUrl: !!SUPABASE_URL,
    hasServiceRole: !!SUPABASE_SERVICE_ROLE_KEY,
    port: String(PORT)
  })
})

/* ================== Endpoints ================== */
// 1) Stock FULL (lo que espera el front: { rows: [...] })
app.get('/stock/full', requireAuth, async (_req, res) => {
  try {
    const { data, error } = await supabase.from('full_stock_min').select('*')
    if (error) throw error
    res.json({ rows: data || [] })
  } catch (err) {
    console.error('Error /stock/full:', err)
    res.status(500).json({ error: String(err?.message || err) })
  }
})

// 2) Decisiones FULL combinando stock + visitas + ventas en ventana
app.get('/full/decisions', requireAuth, async (req, res) => {
  try {
    const windowDays = Number(req.query.window || 30)
    const leadTimeDays = Number(req.query.lead_time || 7)
    const { fromStr, toStr } = windowRange(windowDays)

    // STOCK
    const { data: fRows, error: fErr } = await supabase.from('full_stock_min').select('*')
    if (fErr) throw fErr
    const stockByItem = {}
    for (const r of fRows || []) {
      const itemId = normId(r?.item_id ?? r?.ml_item_id ?? r?.ml_id ?? r?.itemId)
      if (!itemId) continue
      const stock =
        Number(
          r?.total ??
            r?.qty ??
            r?.available_quantity ??
            r?.available ??
            r?.stock ??
            r?.available_stock ??
            r?.quantity ??
            0
        ) || 0
      stockByItem[itemId] = stock
    }

    // VISITAS
    const { data: vRows, error: vErr } = await supabase
      .from('visits_raw')
      .select('*')
      .gte('date', fromStr)
      .lt('date', toStr)
      .order('date', { ascending: true })
      .limit(50000)
    if (vErr) throw vErr
    const visitsByItem = {}
    for (const r of vRows || []) {
      const itemId = normId(r?.item_id ?? r?.ml_item_id ?? r?.ml_id ?? r?.itemId ?? r?.id)
      if (!itemId) continue
      const add = Number(r?.visits ?? r?.count ?? 0)
      if (!Number.isFinite(add) || add <= 0) continue
      visitsByItem[itemId] = (visitsByItem[itemId] || 0) + add
    }

    // VENTAS
    const { data: sRows, error: sErr } = await supabase
      .from('sales_raw')
      .select('*')
      .gte('date', fromStr)
      .lt('date', toStr)
      .order('date', { ascending: true })
      .limit(50000)
    if (sErr) throw sErr
    const salesByItem = {}
    for (const r of sRows || []) {
      const itemId = normId(r?.item_id ?? r?.ml_item_id ?? r?.ml_id ?? r?.itemId ?? r?.id)
      if (!itemId) continue
      const q = getSalesQty(r)
      if (q <= 0) continue
      salesByItem[itemId] = (salesByItem[itemId] || 0) + q
    }

    // COMBINAR
    const itemIds = new Set([
      ...Object.keys(stockByItem),
      ...Object.keys(visitsByItem),
      ...Object.keys(salesByItem)
    ])

    const items = []
    for (const id of itemIds) {
      const stock = stockByItem[id] || 0
      const visits = visitsByItem[id] || 0
      const sales = salesByItem[id] || 0

      // tasa de conversión ≈ ventas/visitas; "demanda diaria" ≈ ventas/ventana
      const conversion = visits > 0 ? sales / visits : 0
      const demanda_diaria = windowDays > 0 ? sales / windowDays : 0
      const days_coverage = demanda_diaria > 0 ? stock / demanda_diaria : Infinity

      items.push({
        item_id: id,
        stock_full: stock,
        visitas_nd: visits,
        ventas_nd: sales,
        conversion,
        demanda_diaria,
        days_coverage,
        window_days: windowDays,
        lead_time_days: leadTimeDays,
        from: fromStr,
        to: toStr
      })
    }

    // Orden sugerido: menor cobertura primero
    items.sort((a, b) => {
      const ax = Number.isFinite(a.days_coverage) ? a.days_coverage : 1e12
      const bx = Number.isFinite(b.days_coverage) ? b.days_coverage : 1e12
      return ax - bx
    })

    // Debug opcional
    if (String(req.query.debug || '') === '1') {
      const allDatesV = (vRows || [])
        .map((r) => parseDateToMs(r?.date || r?.created_at || null))
        .filter((t) => t !== null)
        .sort((a, b) => a - b)
      const allDatesS = (sRows || [])
        .map((r) => parseDateToMs(r?.date || r?.created_at || null))
        .filter((t) => t !== null)
        .sort((a, b) => a - b)

      return res.json({
        ok: true,
        window: { from: fromStr, to: toStr },
        counts: {
          full_stock_min_rows: fRows?.length || 0,
          visits_rows: vRows?.length || 0,
          sales_rows: sRows?.length || 0,
          items_stock: Object.keys(stockByItem).length,
          items_visits: Object.keys(visitsByItem).length,
          items_sales: Object.keys(salesByItem).length
        },
        dates: {
          visits_min: allDatesV[0]
            ? new Date(allDatesV[0]).toISOString().slice(0, 10)
            : null,
          visits_max: allDatesV.at(-1)
            ? new Date(allDatesV.at(-1)).toISOString().slice(0, 10)
            : null,
          sales_min: allDatesS[0]
            ? new Date(allDatesS[0]).toISOString().slice(0, 10)
            : null,
          sales_max: allDatesS.at(-1)
            ? new Date(allDatesS.at(-1)).toISOString().slice(0, 10)
            : null
        },
        items
      })
    }

    return res.json({ ok: true, count: items.length, items, from: fromStr, to: toStr })
  } catch (err) {
    console.error('Error /full/decisions:', err)
    res.status(500).json({ ok: false, error: String(err?.message || err) })
  }
})

// 3) Debug profundo sin ventana
app.get('/full/decisions/debug2', requireAuth, async (_req, res) => {
  try {
    const { data: fRows, error: fErr } = await supabase
      .from('full_stock_min')
      .select('item_id,title,total,inventory_id')
    if (fErr) throw fErr

    const { data: vRows, error: vErr } = await supabase
      .from('visits_raw')
      .select('item_id,date,visits')
    if (vErr) throw vErr

    const { data: sRows, error: sErr } = await supabase
      .from('sales_raw')
      .select('*')
    if (sErr) throw sErr

    const stockIds = new Set((fRows || []).map((r) => String(r?.item_id || '').trim()))
    const visitIds = new Set((vRows || []).map((r) => String(r?.item_id || '').trim()))
    const salesIds = new Set((sRows || []).map((r) => String(r?.item_id || '').trim()))

    const intersectSV = [...stockIds].filter((x) => visitIds.has(x))
    const intersectSS = [...stockIds].filter((x) => salesIds.has(x))
    const probe = intersectSV[0] || [...stockIds][0] || null

    let visitsAll = 0,
      salesAll = 0,
      visits30d = 0,
      sales30d = 0
    const today = new Date()
    const to = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000)

    for (const r of vRows || []) {
      if (String(r?.item_id || '').trim() !== probe) continue
      const t = new Date(r?.date).getTime()
      const v = Number(r?.visits || 0)
      visitsAll += Number.isFinite(v) ? v : 0
      if (t >= +from && t < +to) visits30d += Number.isFinite(v) ? v : 0
    }

    for (const r of sRows || []) {
      if (String(r?.item_id || '').trim() !== probe) continue
      const t = new Date(r?.date).getTime()
      const q = getSalesQty(r)
      salesAll += q
      if (t >= +from && t < +to) sales30d += q
    }

    const stockRow =
      (fRows || []).find((r) => String(r?.item_id || '').trim() === probe) || {}
    const stock =
      Number(
        stockRow?.total ??
          stockRow?.qty ??
          stockRow?.available_quantity ??
          stockRow?.available ??
          stockRow?.stock ??
          stockRow?.available_stock ??
          stockRow?.quantity ??
          0
      ) || 0

    return res.json({
      ok: true,
      probe_item_id: probe,
      counts: {
        full_stock_min_rows: fRows?.length || 0,
        visits_rows: vRows?.length || 0,
        sales_rows: sRows?.length || 0,
        unique_ids: {
          stock: stockIds.size,
          visits: visitIds.size,
          sales: salesIds.size
        },
        intersections: {
          stock_visits: intersectSV.length,
          stock_sales: intersectSS.length
        }
      },
      probe_summary: {
        stock_total_col: stock,
        visits_all_time: visitsAll,
        visits_last_30d: visits30d,
        sales_all_time: salesAll,
        sales_last_30d: sales30d
      },
      window_used_30d: {
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10)
      }
    })
  } catch (err) {
    console.error('Error /full/decisions/debug2:', err)
    res.status(500).json({ ok: false, error: String(err?.message || err) })
  }
})

/* ================== Start ================== */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API lista en http://localhost:${PORT}`)
})
