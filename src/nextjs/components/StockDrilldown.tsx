"use client";

import useSWR from "swr";
import { companyDrilldown, type Drilldown } from "@/lib/companies";

function fmtMktCap(v: string | number | null): string {
  if (v === null) return "—";
  if (typeof v === "string") return `₹ ${v}`; // screener e.g. "721 Cr."
  return `₹ ${(v / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr.`;
}

function fmtMoney(v: number | null, digits = 0): string {
  if (v === null) return "—";
  return `₹ ${v.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function fmtHighLow(high: number | null, low: number | null): string {
  if (high === null && low === null) return "—";
  const h = high === null ? "—" : high.toLocaleString("en-IN");
  const l = low === null ? "—" : low.toLocaleString("en-IN");
  return `₹ ${h} / ${l}`;
}

function fmtNum(v: number | null): string {
  return v === null ? "—" : String(v);
}

function fmtHolding(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1)} %`;
}

// A quarter-over-quarter change: signed %, colour-coded (green up / red down).
function fmtChange(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(2)} %`;
}
function changeColor(v: number | null): string {
  if (v === null || v === 0) return "";
  return v > 0 ? "text-emerald-600" : "text-red-600";
}

function Tile({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div className="border border-neutral-200 px-2.5 py-1">
      <div className="text-xs leading-tight text-neutral-500">{label}</div>
      <div className={`text-lg font-medium leading-tight ${className}`}>{value}</div>
    </div>
  );
}

export default function StockDrilldown({ symbol }: { symbol: string }) {
  const { data, isValidating } = useSWR(["drilldown", symbol], () => companyDrilldown(symbol), {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

  const d: Partial<Drilldown> = data ?? {};
  const loadingFirst = isValidating && !data;

  return (
    <div>
      <h3 className="mb-1.5 text-base font-medium text-neutral-500">
        Stock Ratios
        {loadingFirst && " — loading…"}
        {data?.source === "nse" && " (NSE fallback — no screener page)"}
      </h3>
      <div className="grid grid-cols-2 gap-0.5 sm:grid-cols-3 lg:grid-cols-4">
        <Tile label="Market Cap" value={fmtMktCap(d.market_cap ?? null)} />
        <Tile label="Current Price" value={fmtMoney(d.current_price ?? null)} />
        <Tile label="High / Low" value={fmtHighLow(d.high ?? null, d.low ?? null)} />

        <Tile label="Stock P/E" value={fmtNum(d.stock_pe ?? null)} />
        <Tile label="Change in Prom Hold" value={fmtChange(d.promoter_change ?? null)} className={changeColor(d.promoter_change ?? null)} />
        <Tile label="EPS" value={fmtMoney(d.eps ?? null, 1)} />

        <Tile label="Chg in FII hold" value={fmtChange(d.fii_change ?? null)} className={changeColor(d.fii_change ?? null)} />
        <Tile label="Chg in DII hold" value={fmtChange(d.dii_change ?? null)} className={changeColor(d.dii_change ?? null)} />
        <Tile label="Public Holding" value={fmtHolding(d.public_pct ?? null)} />

        <Tile label="Chg in Prom Hold 3Yr" value={fmtChange(d.promoter_change_3yr ?? null)} className={changeColor(d.promoter_change_3yr ?? null)} />
        <Tile label="Promoter holding" value={fmtHolding(d.promoter_pct ?? null)} />
      </div>
      {data?.as_of && (
        <p className="mt-2 text-xs text-neutral-400">
          Shareholding as of {data.as_of}
          {data.since ? ` (3-yr change vs ${data.since})` : ""}. Source: screener.in.
        </p>
      )}
    </div>
  );
}
