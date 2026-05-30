// Pure conversion logic for neo-to-ynab — no I/O beyond reading the source file,
// no CLI/UI concerns. Everything here is easy to unit-test in isolation.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Thrown for expected, user-facing problems (bad path, missing columns, …). */
export class UserError extends Error {}

export const STATUS = { PENDING: "Pending", DECLINED: "Declined", POSTED: "Posted" };

// --- CSV parse / stringify (RFC-4180-ish: quoted fields, "" escapes, embedded
// commas and newlines). Single pass, O(n). ---------------------------------

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // ignore; newline is handled on \n
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvField(v) {
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

export function toCSV(rows) {
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

// --- Helpers ---------------------------------------------------------------

/** Strip currency symbols, spaces and thousands separators; keep sign + decimal. */
export function cleanAmount(raw) {
  return raw.replace(/[$\s]/g, "").replace(/,/g, "").trim();
}

function findColumn(headerLower, names) {
  for (const n of names) {
    const idx = headerLower.indexOf(n.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

/** Expand `~`, drop surrounding quotes, and unescape drag-and-drop spaces. */
export function normalizePath(input) {
  let s = String(input).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  s = s.replace(/\\ /g, " ");
  if (s === "~") return os.homedir();
  if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** `/path/Foo.csv` -> `/path/Foo_YNAB.csv` */
export function defaultOutputPath(input) {
  const dir = path.dirname(input);
  const base = path.basename(input, path.extname(input));
  return path.join(dir, `${base}_YNAB.csv`);
}

/** Read a CSV file as text, stripping a UTF-8 BOM. Throws UserError if missing. */
export function readCsv(file) {
  if (!fs.existsSync(file)) throw new UserError(`File not found: ${file}`);
  return fs.readFileSync(file, "utf8").replace(/^﻿/, "");
}

// --- Core conversion -------------------------------------------------------

/**
 * Convert Neo CSV text into YNAB CSV text.
 *
 * @param {string} text  Raw Neo export contents.
 * @param {{pending?: "keep"|"skip", declined?: "keep"|"skip", memoStatus?: boolean}} options
 * @returns {{csv: string, kept: number, skipped: Record<string, number>, total: number}}
 */
export function convert(text, { pending = "keep", declined = "skip", memoStatus = false } = {}) {
  const rows = parseCSV(text).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
  if (rows.length === 0) throw new UserError("The file is empty.");

  const header = rows[0];
  const headerLower = header.map((h) => h.trim().toLowerCase());
  const iDate = findColumn(headerLower, ["Transaction Date", "Date"]);
  const iStatus = findColumn(headerLower, ["Status"]);
  const iDesc = findColumn(headerLower, ["Description", "Payee"]);
  const iAmount = findColumn(headerLower, ["Amount"]);

  const missing = [];
  if (iDate === -1) missing.push("Transaction Date");
  if (iDesc === -1) missing.push("Description");
  if (iAmount === -1) missing.push("Amount");
  if (missing.length) {
    throw new UserError(
      `Missing expected column(s): ${missing.join(", ")}.\n` + `Found header: ${header.join(", ")}`,
    );
  }

  const out = [["Date", "Payee", "Memo", "Amount"]];
  const skipped = {};
  let kept = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const status = iStatus === -1 ? "" : (r[iStatus] || "").trim();

    if (status === STATUS.PENDING && pending === "skip") {
      skipped.Pending = (skipped.Pending || 0) + 1;
      continue;
    }
    if (status === STATUS.DECLINED && declined === "skip") {
      skipped.Declined = (skipped.Declined || 0) + 1;
      continue;
    }

    out.push([
      (r[iDate] || "").trim(),
      (r[iDesc] || "").trim(),
      memoStatus && status && status !== STATUS.POSTED ? status : "",
      cleanAmount(r[iAmount] || ""),
    ]);
    kept++;
  }

  return { csv: toCSV(out), kept, skipped, total: rows.length - 1 };
}
