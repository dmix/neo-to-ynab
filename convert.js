#!/usr/bin/env node
// neo-to-ynab — convert a Neo Financial CSV export into a YNAB import file.
//
// Two ways to run:
//   • Headless:    node convert.js <input.csv> [options]   (scriptable)
//   • Interactive: node convert.js                          (prompts you, TTY only)
//                  node convert.js -i

import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { UserError, convert, defaultOutputPath, normalizePath, readCsv } from "./core.js";

const HELP = `
${pc.bold("neo-to-ynab")} — convert a Neo Financial CSV export into a YNAB import file

${pc.bold("Usage:")}
  node convert.js <input.csv> [options]
  node convert.js                 ${pc.dim("# interactive wizard (in a terminal)")}

${pc.bold("Options:")}
  -o, --output <path>     Output file (default: <input>_YNAB.csv, next to the input)
  -i, --interactive       Force the interactive wizard
      --skip-pending      Exclude "Pending" transactions
      --keep-pending      Include "Pending" transactions          ${pc.dim("(default)")}
      --skip-declined     Exclude "Declined" transactions         ${pc.dim("(default)")}
      --keep-declined     Include "Declined" transactions
      --posted-only       Keep only "Posted" rows (= --skip-pending --skip-declined)
      --memo-status       Write the Neo status into the YNAB Memo for non-Posted rows
  -h, --help              Show this help

${pc.dim("Defaults: Declined rows are dropped (they never charged the account); Pending")}
${pc.dim("rows are kept (real spending — YNAB de-duplicates when they later post).")}

${pc.bold("Examples:")}
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
    interactive: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "-i":
      case "--interactive":
        opts.interactive = true;
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
        if (a.startsWith("-")) opts.error = `Unknown option: ${a}`;
        else if (opts.input === null) opts.input = a;
        else opts.error = `Unexpected argument: ${a}`;
    }
  }
  return opts;
}

// --- Shared helpers --------------------------------------------------------

function guardOverwrite(input, output) {
  if (path.resolve(input) === path.resolve(output)) {
    throw new UserError("That output would overwrite the input file. Choose a different path.");
  }
}

/** Human wording for which statuses are being dropped. */
function droppedSummary(skipped) {
  const entries = Object.entries(skipped);
  if (entries.length === 0) return null;
  return entries.map(([status, n]) => `${n} ${status}`).join(", ");
}

function logError(message) {
  console.error(`${pc.red("✖")} ${message}`);
}

/** Colored end-of-run summary for the headless path. */
function logSummary(result, input, output) {
  const dropped = droppedSummary(result.skipped);
  console.log();
  console.log(`${pc.bold(pc.cyan("neo-to-ynab"))} ${pc.dim("· Neo Financial → YNAB")}`);
  console.log();
  console.log(
    `  ${pc.green("✓")} Converted ${pc.bold(result.kept)} of ${result.total} transactions`,
  );
  console.log(
    `  ${dropped ? pc.yellow("–") : pc.dim("–")} ${dropped ? `Dropped ${dropped}` : "Nothing dropped"}`,
  );
  console.log();
  console.log(`  ${pc.dim("source")}  ${input}`);
  console.log(`  ${pc.dim("output")}  ${pc.cyan(output)}`);
  console.log();
  console.log(pc.dim("  Amounts pass through unchanged — Neo already signs outflows negative."));
  console.log(pc.dim("  Next: open the account in YNAB → Edit → Import → pick this file."));
  console.log();
}

// --- Headless run ----------------------------------------------------------

function runHeadless(opts) {
  const input = normalizePath(opts.input);
  const output = opts.output ? normalizePath(opts.output) : defaultOutputPath(input);
  guardOverwrite(input, output);

  const result = convert(readCsv(input), {
    pending: opts.pending,
    declined: opts.declined,
    memoStatus: opts.memoStatus,
  });
  fs.writeFileSync(output, result.csv);
  logSummary(result, input, output);
}

// --- Interactive run (Clack) ----------------------------------------------

async function runInteractive(prefill) {
  const p = await import("@clack/prompts");

  const bail = (value) => {
    if (p.isCancel(value)) {
      p.cancel("Cancelled — no file written.");
      process.exit(0);
    }
    return value;
  };

  p.intro(`${pc.bgCyan(pc.black(" neo-to-ynab "))} ${pc.dim("Neo Financial → YNAB")}`);

  const input = normalizePath(
    bail(
      await p.text({
        message: "Path to your Neo Financial CSV",
        placeholder: "~/Downloads/EverydaySpending_2026-01-01_2026-05-30.csv",
        initialValue: prefill.input ?? "",
        validate(value) {
          if (!value || !value.trim()) return "Please enter a file path.";
          if (!fs.existsSync(normalizePath(value))) return "No file found at that path.";
        },
      }),
    ),
  );

  const skipDeclined = bail(
    await p.confirm({
      message: "Skip Declined transactions? (rejected — they never charged you)",
      initialValue: prefill.declined !== "keep",
    }),
  );

  const skipPending = bail(
    await p.confirm({
      message: "Skip Pending transactions? (not fully cleared yet)",
      initialValue: prefill.pending === "skip",
    }),
  );

  let memoStatus = false;
  if (!(skipDeclined && skipPending)) {
    memoStatus = bail(
      await p.confirm({
        message: "Tag the kept non-Posted rows in the Memo column?",
        initialValue: Boolean(prefill.memoStatus),
      }),
    );
  }

  const output = normalizePath(
    bail(
      await p.text({
        message: "Save the converted file as",
        initialValue: defaultOutputPath(input),
      }),
    ),
  );

  const spin = p.spinner();
  spin.start("Converting");
  let result;
  try {
    guardOverwrite(input, output);
    result = convert(readCsv(input), {
      pending: skipPending ? "skip" : "keep",
      declined: skipDeclined ? "skip" : "keep",
      memoStatus,
    });
    fs.writeFileSync(output, result.csv);
  } catch (err) {
    spin.stop(pc.red("Conversion failed"));
    p.cancel(err instanceof UserError ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  spin.stop("Converted");

  const dropped = droppedSummary(result.skipped);
  p.note(
    [
      `${pc.green("Kept")}     ${pc.bold(result.kept)} of ${result.total} transactions`,
      `${dropped ? pc.yellow("Dropped") : pc.dim("Dropped")}  ${dropped ?? "nothing"}`,
      "",
      `${pc.dim("Output")}   ${pc.cyan(output)}`,
      "",
      pc.dim("Amounts pass through unchanged — Neo already signs outflows negative."),
    ].join("\n"),
    "Summary",
  );
  p.outro(pc.green("✓ Ready — import this file in YNAB (account → Edit → Import)."));
}

// --- Main ------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (opts.error) {
    logError(opts.error);
    process.stdout.write(HELP);
    process.exitCode = 1;
    return;
  }

  const wantInteractive = opts.interactive || (!opts.input && process.stdin.isTTY);
  if (wantInteractive) {
    await runInteractive(opts);
    return;
  }

  if (!opts.input) {
    process.stdout.write(HELP);
    process.exitCode = 1;
    return;
  }

  runHeadless(opts);
}

main().catch((err) => {
  logError(err instanceof UserError ? err.message : err.stack || String(err));
  process.exitCode = 1;
});
