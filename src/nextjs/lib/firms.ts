import { fetchJson } from "@/lib/api";

// One row of the rupeevest fund-manager index — a pick-list entry for search.
export interface FundManager {
  manager: string;
  fund_house: string;
  n_schemes: number | null;
  n_stocks: number | null;
}

// A company surfaced by the full-text search, deduped across its matching docs.
export interface FirmCompany {
  symbol: string;
  company_name: string;
  url: string;
  matches: number;
  doc_type: string | null;
  date: string | null;
  snippet: string;
}

export interface FirmSearchResult {
  query: string;
  total: number; // total matching documents (companies is the deduped subset)
  companies: FirmCompany[];
}

// A SEBI-registered firm (one of the four dropdowns). `search_term` is the
// distinctive brand to full-text search when picked ("Aequitas", not the full
// registered name).
export type FirmType = "pms" | "aif" | "amc" | "ria";
export interface Firm {
  name: string;
  type: FirmType;
  category: string | null;
  city: string | null;
  website: string | null;
  reg_no: string;
  search_term: string;
}

export function listFundManagers(): Promise<FundManager[]> {
  return fetchJson("/fund-managers");
}

export function listFirms(): Promise<Firm[]> {
  return fetchJson("/firms");
}

export function firmSearch(q: string): Promise<FirmSearchResult> {
  return fetchJson(`/firm-search?q=${encodeURIComponent(q)}`);
}
