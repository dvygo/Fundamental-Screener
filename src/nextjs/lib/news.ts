import { fetchJson } from "@/lib/api";

export interface NewsStock {
  symbol: string;
  company_name: string;
}

// One LiveMint "companies" article, tagged with the NSE stock(s) its headline
// names (empty for general/global news). See src/nodejs/src/news.js.
export interface NewsItem {
  title: string;
  link: string;
  description: string;
  published: string | null; // ISO
  image: string | null;
  symbols: NewsStock[];
}

export function fetchNews(): Promise<NewsItem[]> {
  return fetchJson("/news");
}
