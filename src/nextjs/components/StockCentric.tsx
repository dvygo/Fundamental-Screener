"use client";

import { useEffect, useRef, useState } from "react";
import useSWR, { type SWRConfiguration } from "swr";
import { toast } from "sonner";
import DataTable from "@/components/DataTable";
import StockDrilldown from "@/components/StockDrilldown";
import { Input } from "@/components/ui/input";
import { searchCompanies, companyInsider, companyShareholding, companyPromoters, listSeries, type CompanyMatch } from "@/lib/companies";

// On-demand screener fetches can fail transiently. Between screener.in and our
// own data the answer is always obtainable, so keep retrying every 1000ms
// (the widget/table shows loading until it arrives) instead of surfacing an error.
const ONDEMAND: SWRConfiguration = {
  revalidateOnFocus: false,
  shouldRetryOnError: true,
  errorRetryCount: 120,
  onErrorRetry: (_err, _key, _cfg, revalidate, { retryCount }) => {
    setTimeout(() => revalidate({ retryCount }), 1000);
  },
};

// Shown by default on first load so the page isn't empty.
const DEFAULT_STOCK: CompanyMatch = { symbol: "RELIANCE", company_name: "RELIANCE INDUSTRIES LTD", isin: "INE002A01018" };
const label = (m: CompanyMatch) => `${m.symbol} (${m.company_name}) (${m.isin})`;

export default function StockCentric() {
  const [query, setQuery] = useState(label(DEFAULT_STOCK));
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [series, setSeries] = useState("EQ");
  const [selected, setSelected] = useState<CompanyMatch | null>(DEFAULT_STOCK);
  const [showResults, setShowResults] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // Deep link from the Markets tables (?symbol=XYZ): resolve it to a full match
  // (for the name/ISIN label) and select it in place of the RELIANCE default.
  useEffect(() => {
    const sym = new URLSearchParams(window.location.search).get("symbol");
    if (!sym) return;
    const S = sym.toUpperCase();
    let cancelled = false;
    (async () => {
      let chosen: CompanyMatch = { symbol: S, company_name: S, isin: "" };
      try {
        const matches = await searchCompanies(S, "ALL");
        chosen = matches.find((m) => m.symbol.toUpperCase() === S) ?? matches[0] ?? chosen;
      } catch {
        /* keep the minimal fallback — drill-down/promoters only need the symbol */
      }
      if (cancelled) return;
      setSelected(chosen);
      setQuery(label(chosen));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const { data: seriesList } = useSWR("series", listSeries, { revalidateOnFocus: false });

  const { data: matches } = useSWR(
    debouncedQuery.length > 0 ? ["company-search", debouncedQuery, series] : null,
    () => searchCompanies(debouncedQuery, series),
  );

  function pick(m: CompanyMatch) {
    setSelected(m);
    setQuery(label(m));
    setShowResults(false);
  }

  // ↑/↓ move through suggestions, Enter selects, Esc closes.
  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") return setShowResults(false);
    if (!showResults || !matches || matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = matches[highlightIdx];
      if (m) pick(m);
    }
  }

  const {
    data: insiderRows,
    error: insiderError,
    isValidating: insiderValidating,
  } = useSWR(selected ? ["insider", selected.symbol] : null, () => companyInsider(selected!.symbol), ONDEMAND);

  const {
    data: shareholdingRows,
    error: shareholdingError,
    isValidating: shareholdingValidating,
  } = useSWR(selected ? ["shareholding", selected.symbol] : null, () => companyShareholding(selected!.symbol), ONDEMAND);

  const {
    data: promoterRows,
    error: promoterError,
    isValidating: promoterValidating,
  } = useSWR(selected ? ["promoters", selected.symbol] : null, () => companyPromoters(selected!.symbol), ONDEMAND);

  // Loading = actively fetching, OR errored while still without data (a retry is
  // pending) — so the overlay stays up across the 1000ms retry gaps until data lands.
  const insiderLoading = insiderValidating || (!!insiderError && insiderRows === undefined);
  const shareholdingLoading = shareholdingValidating || (!!shareholdingError && shareholdingRows === undefined);
  const promoterLoading = promoterValidating || (!!promoterError && promoterRows === undefined);

  const loadingShown = useRef(false);
  const loading = insiderLoading || shareholdingLoading || promoterLoading;
  useEffect(() => {
    if (!selected) return;
    if (loading) {
      // Stable id "stock-centric": switching stocks reuses the one toast slot
      // (no duplicates); Infinity keeps it up for the whole fetch.
      toast.loading(`Fetching ${selected.symbol}…`, { id: "stock-centric", duration: Infinity });
      loadingShown.current = true;
      return;
    }
    if (!loadingShown.current) return;
    loadingShown.current = false;
    if (insiderError || shareholdingError) {
      toast.dismiss("stock-centric");
    } else {
      const total = (insiderRows?.length ?? 0) + (promoterRows?.length ?? 0);
      toast.success(`${selected.symbol} — ${total} rows`, { id: "stock-centric", duration: 1000 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, selected]);

  const current = shareholdingRows?.[0];
  const previous = shareholdingRows?.[1];
  const change =
    current && previous && typeof current.promoter_pct === "number" && typeof previous.promoter_pct === "number"
      ? Math.round((current.promoter_pct - previous.promoter_pct) * 100) / 100
      : null;

  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Stock Centric</h1>

      <div className="mb-6 mt-3 flex max-w-xl items-center gap-2">
        {/* Series filter — defaults to EQ; "All series" drops the filter. */}
        <select
          aria-label="Series"
          value={series}
          onChange={(e) => setSeries(e.target.value)}
          className="h-9 shrink-0 border border-neutral-300 bg-white px-2 text-base font-medium focus:outline-none focus:ring-1 focus:ring-neutral-400"
        >
          <option value="ALL">All series</option>
          {(seriesList ?? []).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="relative flex-1">
          <Input
            placeholder="Search symbol or company name…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShowResults(true);
              setHighlightIdx(0); // fresh results → highlight the top suggestion
            }}
            onKeyDown={onSearchKeyDown}
            // Re-clicking after a search selects the whole text so the next
            // keystroke replaces the previous stock instead of appending.
            onFocus={(e) => {
              setShowResults(true);
              if (selected) e.currentTarget.select();
            }}
          />
          {showResults && matches && matches.length > 0 && (
            <ul className="absolute z-10 mt-1 max-h-72 w-full overflow-auto border border-neutral-200 bg-white shadow-sm">
              {matches.map((m, i) => (
                <li
                  key={`${m.symbol}-${m.isin}`}
                  ref={i === highlightIdx ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                >
                  <button
                    className={`block w-full truncate px-3 py-2 text-left text-base ${
                      i === highlightIdx ? "bg-neutral-100" : ""
                    }`}
                    onMouseEnter={() => setHighlightIdx(i)}
                    onClick={() => pick(m)}
                  >
                    <span className="font-medium">{m.symbol}</span>{" "}
                    <span className="text-neutral-500">
                      ({m.company_name}) ({m.isin})
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {!selected && <p className="text-base text-neutral-400">Search for a stock to see its details.</p>}

      {selected && (
        <div className="flex flex-col gap-8">
          <StockDrilldown symbol={selected.symbol} />

          <div>
            <h3 className="mb-2 text-base font-medium text-neutral-500">
              Promoters {current ? `— ${current.promoter_pct}% total` : ""}
              {change !== null && (
                <span className={change >= 0 ? "text-emerald-600" : "text-red-600"}>
                  {" "}
                  ({change >= 0 ? "+" : ""}
                  {change} pp vs prior filing)
                </span>
              )}
            </h3>
            <DataTable
              rows={promoterRows ?? []}
              loading={promoterLoading}
              emptyMessage={
                current && current.promoter_pct === 0
                  ? "No promoters — the company is fully public"
                  : "No promoter data"
              }
            />
          </div>

          <div>
            <h3 className="mb-2 text-base font-medium text-neutral-500">Insider trading — qty &amp; value</h3>
            <DataTable rows={insiderRows ?? []} loading={insiderLoading} />
          </div>
        </div>
      )}
    </>
  );
}
