# neo-to-ynab

A tiny, dependency-free Node CLI that converts a **Neo Financial** CSV export into a
**YNAB** (You Need A Budget) file-based import.

## Why

Neo exports columns YNAB's importer doesn't recognise:

```
Transaction Date, Posted Date, Status, Description, Amount
```

The two date columns plus `Status` confuse YNAB's auto-mapper, so the import is
rejected. This tool rewrites the file into the layout YNAB expects:

```
Date, Payee, Memo, Amount
```

Neo's `Amount` is already signed the way YNAB wants (outflows negative, inflows
positive), so amounts pass straight through.

## Requirements

Node.js 14 or newer. No `npm install` needed — it uses only built-in modules.

## Usage

```bash
node convert.js <input.csv> [options]
```

The converted file is written next to the input as `<input>_YNAB.csv` unless you
pass `-o`.

### Options

| Option                | Description                                                   |
| --------------------- | ------------------------------------------------------------- |
| `-o, --output <path>` | Output file path (default: `<input>_YNAB.csv`)                |
| `--skip-pending`      | Exclude `Pending` transactions                                |
| `--keep-pending`      | Include `Pending` transactions **(default)**                  |
| `--skip-declined`     | Exclude `Declined` transactions **(default)**                 |
| `--keep-declined`     | Include `Declined` transactions                               |
| `--posted-only`       | Keep only `Posted` rows (= `--skip-pending --skip-declined`)  |
| `--memo-status`       | Write the Neo status into the YNAB `Memo` for non-Posted rows |
| `-h, --help`          | Show help                                                     |

### Defaults

- **Declined** rows are **dropped** — they were rejected and never charged your
  account, so importing them would create phantom outflows and throw off your
  balance.
- **Pending** rows are **kept** — they're real spending. YNAB de-duplicates on
  import, so re-importing later (once they post) is safe. Use `--skip-pending`
  if you'd rather wait until they clear.

## Examples

```bash
# Recommended default (drops Declined, keeps Pending)
node convert.js ~/Downloads/EverydaySpending_2026-01-01_2026-05-30.csv

# Only fully-posted transactions
node convert.js ~/Downloads/EverydaySpending.csv --posted-only

# Drop pending, choose the output name
node convert.js ~/Downloads/EverydaySpending.csv --skip-pending -o ~/Desktop/ynab.csv
```

Sample output:

```
Wrote 509 transaction(s) -> /Users/you/Downloads/EverydaySpending_YNAB.csv
  skipped 26 Declined
```

## Importing into YNAB

1. In YNAB, open the target account.
2. **Edit → Import** (or drag the `_YNAB.csv` file onto the account).
3. Confirm the `Date` / `Payee` / `Amount` mapping.
4. Review and import. YNAB skips duplicates automatically.

## Note on transfers

Some Neo rows are internal transfers (e.g. `Transfer to High-Interest account`,
`Payment to Credit`, credit-card payments). If you also track those accounts in
YNAB, categorise them as **transfers** after import so they aren't double-counted
as spending.

## Optionally install as a command

```bash
cd neo-to-ynab
npm link            # makes `neo-to-ynab` available on your PATH
neo-to-ynab ~/Downloads/EverydaySpending.csv
```

## Formatting

Code is formatted with [oxfmt](https://oxc.rs/docs/guide/usage/formatter) using
its defaults (no config file).

```bash
npm install         # one-time, installs the oxfmt dev dependency
npm run format        # format in place
npm run format:check  # verify formatting without writing (CI-friendly)
```
