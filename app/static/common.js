// Shared helpers for both screens.
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hhmm = (iso) => (iso ? iso.slice(11, 16) : "—");
const nowIso = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 19); };

function store(key, value) {
  try { if (value === undefined) return JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify(value)); }
  catch { return null; }
}

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => null);
  return { status: r.status, data };
}

function nivelBar(item) {
  const pct = item.nivel ?? 0;
  const estado = item.estado_producto || item.estado; // work-list items carry the alert's own `estado`
  const cls = item.stock_gondola === 0 ? "zero" : estado === "BAJO" || estado === "SIN_DEPOSITO" ? "low" : "";
  return `<div class="bar ${cls}" role="img" aria-label="Nivel ${pct}%"><i style="width:${pct}%"></i></div>`;
}

async function loadSucursales(select, onChange) {
  const { data } = await api("GET", "/sucursales");
  const saved = store("sucursal");
  select.innerHTML = (data || []).map((s) => `<option ${s === saved ? "selected" : ""}>${esc(s)}</option>`).join("");
  select.onchange = () => { store("sucursal", select.value); onChange(select.value); };
  onChange(select.value);
}

// Live updates: any event triggers a debounced reload of fresh state.
function live(sucursal, onEvent, dot) {
  let es, timer;
  const debounced = (e) => { clearTimeout(timer); timer = setTimeout(() => onEvent(null), 250); if (e) onEvent(e); };
  es = new EventSource(`/sucursales/${encodeURIComponent(sucursal)}/stream`);
  es.onopen = () => { dot.classList.add("on"); debounced(null); };
  es.onerror = () => dot.classList.remove("on");
  for (const t of ["producto.actualizado", "alerta.creada", "alerta.cerrada"]) {
    es.addEventListener(t, (ev) => debounced({ type: t, data: JSON.parse(ev.data) }));
  }
  return () => es.close();
}

function toast(msg, color) {
  const t = $("#toast");
  t.textContent = msg;
  t.style.background = color || "";
  t.style.display = "block";
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.style.display = "none"), 6000);
}
