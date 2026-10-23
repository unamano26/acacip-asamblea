// API de votación para la Asamblea ACACIP.
// Datos en Netlify Blobs (store "asamblea", consistencia fuerte):
//   padron                         -> { actualizado, socios: { "<dni>": { n: nombre, a: activo } } }
//   mociones                       -> [ { id, titulo, detalle, estado, publicar, creada } ]
//   presentes/<dni>                -> marca de ingreso (para quórum)
//   voto-dni/<mocion>/<dni>        -> marca "ya votó" (se crea una sola vez: onlyIfNew)
//   boletas/<mocion>/<opcion>/<id> -> un voto, SIN dato del votante (voto secreto)
import { getStore } from "@netlify/blobs";

const SINO = [
  { id: "positivo", texto: "Positivo" },
  { id: "negativo", texto: "Negativo" },
  { id: "abstencion", texto: "Abstención" },
];
// Opciones de una consigna: "sino" (Positivo/Negativo/Abstención) o "opciones"
// (alternativas propias, p. ej. sedes, con Abstención opcional).
function opcionesDe(m) {
  if (m.tipo !== "opciones") return SINO;
  const l = (m.opciones || []).map((o) => ({ id: o.id, texto: o.texto }));
  if (m.abstencion) l.push({ id: "abstencion", texto: "Abstención" });
  return l;
}
function limpiarOpciones(lista) {
  const textos = (Array.isArray(lista) ? lista : []).map((t) => String(t || "").trim().slice(0, 120)).filter(Boolean);
  return textos.slice(0, 8).map((texto, i) => ({ id: "o" + (i + 1), texto }));
}
const store = () => getStore({ name: "asamblea", consistency: "strong" });

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const err = (codigo, mensaje, status = 400) => json({ ok: false, codigo, mensaje }, status);

const limpiarDni = (v) => String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");
const dniValido = (d) => /^\d{6,12}$/.test(d);
const rid = () => crypto.randomUUID();

async function leerPadron(s) {
  return (await s.get("padron", { type: "json" })) || { actualizado: null, socios: {} };
}
async function leerMociones(s) {
  const r = await s.getWithMetadata("mociones", { type: "json" });
  return { lista: (r && r.data) || [], etag: r ? r.etag : null };
}
async function guardarMociones(s, lista, etag) {
  const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
  const r = await s.setJSON("mociones", lista, opts);
  // Algunas versiones de @netlify/blobs no devuelven resultado: se toma como escrito.
  return !r || r.modified !== false;
}
async function contar(s, prefix) {
  const { blobs } = await s.list({ prefix });
  return blobs.map((b) => b.key);
}
async function resultados(s, m) {
  const keys = await contar(s, `boletas/${m.id}/`);
  const r = {};
  for (const o of opcionesDe(m)) r[o.id] = 0;
  let total = 0;
  for (const k of keys) {
    const op = k.split("/")[2];
    if (op in r) { r[op]++; total++; }
  }
  r.total = total;
  return r;
}
async function socioActivo(s, dniRaw) {
  const dni = limpiarDni(dniRaw);
  if (!dniValido(dni)) return { dni, error: err("dni_invalido", "Ingresá un DNI válido, solo números.") };
  const padron = await leerPadron(s);
  const socio = padron.socios[dni];
  if (!socio) return { dni, error: err("no_encontrado", "Ese DNI no figura en el padrón de socios.", 403) };
  if (!socio.a) return { dni, error: json({ ok: false, codigo: "inactivo", nombre: socio.n, mensaje: "Figurás en el padrón, pero no como socio activo." }, 403) };
  return { dni, socio };
}

function esAdmin(req) {
  const clave = Netlify.env.get("ADMIN_PASSWORD");
  const enviada = req.headers.get("x-admin-password") || "";
  if (!clave || enviada.length !== clave.length) return false;
  let diff = 0;
  for (let i = 0; i < clave.length; i++) diff |= clave.charCodeAt(i) ^ enviada.charCodeAt(i);
  return diff === 0;
}

async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

// ---------- Rutas públicas ----------
async function ingresar(req, s) {
  const { dni } = await body(req);
  const v = await socioActivo(s, dni);
  if (v.error) return v.error;
  await s.set(`presentes/${v.dni}`, "1", { onlyIfNew: true });
  return json({ ok: true, nombre: v.socio.n });
}

async function estado(req, s) {
  const dni = new URL(req.url).searchParams.get("dni");
  const v = await socioActivo(s, dni);
  if (v.error) return v.error;
  const { lista } = await leerMociones(s);
  // Los socios solo ven la consigna que la mesa habilitó (abierta); nunca resultados.
  const out = [];
  for (const [i, m] of lista.entries()) {
    if (m.estado !== "abierta") continue;
    const ya = (await s.getMetadata(`voto-dni/${m.id}/${v.dni}`)) !== null;
    out.push({ id: m.id, numero: i + 1, titulo: m.titulo, detalle: m.detalle, estado: m.estado, opciones: opcionesDe(m), yaVoto: ya });
  }
  return json({ ok: true, nombre: v.socio.n, mociones: out });
}

async function votar(req, s) {
  const { dni, mocion, opcion } = await body(req);
  const v = await socioActivo(s, dni);
  if (v.error) return v.error;
  const { lista } = await leerMociones(s);
  const m = lista.find((x) => x.id === mocion);
  if (!m) return err("sin_mocion", "Esa consigna ya no existe.", 404);
  if (m.estado !== "abierta") return err("cerrada", "La votación de esta consigna no está abierta.", 409);
  if (!opcionesDe(m).some((o) => o.id === opcion)) return err("opcion_invalida", "Esa opción no corresponde a esta consigna.");
  await s.set(`presentes/${v.dni}`, "1", { onlyIfNew: true });
  const claveVoto = `voto-dni/${m.id}/${v.dni}`;
  if ((await s.getMetadata(claveVoto)) !== null) return err("ya_voto", "Ya registraste tu voto en esta consigna.", 409);
  const marca = await s.set(claveVoto, "1", { onlyIfNew: true });
  if (marca && marca.modified === false) return err("ya_voto", "Ya registraste tu voto en esta consigna.", 409);
  try {
    await s.set(`boletas/${m.id}/${opcion}/${rid()}`, "1");
  } catch (e) {
    await s.delete(`voto-dni/${m.id}/${v.dni}`);
    throw e;
  }
  return json({ ok: true });
}

// Lista pública de consignas (sin datos de socios). La CDN la cachea 4 s,
// así cientos de celulares consultando no disparan cientos de ejecuciones.
async function mocionesPublicas(s) {
  const { lista } = await leerMociones(s);
  const out = lista
    .map((m, i) => ({ id: m.id, numero: i + 1, titulo: m.titulo, detalle: m.detalle, estado: m.estado, opciones: opcionesDe(m) }))
    .filter((m) => m.estado === "abierta");
  return new Response(JSON.stringify({ ok: true, mociones: out, hora: Date.now() }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      "netlify-cdn-cache-control": "public, s-maxage=4, stale-while-revalidate=4",
    },
  });
}

// ---------- Rutas de administración ----------
async function adminResumen(s) {
  const padron = await leerPadron(s);
  const socios = Object.values(padron.socios);
  const presentes = (await contar(s, "presentes/")).length;
  const { lista } = await leerMociones(s);
  const mociones = [];
  for (const m of lista) {
    const votantes = (await contar(s, `voto-dni/${m.id}/`)).length;
    mociones.push({ ...m, votantes, opciones: opcionesDe(m), resultados: await resultados(s, m) });
  }
  return json({
    ok: true,
    padron: { actualizado: padron.actualizado, total: socios.length, activos: socios.filter((x) => x.a).length },
    presentes,
    mociones,
  });
}

async function adminPadronGuardar(req, s) {
  const { socios } = await body(req);
  if (!Array.isArray(socios) || !socios.length) return err("vacio", "El padrón está vacío.");
  const mapa = {};
  for (const x of socios) {
    const d = limpiarDni(x.dni);
    if (!dniValido(d)) continue;
    mapa[d] = { n: String(x.nombre || "").trim().slice(0, 120), a: !!x.activo };
  }
  const total = Object.keys(mapa).length;
  if (!total) return err("vacio", "No se encontró ningún DNI válido.");
  await s.setJSON("padron", { actualizado: new Date().toISOString(), socios: mapa });
  return json({ ok: true, total });
}

async function adminPadronBuscar(req, s) {
  const q = new URL(req.url).searchParams.get("q") || "";
  const padron = await leerPadron(s);
  const dq = limpiarDni(q);
  const sinAcentos = (t) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const tq = sinAcentos(q.trim());
  const res = [];
  for (const [dni, x] of Object.entries(padron.socios)) {
    if ((dq && dni.includes(dq)) || (tq.length > 2 && sinAcentos(x.n).includes(tq))) {
      res.push({ dni, nombre: x.n, activo: x.a, presente: (await s.getMetadata(`presentes/${dni}`)) !== null });
      if (res.length >= 20) break;
    }
  }
  return json({ ok: true, resultados: res });
}

async function adminMocionCrear(req, s) {
  const { titulo, detalle, tipo, opciones, abstencion } = await body(req);
  if (!String(titulo || "").trim()) return err("sin_titulo", "Escribí la consigna a votar.");
  const esOpc = tipo === "opciones";
  const ops = esOpc ? limpiarOpciones(opciones) : [];
  if (esOpc && ops.length < 2) return err("pocas_opciones", "Cargá al menos dos opciones.");
  for (let i = 0; i < 3; i++) {
    const { lista, etag } = await leerMociones(s);
    lista.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      titulo: String(titulo).trim().slice(0, 300),
      detalle: String(detalle || "").trim().slice(0, 2000),
      estado: "borrador",
      publicar: false,
      tipo: esOpc ? "opciones" : "sino",
      opciones: ops,
      abstencion: esOpc ? abstencion !== false : true,
      creada: new Date().toISOString(),
    });
    if (await guardarMociones(s, lista, etag)) return json({ ok: true });
  }
  return err("conflicto", "Otra persona modificó las consignas. Probá de nuevo.", 409);
}

async function adminMocionEditar(req, s, id) {
  const cambios = await body(req);
  for (let i = 0; i < 3; i++) {
    const { lista, etag } = await leerMociones(s);
    const m = lista.find((x) => x.id === id);
    if (!m) return err("sin_mocion", "No existe esa consigna.", 404);
    if (cambios.estado && ["borrador", "abierta", "cerrada"].includes(cambios.estado)) m.estado = cambios.estado;
    if (typeof cambios.publicar === "boolean") m.publicar = cambios.publicar;
    if (typeof cambios.titulo === "string" && cambios.titulo.trim()) m.titulo = cambios.titulo.trim().slice(0, 300);
    if (typeof cambios.detalle === "string") m.detalle = cambios.detalle.trim().slice(0, 2000);
    if (m.estado === "borrador" && m.tipo === "opciones" && Array.isArray(cambios.opciones)) {
      const ops = limpiarOpciones(cambios.opciones);
      if (ops.length < 2) return err("pocas_opciones", "Cargá al menos dos opciones.");
      m.opciones = ops;
    }
    if (m.estado === "borrador" && m.tipo === "opciones" && typeof cambios.abstencion === "boolean") m.abstencion = cambios.abstencion;
    if (typeof cambios.mover === "number") {
      const j = lista.indexOf(m), k = j + cambios.mover;
      if (k >= 0 && k < lista.length) { lista.splice(j, 1); lista.splice(k, 0, m); }
    }
    if (await guardarMociones(s, lista, etag)) return json({ ok: true });
  }
  return err("conflicto", "Otra persona modificó las consignas. Probá de nuevo.", 409);
}

async function adminMocionBorrar(s, id) {
  for (let i = 0; i < 3; i++) {
    const { lista, etag } = await leerMociones(s);
    const resto = lista.filter((x) => x.id !== id);
    if (resto.length === lista.length) return err("sin_mocion", "No existe esa consigna.", 404);
    if (await guardarMociones(s, resto, etag)) {
      for (const k of [...(await contar(s, `boletas/${id}/`)), ...(await contar(s, `voto-dni/${id}/`))]) await s.delete(k);
      return json({ ok: true });
    }
  }
  return err("conflicto", "Otra persona modificó las consignas. Probá de nuevo.", 409);
}

async function adminReiniciarPresentes(s) {
  for (const k of await contar(s, "presentes/")) await s.delete(k);
  return json({ ok: true });
}

export default async (req) => {
  const s = store();
  const path = new URL(req.url).pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const metodo = req.method;
  try {
    if (path === "ingresar" && metodo === "POST") return await ingresar(req, s);
    if (path === "estado" && metodo === "GET") return await estado(req, s);
    if (path === "votar" && metodo === "POST") return await votar(req, s);
    if (path === "mociones" && metodo === "GET") return await mocionesPublicas(s);

    if (path.startsWith("admin")) {
      if (!esAdmin(req)) return err("no_autorizado", "Contraseña incorrecta.", 401);
      if (path === "admin/login") return json({ ok: true });
      if (path === "admin/resumen" && metodo === "GET") return await adminResumen(s);
      if (path === "admin/padron" && metodo === "PUT") return await adminPadronGuardar(req, s);
      if (path === "admin/padron/buscar" && metodo === "GET") return await adminPadronBuscar(req, s);
      if (path === "admin/presentes" && metodo === "DELETE") return await adminReiniciarPresentes(s);
      if (path === "admin/mociones" && metodo === "POST") return await adminMocionCrear(req, s);
      const m = path.match(/^admin\/mociones\/([a-z0-9]+)$/);
      if (m && metodo === "PATCH") return await adminMocionEditar(req, s, m[1]);
      if (m && metodo === "DELETE") return await adminMocionBorrar(s, m[1]);
    }
    return err("no_existe", "Ruta inexistente.", 404);
  } catch (e) {
    console.error(e);
    return err("error_servidor", "Hubo un problema en el servidor. Probá de nuevo en unos segundos.", 500);
  }
};

export const config = { path: "/api/*" };
