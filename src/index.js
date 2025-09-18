// src/index.js
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

// --- Config ---
const PORT = process.env.PORT || 3000
const API_SECRET = process.env.API_SECRET
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

// Chequeo de envs con log claro (sin exponer secretos)
const missing = []
if (!API_SECRET) missing.push('API_SECRET')
if (!SUPABASE_URL) missing.push('SUPABASE_URL')
if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
if (missing.length) {
  console.error('Faltan variables en .env:', missing, {
    hasApiSecret: !!API_SECRET,
    hasUrl: !!SUPABASE_URL,
    hasServiceRole: !!SUPABASE_SERVICE_ROLE_KEY,
    node: process.version,
  })
  process.exit(1)
}

// Cliente Supabase (usar Service Role SOLO en el backend)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// --- App ---
const app = express()
app.use(cors())
app.use(express.json())
app.use(morgan('dev'))

// Auth simple por header Authorization: Bearer XXX
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (token !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime_s: process.uptime(), node: process.version })
})

// Ver envs (sin exponer secretos) para debug rápido
app.get('/env-check', (req, res) => {
  res.json({
    ok: true,
    hasApiSecret: !!API_SECRET,
    hasUrl: !!SUPABASE_URL,
    hasServiceRole: !!SUPABASE_SERVICE_ROLE_KEY,
    port: PORT,
  })
})

// KPIs básicos (últimos 30 días)
app.get('/kpis', requireAuth, async (req, res) => {
  try {
    const today = new Date()
    const from = new Date(today)
    from.setDate(from.getDate() - 30)
    const fromStr = from.toISOString().slice(0, 10) // YYYY-MM-DD
    const toStr = today.toISOString().slice(0, 10)

    // Ventas (sales_raw) cuenta de filas en rango
    const { count: salesCount, error: salesErr } = await supabase
      .from('sales_raw')
      .select('*', { count: 'exact', head: true })
      .gte('date', fromStr)
      .lte('date', toStr)
    if (salesErr) throw salesErr

    // Visitas (visits_raw) suma de visitas
    const { data: visitsRows, error: visitsErr } = await supabase
      .from('visits_raw')
      .select('visits, date')
      .gte('date', fromStr)
      .lte('date', toStr)
      .limit(100000)
    if (visitsErr) throw visitsErr
    const totalVisits = (visitsRows || []).reduce((acc, r) => acc + (Number(r.visits) || 0), 0)

    // Conversión simple (ventas / visitas)
    const conversion = totalVisits > 0 ? salesCount / totalVisits : 0

    res.json({
      range: { from: fromStr, to: toStr },
      sales_30d: salesCount || 0,
      visits_30d: totalVisits,
      conv_30d: Number(conversion.toFixed(4))
    })
  } catch (err) {
    console.error('Error /kpis:', err)
    res.status(500).json({ error: 'KPIs error' })
  }
})

// Ventas diarias
app.get('/sales/daily', requireAuth, async (req, res) => {
  try {
    const from = req.query.from || new Date(Date.now() - 30*24*3600*1000).toISOString().slice(0,10)
    const to = req.query.to || new Date().toISOString().slice(0,10)

    const { data, error } = await supabase
      .from('sales_raw')
      .select('date, item_id')
      .gte('date', from)
      .lte('date', to)
    if (error) throw error

    const map = new Map()
    for (const row of data || []) {
      const d = row.date
      map.set(d, (map.get(d) || 0) + 1)
    }
    const out = Array.from(map.entries())
      .sort((a,b) => a[0].localeCompare(b[0]))
      .map(([date, orders]) => ({ date, orders }))
    res.json({ from, to, rows: out })
  } catch (err) {
    console.error('Error /sales/daily:', err)
    res.status(500).json({ error: 'sales error' })
  }
})

// Visitas diarias
app.get('/visits/daily', requireAuth, async (req, res) => {
  try {
    const from = req.query.from || new Date(Date.now() - 30*24*3600*1000).toISOString().slice(0,10)
    const to = req.query.to || new Date().toISOString().slice(0,10)

    const { data, error } = await supabase
      .from('visits_raw')
      .select('date, visits')
      .gte('date', from)
      .lte('date', to)
      .limit(100000)
    if (error) throw error

    const map = new Map()
    for (const row of data || []) {
      const d = row.date
      map.set(d, (map.get(d) || 0) + (Number(row.visits) || 0))
    }
    const out = Array.from(map.entries())
      .sort((a,b) => a[0].localeCompare(b[0]))
      .map(([date, visits]) => ({ date, visits }))
    res.json({ from, to, rows: out })
  } catch (err) {
    console.error('Error /visits/daily:', err)
    res.status(500).json({ error: 'visits error' })
  }
})

// Snapshot de stock Full (para una fecha)
app.get('/stock/full', requireAuth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0,10)
    const { data, error } = await supabase
      .from('full_stock_min')
      .select('*')
      .eq('date', date)
      .limit(10000)
    if (error) throw error
    res.json({ date, count: data?.length || 0, rows: data || [] })
  } catch (err) {
    console.error('Error /stock/full:', err)
    res.status(500).json({ error: 'stock error' })
  }
})

// Test conexión a Supabase
app.get('/ping-supa', requireAuth, async (req, res) => {
  try {
    const candidates = ['visits_raw', 'sales_raw', 'full_stock_min']
    for (const t of candidates) {
      const { error } = await supabase.from(t).select('*', { head: true, count: 'exact' }).limit(1)
      if (!error) return res.json({ ok: true, table: t })
    }
    res.status(500).json({ ok: false, error: 'No pude leer tablas candidatas' })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) })
  }
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`API lista en http://localhost:${PORT}`)
})
