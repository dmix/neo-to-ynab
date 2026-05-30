#!/usr/bin/env node
"use strict";

/*
 * neo-to-ynab
 * Convert a Neo Financial CSV export into a YNAB-ready import file.
 *
 * Neo export columns:  Transaction Date, Posted Date, Status, Description, Amount
 * YNAB import columns:  Date, Payee, Memo, Amount
 *
 * Neo's Amount is already signed the way YNAB wants (outflows negative,
 * inflows positive), so it is passed straight through.
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// CSV parse / stringify (RFC-4180-ish: handles quoted fields, "" escapes,
// and commas / newlines inside quotes).
// ---------------------------------------------------------------------------

function parseCSV(text) {
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
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // ignore; newline handled on \n
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
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

function toCSV(rows) {
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const HELP = `
neo-to-ynab — convert a Neo Financial CSV export into a YNAB import file

Usage:
  node convert.js <input.csv> [options]

Options:
  -o, --output <path>     Output file (default: <input>_YNAB.csv, next to the input)
      --skip-pending      Exclude "Pending" transactions
      --keep-pending      Include "Pending" transactions          (default)
      --skip-declined     Exclude "Declined" transactions         (default)
      --keep-declined     Include "Declined" transactions
      --posted-only       Keep only "Posted" rows (= --skip-pending --skip-declined)
      --memo-status       Write the Neo status into the YNAB Memo for non-Posted rows
  -h, --help              Show this help

Defaults: Declined rows are dropped (they never charged the account); Pending
rows are kept (they are real spending — YNAB de-duplicates when they later post).

Examples:
  node convert.js ~/Downloads/EverydaySpending.csv
  node convert.js ~/Downloads/EverydaySpending.csv --posted-only
  node convert.js ~/Downloads/EverydaySpending.csv --skip-pending -o ~/Desktop/out.csv
`;

function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    pending: "keep", // keep | skip
    declined: "skip", // keep | skip
    memoStatus: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "-o":
      case "--output":
        opts.output = argv[++i];
        break;
      case "--skip-pending":
        opts.pending = "skip";
        break;
      case "--keep-pending":
        opts.pending = "keep";
        break;
      case "--skip-declined":
        opts.declined = "skip";
        break;
      case "--keep-declined":
        opts.declined = "keep";
        break;
      case "--posted-only":
        opts.pending = "skip";
        opts.declined = "skip";
        break;
      case "--memo-status":
        opts.memoStatus = true;
        break;
      default:
        if (a.startsWith("-")) {
          opts.error = `Unknown option: ${a}`;
        } else if (opts.input === null) {
          opts.input = a;
        } else {
          opts.error = `Unexpected argument: ${a}`;
        }
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Amount cleanup — defensive: strip currency symbol, spaces, thousands commas.
// (Neo exports plain dotted decimals, but this keeps us safe.)
// ---------------------------------------------------------------------------

function cleanAmount(raw) {
  return raw.replace(/[$\s]/g, "").replace(/,/g, "").trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function findColumn(header, names) {
  const lower = header.map((h) => h.trim().toLowerCase());
  for (const n of names) {
    const idx = lower.indexOf(n.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || (!opts.input && process.argv.length <= 2)) {
    process.stdout.write(HELP);
    process.exit(opts.help ? 0 : 1);
  }
  if (opts.error) {
    console.error(opts.error + "\n" + HELP);
    process.exit(1);
  }
  if (!opts.input) {
    console.error("Error: no input file given.\n" + HELP);
    process.exit(1);
  }
  if (!fs.existsSync(opts.input)) {
    console.error(`Error: file not found: ${opts.input}`);
    process.exit(1);
  }

  const output =
    opts.output ||
    path.join(
      path.dirname(opts.input),
      path.basename(opts.input, path.extname(opts.input)) + "_YNAB.csv",
    );

  const raw = fs.readFileSync(opts.input, "utf8").replace(/^﻿/, "");
  const rows = parseCSV(raw).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
  if (rows.length === 0) {
    console.error("Error: input file is empty.");
    process.exit(1);
  }

  const header = rows[0];
  const iDate = findColumn(header, ["Transaction Date", "Date"]);
  const iStatus = findColumn(header, ["Status"]);
  const iDesc = findColumn(header, ["Description", "Payee"]);
  const iAmount = findColumn(header, ["Amount"]);

  const missing = [];
  if (iDate === -1) missing.push("Transaction Date");
  if (iDesc === -1) missing.push("Description");
  if (iAmount === -1) missing.push("Amount");
  if (missing.length) {
    console.error(`Error: input is missing expected column(s): ${missing.join(", ")}`);
    console.error(`Found header: ${header.join(", ")}`);
    process.exit(1);
  }

  const out = [["Date", "Payee", "Memo", "Amount"]];
  const skipped = {};
  let kept = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const status = iStatus === -1 ? "" : (r[iStatus] || "").trim();

    if (status === "Pending" && opts.pending === "skip") {
      skipped.Pending = (skipped.Pending || 0) + 1;
      continue;
    }
    if (status === "Declined" && opts.declined === "skip") {
      skipped.Declined = (skipped.Declined || 0) + 1;
      continue;
    }

    const date = (r[iDate] || "").trim();
    const payee = (r[iDesc] || "").trim();
    const amount = cleanAmount(r[iAmount] || "");
    const memo = opts.memoStatus && status && status !== "Posted" ? status : "";

    out.push([date, payee, memo, amount]);
    kept++;
  }

  fs.writeFileSync(output, toCSV(out), "utf8");

  console.log(`Wrote ${kept} transaction(s) -> ${output}`);
  const skippedKeys = Object.keys(skipped);
  if (skippedKeys.length) {
    for (const k of skippedKeys.sort()) console.log(`  skipped ${skipped[k]} ${k}`);
  } else {
    console.log("  (no rows skipped)");
  }
}

main();
