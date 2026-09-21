import pg from "pg";
import fs from "fs";
import { config } from "dotenv";

config();

const DB = {
  host: process.env.SUPABASE_DB_HOST,
  port: process.env.SUPABASE_DB_PORT || 5432,
  database: process.env.SUPABASE_DB_NAME || "postgres",
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
};

const norm = (s) =>
  String(s || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

const LAB_NOISE = new Set([
  "LABORATORIOS", "LABORATORIO", "LAB", "LABS", "INTERNATIONAL", "INTL", "C.A", "CA", "C.A.", "C.A.V", "C.A.V.", "CAV",
  "S.A", "SA", "S.A.", "S.A.V", "S.A.V.", "SAV", "S.R.L", "SRL", "S.R.L.", "VENEZOLANOS", "VENEZOLANA", "VENEZOLANOS",
  "VENEZOLANAS", "VENEZUELA", "VENEZOLANO", "DE", "DEL", "LOS", "LAS", "Y", "E", "C", "C", "C.A.V", "COMERCIAL",
  "COMERCIALIZADORA", "DISTRIBUIDORA", "PRODUCTORA", "PRODUCTOS", "FARMACEUTICOS", "FARMACEUTICAS", "FARMACEUTICA",
  "INTERNACIONAL", "INTL", "S.A.S", "SRL", "SAV", "C.A.V."
]);

const tokenLab = (s) =>
  norm(s).split(/\s+/).filter((t) => t.length >= 3 && !LAB_NOISE.has(t));

const normNomb = (s) =>
  String(s || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

const parsearCSV = (txt) => {
  const filas = [];
  let fila = [], campo = "", citado = false;
  const cerrarCampo = () => { fila.push(campo); campo = ""; };
  const cerrarFila = () => { if (fila.length) { filas.push(fila); fila = []; } };
  let i = 0;
  while (i < txt.length) {
    const c = txt[i];
    if (citado) {
      if (c === '"') {
        const s = i + 1
        if (txt[s] === '"') { campo += '"'; i += 2; continue; }
        citado = false; i++; continue;
      }
      campo += c; i++;
    } else if (c === '"') { citado = true; i++; }
    else if (c === ",") { cerrarCampo(); i++; }
    else if (c === "\r") { i++; }
    else if (c === "\n") { cerrarCampo(); cerrarFila(); i++; }
    else { campo += c; i++; }
  }
  cerrarCampo(); cerrarFila();
  return filas;
};
main().catch((e) => { console.error(e); process.exit(1); });
