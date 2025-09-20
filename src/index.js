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
