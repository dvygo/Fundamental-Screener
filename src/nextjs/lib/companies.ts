import { fetchJson } from "@/lib/api";
import type { Row } from "@/lib/screens";

export interface CompanyMatch {
  symbol: string;
  company_name: string;
  isin: string;
}

export interface Drilldown {
  symbol: string;
  company_name: string | null;
  market_cap: string | number | null; // screener string ("721 Cr.") or NSE-fallback number
  current_price: number | null;
  high: number | null;
  low: number | null;
  stock_pe: number | null;
  eps: number | null;
  promoter_pct: number | null;
  promoter_change: number | null;
  promoter_change_3yr: number | null;
  fii_change: number | null;
  dii_change: number | null;
  public_pct: number | null;
  as_of: string | null;
  since: string | null;
  source: "screener" | "nse";
}

export function listSeries(): Promise<string[]> {
  return fetchJson(`/series`);
}

export function searchCompanies(q: string, series: string): Promise<CompanyMatch[]> {
  return fetchJson(`/companies?q=${encodeURIComponent(q)}&series=${encodeURIComponent(series)}`);
}

export function companyDrilldown(symbol: string): Promise<Drilldown | null> {
  return fetchJson(`/companies/${encodeURIComponent(symbol)}/drilldown`);
}

export function companyInsider(symbol: string): Promise<Row[]> {
  return fetchJson(`/companies/${encodeURIComponent(symbol)}/insider`);
}

export function companyShareholding(symbol: string): Promise<Row[]> {
  return fetchJson(`/companies/${encodeURIComponent(symbol)}/shareholding`);
}

// The promoter roster (screener's expanded "Promoters +"): one row per promoter
// entity, a column per quarter. null when the symbol has no screener page.
export function companyPromoters(symbol: string): Promise<Row[] | null> {
  return fetchJson(`/companies/${encodeURIComponent(symbol)}/promoters`);
}
