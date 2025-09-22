// src/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

// Auth simple (para endpoints privados, más adelante)
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!API_SECRET || token !== API_SECRET) {
    return res.status(401).json({ ok: false, error: 'missing/invalid token' });
  }
  next();
}

// Raíz (ping)
app.get('/', (_req, res) => {
  res.json({ ok: true, name: 'ml-dashboard-lite backend', now: new Date().toISOString() });
});

// Salud (sin auth)
app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime_s: Math.round(process.uptime()) });
});

// Check de variables (sin exponer secretos)
app.get('/env-check', (_req, res) => {
  res.json({
    ok: true,
    hasApiSecret: !!API_SECRET,
    hasUrl: !!SUPABASE_URL,
    hasServiceRole: !!SUPABASE_SERVICE_ROLE_KEY,
    port: String(PORT),
  });
});

// Placeholder de endpoint privado (después lo llenamos)
app.get('/kpis', requireAuth, (_req, res) => {
  res.json({ ok: true, rows: [] });
});



// === FULL: stock mínimo (tabla full_stock_min) ===
app.get('/full/stock', requireAuth, async (_req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: 'Supabase no configurado' });

    // Traemos todas las columnas para evitar errores de nombre (select('*'))
    const { data, error } = await supabase
      .from('full_stock_min')
      .select('*')
      .order('title', { ascending: true });

    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, rows: data || [] });
  } catch (err) {
    console.error('GET /full/stock error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// === FULL: KPIs 30d (stock + visitas + órdenes)
app.get('/full/kpis-30d', requireAuth, async (_req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: 'Supabase no configurado' });
    const { data, error } = await supabase
      .from('vw_full_kpis_30d') // tu vista
      .select('*')
      .order('title', { ascending: true });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, rows: data || [] });
  } catch (err) {
    console.error('GET /full/kpis-30d error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});


// === FULL: Plan de reposición (envíos) ===
// Params (query):
//   lt: lead time días (default 7)
//   buffer: días de seguridad (default 3)
//   cover: cobertura objetivo en días (default 14)
//   min_opd: piso ventas/día (default 0.1)
app.get('/full/replenishment-plan', requireAuth, async (req, res) => {
  const LT      = Number(req.query.lt ?? 7);
  const BUFFER  = Number(req.query.buffer ?? 3);
  const COVER   = Number(req.query.cover ?? 14);
  const MIN_OPD = Number(req.query.min_opd ?? 0.1);

  try {
    if (!supabase) return res.status(500).json({ ok:false, error:'Supabase no configurado' });

    const { data, error } = await supabase
      .from('vw_full_kpis_30d_plus')
      .select('*');

    if (error) return res.status(500).json({ ok:false, error: error.message });

    const rows = (data || []).map(r => {
      const available = Number(r.available_quantity ?? (r.total - r.not_available_quantity) ?? 0);
      const opd_raw   = Number(r.orders_per_day_30d || 0);
      const opd       = Math.max(opd_raw, MIN_OPD);                 // piso
      const dos       = opd > 0 ? available / opd : Infinity;       // días de cobertura
      const rop       = opd * (LT + BUFFER);                        // punto de pedido
      const target    = opd * (LT + COVER);                         // stock objetivo
      const suggest   = Math.max(0, Math.ceil(target - available)); // envío sugerido

      // semáforo
      let status = 'green';
      if (available <= rop) status = 'red';
      else if (available <= opd * (LT + BUFFER + 7)) status = 'yellow';

      const daysNoSale = Number(r.days_no_sale ?? 0);
      const stale = daysNoSale >= Math.max(0, 60 - LT); // riesgo 60d sin venta

      return {
        ...r,
        opd_raw, opd: Number(opd.toFixed(3)),
        dos: Number.isFinite(dos) ? Number(dos.toFixed(1)) : null,
        rop: Math.ceil(rop),
        target: Math.ceil(target),
        suggest,
        status,
        stale
      };
    }).sort((a, b) => {
      const rank = s => (s==='red'?0 : s==='yellow'?1 : 2);
      return rank(a.status) - rank(b.status) || (a.dos ?? 1e9) - (b.dos ?? 1e9);
    });

    res.json({ ok:true, params:{ LT, BUFFER, COVER, MIN_OPD }, rows });
  } catch (err) {
    console.error('GET /full/replenishment-plan error:', err);
    res.status(500).json({ ok:false, error:'Internal error' });
  }
});



// 404
app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

// 500
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`[ml-dashboard-lite] listening on :${PORT}`);
});
