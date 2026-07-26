"use client";

import { useMemo } from "react";
import Link from "next/link";
import { AgGridReact } from "ag-grid-react";
import {
  ModuleRegistry,
  AllCommunityModule,
  themeQuartz,
  type ColDef,
  type ValueFormatterParams,
  type ICellRendererParams,
} from "ag-grid-community";
import type { Row } from "@/lib/screens";

ModuleRegistry.registerModules([AllCommunityModule]);

// DuckDB's JSON export sends BIGINT counts as numeric strings (lossless), so
// "is a number" has to cover both real numbers and pure-numeric strings.
// Dates ("2026-07-23") never match this - the embedded hyphens fail the regex.
const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

function isNumericValue(value: unknown): boolean {
  return typeof value === "number" || (typeof value === "string" && NUMERIC_STRING.test(value));
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : parseFloat(String(value));
}

// API dates are ISO ("2026-07-23") so lexical sort still works chronologically -
// only the display gets reformatted, not the underlying value used for sorting.
const DATE_STRING = /^\d{4}-\d{2}-\d{2}$/;

function isDateValue(value: unknown): boolean {
  return typeof value === "string" && DATE_STRING.test(value);
}

function toDDMMYY(value: string): string {
  const [y, m, d] = value.split("-");
  return `${d}-${m}-${y.slice(2)}`;
}

const theme = themeQuartz.withParams({
  accentColor: "#171717",
  borderColor: "#e5e5e5",
  headerTextColor: "#525252",
  rowHoverColor: "#f5f5f5",
  fontFamily: "inherit",
  fontSize: 15,
  borderRadius: 0,
  wrapperBorderRadius: 0,
  spacing: 4,
  rowHeight: 26,
  headerHeight: 30,
  cellHorizontalPadding: 8,
});

// header 30 + rows*26 + horizontal scrollbar 16. Show 10 data rows PLUS one
// buffer row so the always-visible horizontal scrollbar doesn't clip the last
// row (the trailing spacer column does the same for the vertical scrollbar).
const HEADER_PX = 30;
const ROW_PX = 26;
const SCROLLBAR_PX = 16;
const TABLE_PX = HEADER_PX + 11 * ROW_PX + SCROLLBAR_PX;

const LOADING_OVERLAY = `
  <div class="fs-overlay">
    <div class="fs-progress"><div class="fs-progress-bar"></div></div>
    <div class="fs-overlay-text">Loading…</div>
  </div>
`;
const noRowsOverlay = (msg: string) => `<div class="fs-overlay-text">${msg}</div>`;

// A blank, unmovable trailing column so the always-visible vertical scrollbar
// overlaps empty space instead of the last real column's values.
const SPACER_COL: ColDef = {
  colId: "__spacer",
  headerName: "",
  valueGetter: () => "",
  width: 22,
  minWidth: 22,
  maxWidth: 22,
  resizable: false,
  sortable: false,
  filter: false,
  suppressAutoSize: true,
  suppressHeaderMenuButton: true,
};

// Symbol cell with a small ↗ that opens the stock in Stock Centric. Rendered
// only when the caller opts in (linkSymbol) — e.g. the Markets tables. The empty
// trailing spacer row has no symbol, so it renders nothing.
function SymbolCell(params: ICellRendererParams) {
  const symbol = params.value;
  if (typeof symbol !== "string" || !symbol) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <span>{symbol}</span>
      <Link
        href={`/stock-centric?symbol=${encodeURIComponent(symbol)}`}
        aria-label={`Open ${symbol} in Stock Centric`}
        title={`Open ${symbol} in Stock Centric`}
        className="text-neutral-400 transition-colors hover:text-neutral-900"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="inline align-[-1px]"
          aria-hidden="true"
        >
          <path d="M7 17 17 7" />
          <path d="M8 7h9v9" />
        </svg>
      </Link>
    </span>
  );
}

// "event_date" -> "Event Date", "high_52w" -> "High 52w" — readable headers from
// the snake_case API keys.
const humanize = (field: string) => field.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function buildColumns(rows: Row[], linkSymbol: boolean): ColDef[] {
  const cols = Object.keys(rows[0]).map((field) => {
    const sample = rows.find((r) => r[field] !== null && r[field] !== undefined)?.[field];
    const numeric = sample !== undefined && isNumericValue(sample);
    const date = !numeric && sample !== undefined && isDateValue(sample);

    const colDef: ColDef = {
      field,
      headerName: humanize(field),
      sortable: true,
      filter: true,
      resizable: true,
      minWidth: 110,
    };
    if (numeric) {
      colDef.type = "numericColumn";
      colDef.comparator = (a, b) => toNumber(a) - toNumber(b);
      colDef.valueFormatter = (params: ValueFormatterParams) => {
        if (params.value === null || params.value === undefined || params.value === "") return "";
        const n = toNumber(params.value);
        if (!Number.isFinite(n)) return String(params.value);
        // Whole numbers (scores, counts, event tallies) render clean; only
        // genuinely fractional values (prices, %) keep two decimals.
        return Number.isInteger(n) ? String(n) : n.toFixed(2);
      };
    } else if (date) {
      // Sort on the raw ISO value, not the displayed DD-MM-YY string - lexical
      // sort on DD-MM-YY would group by day-of-month first, not chronologically.
      colDef.comparator = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
      colDef.valueFormatter = (params: ValueFormatterParams) => {
        if (params.value === null || params.value === undefined || params.value === "") return "";
        return isDateValue(params.value) ? toDDMMYY(params.value) : String(params.value);
      };
    }
    if (linkSymbol && field === "symbol") colDef.cellRenderer = SymbolCell;
    return colDef;
  });
  cols.push(SPACER_COL);
  return cols;
}

export default function DataTable({
  rows,
  loading,
  fill = false,
  emptyMessage = "No rows",
  linkSymbol = false,
}: {
  rows: Row[];
  loading: boolean;
  fill?: boolean;
  emptyMessage?: string;
  /** Render the `symbol` column with a ↗ link into Stock Centric. */
  linkSymbol?: boolean;
}) {
  // The grid shell (headers + fixed height) always renders, with the loading
  // overlay on top. Callers pass keepPreviousData SWR data, so `rows` stays
  // populated across param-change refetches - columns only go empty on the
  // very first load, where the overlay covers the empty box anyway.
  const columnDefs = useMemo<ColDef[]>(
    () => (rows.length === 0 ? [] : buildColumns(rows, linkSymbol)),
    [rows, linkSymbol],
  );

  // Append one empty row (paired with the __spacer column) so the always-visible
  // scrollbars overlap the blank row/column instead of real data.
  const rowData = useMemo<Row[]>(() => (rows.length === 0 ? rows : [...rows, {}]), [rows]);

  // Default: exactly ten rows tall, internal scroll. `fill` instead grows to
  // consume the parent flex column's remaining height (full-page tables) -
  // min-h-0 lets the grid shrink so its own body scrolls rather than the page.
  return (
    <div style={fill ? undefined : { height: TABLE_PX }} className={fill ? "w-full min-h-0 flex-1" : "w-full"}>
      <AgGridReact
        theme={theme}
        rowData={rowData}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, filter: true, resizable: true }}
        autoSizeStrategy={{ type: "fitCellContents", defaultMaxWidth: 400 }}
        alwaysShowHorizontalScroll
        alwaysShowVerticalScroll
        animateRows
        loading={loading}
        overlayLoadingTemplate={LOADING_OVERLAY}
        overlayNoRowsTemplate={noRowsOverlay(emptyMessage)}
      />
    </div>
  );
}
