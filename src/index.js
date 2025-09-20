/* ==== HELPERS (TOP-LEVEL, una sola vez) ==== */
function normId(v){ return String(v ?? '').trim().toUpperCase(); }

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

function toYMD(s){
  const t = parseDateToMs(s);
  return t === null ? '' : new Date(t).toISOString().slice(0,10); // 'YYYY-MM-DD'
}

function inWindowDateStr(whenStr, fromStr, toStr){
  const d = toYMD(whenStr);
  return d && d >= fromStr && d < toStr; // [from, to)
}

function getSalesQty(row){
  const candidates = [
    row?.orders, row?.orders_count,
    row?.quantity, row?.qty, row?.units, row?.count,
    row?.sold, row?.sold_qty, row?.sold_quantity, row?.sold_units
  ];
  for (const v of candidates){
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/* Si ya tenés windowRange en tu archivo, dejá el tuyo.
   Si no, podés usar este mínimo (ventana [hoy-ndías, mañana) en UTC):
function windowRange(days){
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()+1));
  const from = new Date(tomorrow.getTime() - days*24*60*60*1000);
  const fromStr = from.toISOString().slice(0,10);
  const toStr   = tomorrow.toISOString().slice(0,10);
  return { fromStr, toStr, fromMs:+from, toMs:+tomorrow };
}
*/


/* ==== ENDPOINT: /full/decisions ==== */
app.get('/full/decisions', requireAuth, async (req, res) => {
  try {
    const windowDays   = Number(req.query.window || 30);
    const leadTimeDays = Number(req.query.lead_time || 7);
    const { fromStr, toStr } = windowRange(windowDays);

    /* --- STOCK --- */
    const { data: fRows, error: fErr } = await supabase
      .from('full_stock_min')
      .select('*');
    if (fErr) throw fErr;

    const stockByItem = {};
    for (const r of fRows || []) {
      const id = normId(r?.item_id ?? r?.ml_item_id ?? r?.ml_id ?? r?.itemId);
      if (!id) continue;
      const stock = Number(
        r?.total ?? r?.qty ?? r?.available_quantity ??
        r?.available ?? r?.stock ?? r?.available_stock ??
        r?.quantity ?? 0
      ) || 0;
      stockByItem[id] = stock;
    }

    /* --- VISITAS (filtrar en DB, límite alto) --- */
    const { data: vRows, error: vErr } = await supabase
      .from('visits_raw')
      .select('*')
      .gte('date', fromStr)
      .lt('date', toStr)
      .order('item_id', { ascending: true })
      .order('date',    { ascending: true })
      .range(0, 49999);
    if (vErr) throw vErr;

    const visitsByItem = {};
    for (const r of vRows || []) {
      const id = normId(r?.item_id ?? r?.ml_item_id ?? r?.ml_id ?? r?.itemId ?? r?.id);
      if (!id) continue;
      if (!inWindowDateStr(r?.date || r?.created_at || null, fromStr, toStr)) continue;
      const add = Number(r?.visits ?? r?.count ?? 0);
      if (!Number.isFinite(add) || add <= 0) continue;
      visitsByItem[id] = (visitsByItem[id] || 0) + add;
    }

    /* --- VENTAS (filtrar en DB, límite alto) --- */
    const { data: sRows, error: sErr } = await supabase
      .from('sales_raw')
      .select('*')
      .gte('date', fromStr)
      .lt('date', toStr)
      .order('item_id', { ascending: true })
      .order('date',    { ascending: true })
      .range(0, 49999);
    if (sErr) throw sErr;

    const salesByItem = {};
    for (const r of sRows || []) {
      const id = normId(r?.item_id ?? r?.ml_item_id ?? r?.ml_id ?? r?.itemId ?? r?.id);
      if (!id) continue;
      if (!inWindowDateStr(r?.date || r?.created_at || null, fromStr, toStr)) continue;
      const q = getSalesQty(r);
      if (q <= 0) continue; // no inventar ventas
      salesByItem[id] = (salesByItem[id] || 0) + q;
    }

    /* --- COMBINAR --- */
    const itemIds = new Set([
      ...Object.keys(stockByItem),
      ...Object.keys(visitsByItem),
      ...Object.keys(salesByItem),
    ]);

    const items = [];
    for (const id of itemIds) {
      const stock  = stockByItem[id]  || 0;
      const visits = visitsByItem[id] || 0;
      const sales  = salesByItem[id]  || 0;

      const demanda_diaria = visits > 0 ? sales / visits : 0;
      const days_coverage  = demanda_diaria > 0 ? stock / demanda_diaria : 0;

      items.push({
        item_id: id,
        title: '',               // (opcional) si querés, podés enriquecer con el título de full_stock_min
        inventory_id: '',        // (opcional) idem
        stock_full: stock,
        visitas_nd: visits,
        ventas_nd: sales,
        demanda_diaria,
        days_coverage,
        window_days: windowDays,
        lead_time_days: leadTimeDays,
        from: fromStr,
        to:   toStr,
      });
    }

    // Orden sugerido: menor cobertura primero
    items.sort((a,b) => {
      const ax = Number.isFinite(a.days_coverage) ? a.days_coverage : 1e12;
      const bx = Number.isFinite(b.days_coverage) ? b.days_coverage : 1e12;
      return ax - bx;
    });

    /* --- DEBUG OPCIONAL --- */
    if (String(req.query.debug || '') === '1') {
      return res.json({
        ok: true,
        window: { from: fromStr, to: toStr },
        counts: {
          full_stock_min_rows: fRows?.length || 0,
          visits_rows: vRows?.length || 0,
          sales_rows: sRows?.length || 0,
          items_out: items.length
        },
        sample_out: items.slice(0,5)
      });
    }

    return res.json({ ok: true, count: items.length, items });
  } catch (err) {
    console.error('Error /full/decisions:', err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});


/* ==== ENDPOINT: /full/decisions/debug_item (rayos X por ítem) ==== */
/* GET /full/decisions/debug_item?item_id=MLA123&window=30   (o &raw=1 para ignorar ventana) */
app.get('/full/decisions/debug_item', requireAuth, async (req, res) => {
  try {
    const qItem = String(req.query.item_id || '').trim();
    if (!qItem) return res.status(400).json({ ok:false, error:'Falta item_id' });

    const windowDays = Number(req.query.window || 30);
    const raw = String(req.query.raw || '0') === '1';

    const { fromStr, toStr } = windowRange(windowDays);
    const probe = normId(qItem);

    const { data: fRows, error: fErr } = await supabase.from('full_stock_min').select('*');
    if (fErr) throw fErr;
    const { data: vRows, error: vErr } = await supabase
      .from('visits_raw').select('*')
      .gte('date', fromStr).lt('date', toStr)
      .order('item_id', { ascending: true })
      .order('date',    { ascending: true })
      .range(0, 49999);
    if (vErr) throw vErr;
    const { data: sRows, error: sErr } = await supabase
      .from('sales_raw').select('*')
      .gte('date', fromStr).lt('date', toStr)
      .order('item_id', { ascending: true })
      .order('date',    { ascending: true })
      .range(0, 49999);
    if (sErr) throw sErr;

    const vis = [];
    for (const r of vRows || []) {
      const id = normId(r?.item_id ?? r?.ml_item_id ?? r?.ml_id ?? r?.itemId ?? r?.id);
      if (id !== probe) continue;
      if (!raw && !inWindowDateStr(r?.date || r?.created_at || null, fromStr, toStr)) continue;
      vis.push({ date: toYMD(r?.date || r?.created_at), visits: Number(r?.visits ?? r?.count ?? 0) });
    }

    const sales = [];
    for (const r of sRows || []) {
      const id = normId(r?.item_id ?? r?.ml_item_id ?? r?.ml_id ?? r?.itemId ?? r?.id);
      if (id !== probe) continue;
      if (!raw && !inWindowDateStr(r?.date || r?.created_at || null, fromStr, toStr)) continue;
      sales.push({
        date: toYMD(r?.date || r?.created_at),
        orders: Number(r?.orders ?? 0),
        quantity: Number(r?.quantity ?? 0),
        qty: Number(r?.qty ?? 0),
        units: Number(r?.units ?? 0),
        count: Number(r?.count ?? 0),
        sold: Number(r?.sold ?? 0),
        sold_qty: Number(r?.sold_qty ?? 0),
        sold_quantity: Number(r?.sold_quantity ?? 0),
        sold_units: Number(r?.sold_units ?? 0),
        used_qty: getSalesQty(r)
      });
    }

    const stockRow = (fRows || []).find(r => normId(r?.item_id ?? r?.ml_item_id ?? r?.ml_id ?? r?.itemId) === probe);
    const stock = Number(
      stockRow?.total ?? stockRow?.qty ?? stockRow?.available_quantity ??
      stockRow?.available ?? stockRow?.stock ?? stockRow?.available_stock ??
      stockRow?.quantity ?? 0
    ) || 0;

    const sum = (xs, k) => xs.reduce((a,b) => a + (Number(b[k])||0), 0);
    const sales_total = sum(sales, 'used_qty');
    const visits_total = sum(vis, 'visits');

    return res.json({
      ok: true,
      probe_item_id: probe,
      window: raw ? 'RAW (sin filtro)' : { from: fromStr, to: toStr },
      counts: { visits_rows: vis.length, sales_rows: sales.length },
      totals: { sales_total, visits_total, stock },
      stock_row_sample: stockRow || null,
      visits_rows_sample: vis.slice(0,10),
      sales_rows_sample: sales.slice(0,10)
    });
  } catch (err) {
    console.error('Error /full/decisions/debug_item:', err);
    return res.status(500).json({ ok:false, error:String(err?.message||err) });
  }
});
