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

// --- decisiones FULL (V3: stock + ventas/visitas + semáforos)
app.get('/full/decisions', requireAuth, async (req, res) => {
  try {
    const windowDays  = parseInt(req.query.window ?? '30', 10)  // 30 o 60
    const leadTime    = parseInt(req.query.lead_time ?? '7', 10)
    const storageDays = parseInt(req.query.storage_days ?? '60', 10)
    const nearMargin  = parseInt(req.query.near_margin ?? '15', 10)

    const { fromStr, toStr, fromMs, toMs } = windowRange(windowDays)

    // 1) Stock
    const { data: stockRows, error: stockErr } = await supabase
      .from('full_stock_min')
      .select('item_id,title,available_quantity,total,updated_at')
    if (stockErr) throw stockErr

    // 2) Visitas (sumamos en Node)
    const { data: vRows, error: vErr } = await supabase
      .from('visits_raw')
      .select('item_id, visits, date')
    if (vErr) throw vErr

    // 3) Ventas (sumatoria + última venta)
    const { data: sRows, error: sErr } = await supabase
      .from('sales_raw')
      .select('item_id, quantity, date, created_at')
    if (sErr) throw sErr

    const visitsByItem = {}
    for (const r of vRows || []) {
      const k = String(r?.item_id ?? '')
      if (!k) continue
      const t = r?.date ? +new Date(r.date) : null
      const n = Number(r?.visits ?? 0)
      if (t !== null && t >= fromMs && t < toMs) {
        visitsByItem[k] = (visitsByItem[k] || 0) + (Number.isFinite(n) ? n : 0)
      }
    }

    const salesByItem = {}
    const lastSaleTsByItem = {}
    for (const r of sRows || []) {
      const k = String(r?.item_id ?? '')
      if (!k) continue
      const whenStr = r?.date || r?.created_at || null
      const when = whenStr ? +new Date(whenStr) : null
      const qRaw = r?.quantity
      const q = Number.isFinite(Number(qRaw)) && Number(qRaw) > 0 ? Number(qRaw) : 1
      if (when !== null && when >= fromMs && when < toMs) {
        salesByItem[k] = (salesByItem[k] || 0) + q
      }
      if (when !== null) {
        if (!lastSaleTsByItem[k] || when > lastSaleTsByItem[k]) lastSaleTsByItem[k] = when
      }
    }

    const items = (stockRows || []).map(r => {
      const item_id = String(r?.item_id || '')
      const title   = r?.title || ''
      const stock   = Number(r?.available_quantity ?? r?.total ?? 0) || 0

      const ventas_nd  = Number(salesByItem[item_id] || 0)
      const visitas_nd = Number(visitsByItem[item_id] || 0)
      const conv_nd    = visitas_nd > 0 ? (ventas_nd / visitas_nd) : 0
      const demanda_diaria = ventas_nd > 0 ? (ventas_nd / windowDays) : 0

      let days_coverage = null
      let break_date = null
      let stock_flag = 'ok'
      if (demanda_diaria > 0) {
        days_coverage = stock / demanda_diaria
        if (days_coverage <= leadTime) stock_flag = 'risk'
        else if (days_coverage <= 2 * leadTime) stock_flag = 'warn'
        const breakMs = Date.now() + Math.floor(days_coverage) * 86400000
        break_date = new Date(breakMs).toISOString().slice(0,10)
      }

      const lastTs = lastSaleTsByItem[item_id] || null
      const last_sale_date = lastTs ? new Date(lastTs).toISOString() : null
      const days_since_last_sale = lastTs ? Math.floor((Date.now() - lastTs)/86400000) : null

      let storage_flag = 'ok'
      if (days_since_last_sale !== null) {
        if (days_since_last_sale >= storageDays) storage_flag = 'risk'
        else if (days_since_last_sale >= Math.max(0, storageDays - nearMargin)) storage_flag = 'near'
      }

      let overall_flag = 'ok'
      if (storage_flag === 'risk' || stock_flag === 'risk') overall_flag = 'risk'
      else if (stock_flag === 'warn' || storage_flag === 'near') overall_flag = 'warn'

      const targetStock = 2 * leadTime * demanda_diaria
      const suggested_send = Math.max(0, Math.ceil(targetStock - stock))

      return {
        item_id, title, stock_full: stock,
        ventas_nd, visitas_nd, conv_nd,
        demanda_diaria, days_coverage, break_date,
        last_sale_date, days_since_last_sale,
        stock_flag, storage_flag, overall_flag,
        suggested_send,
        window: windowDays, lead_time: leadTime,
        storage_days: storageDays, near_margin: nearMargin,
        updated_at: r?.updated_at || null,
      }
    })

    res.json({ ok: true, count: items.length, items, from: fromStr, to: toStr })
  } catch (err) {
    console.error('Error /full/decisions:', err)
    res.status(500).json({ ok: false, error: String(err?.message || err) })
  }
})

// ---- start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API lista en http://localhost:${PORT}`)
})
