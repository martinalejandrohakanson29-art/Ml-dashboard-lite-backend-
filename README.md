# ml-dashboard-lite (backend)

Back liviano que **lee** tus tablas de Supabase (cargadas por n8n) y expone endpoints simples para tu dashboard.

## 1) Preparar el repo en GitHub
1. Entrá a GitHub → New repository → nombre: `ml-dashboard-lite` → Create.
2. En la vista del repo, botón **Add file → Create new file**.
3. Creá y pegá el contenido de estos archivos:
   - `package.json`
   - `.env.example`
   - `src/index.js`  (creá la carpeta `src/` y adentro el archivo)
   - `README.md`
4. Commit.

> Tip: si te resulta más cómodo, usá **Add file → Upload files** y arrastrá todos los archivos juntos.

## 2) Variables de entorno
> **No** subas tus credenciales a GitHub. Cargalas en Render.
- `API_SECRET`: inventá un token largo (40–60 caracteres).
- `SUPABASE_URL`: URL de tu proyecto Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: **Service Role Key** (solo en backend).
- `PORT` (opcional): `3000`.

Podés guiarte con `.env.example`.

## 3) Deploy en Render
1. Render → **New Web Service** → conectá tu repo `ml-dashboard-lite`.
2. **Build Command:** `npm install`
3. **Start Command:** `npm start`
4. Runtime: Node 18 o 20.
5. En **Environment Variables**, cargá: `API_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PORT` (opcional).
6. Deploy.

## 4) Probar
- `GET /health` → sin auth: debería responder `{"ok": true, "uptime_s": ...}`.
- `GET /kpis` → **con header** `Authorization: Bearer TU_API_SECRET`.
- `GET /sales/daily?from=YYYY-MM-DD&to=YYYY-MM-DD` → con auth.
- `GET /visits/daily?from=YYYY-MM-DD&to=YYYY-MM-DD` → con auth.
- `GET /stock/full?date=YYYY-MM-DD` → con auth.

## 5) Notas de uso
- Este backend **no** llama a la API de MercadoLibre: solo lee de Supabase.
- Mantené la **Service Role Key** en el backend; el front **nunca** la debe ver.
- Si necesitás performance, agregá **índices** en Supabase (ej. `date`, `item_id`) y vistas/materialized views.

## 6) Roadmap corto
- Cache en memoria de 60–120s para `/kpis`.
- Crear **views** en Supabase (p. ej. `v_conversion_30d`, `v_alertas_full`) y leer desde ahí.
- Armar el **frontend** (Vite + React) que consuma estos endpoints.

---

¿Seguimos con Render y las env vars? Te guío paso a paso.
