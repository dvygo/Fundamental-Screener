"use client";

import { useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import { ModuleRegistry, AllCommunityModule, themeQuartz, type ColDef, type ValueFormatterParams } from "ag-grid-community";
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

// header 30 + 10 rows * 26 + horizontal scrollbar 16 = exactly ten rows visible.
const TEN_ROWS_PX = 30 + 10 * 26 + 16;

const LOADING_OVERLAY = `
  <div class="fs-overlay">
    <div class="fs-progress"><div class="fs-progress-bar"></div></div>
    <div class="fs-overlay-text">Loading…</div>
  </div>
`;
const NO_ROWS_OVERLAY = `<div class="fs-overlay-text">No rows</div>`;

function buildColumns(rows: Row[]): ColDef[] {
  return Object.keys(rows[0]).map((field) => {
    const sample = rows.find((r) => r[field] !== null && r[field] !== undefined)?.[field];
    const numeric = sample !== undefined && isNumericValue(sample);
    const date = !numeric && sample !== undefined && isDateValue(sample);

    const colDef: ColDef = {
      field,
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
        return Number.isFinite(n) ? n.toFixed(2) : String(params.value);
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
    return colDef;
  });
}

export default function DataTable({ rows, loading }: { rows: Row[]; loading: boolean }) {
  // The grid shell (headers + fixed height) always renders, with the loading
  // overlay on top. Callers pass keepPreviousData SWR data, so `rows` stays
  // populated across param-change refetches - columns only go empty on the
  // very first load, where the overlay covers the empty box anyway.
  const columnDefs = useMemo<ColDef[]>(() => (rows.length === 0 ? [] : buildColumns(rows)), [rows]);

  return (
    <div style={{ height: TEN_ROWS_PX }} className="w-full">
      <AgGridReact
        theme={theme}
        rowData={rows}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, filter: true, resizable: true }}
        autoSizeStrategy={{ type: "fitCellContents", defaultMaxWidth: 400 }}
        alwaysShowHorizontalScroll
        alwaysShowVerticalScroll
        animateRows
        loading={loading}
        overlayLoadingTemplate={LOADING_OVERLAY}
        overlayNoRowsTemplate={NO_ROWS_OVERLAY}
      />
    </div>
  );
}
