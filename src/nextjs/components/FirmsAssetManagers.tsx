"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Input } from "@/components/ui/input";
import { firmSearch, listFirms, listFundManagers, type Firm, type FirmSearchResult, type FirmType } from "@/lib/firms";

// The four SEBI-firm dropdowns, in priority order.
const FIRM_DROPDOWNS: { type: FirmType; label: string }[] = [
  { type: "pms", label: "Portfolio Managers (PMS)" },
  { type: "aif", label: "Alternative Investment Funds (AIF)" },
  { type: "amc", label: "Mutual Fund AMCs" },
  { type: "ria", label: "Investment Advisers (RIA)" },
];

// Deep link into Stock Centric for a result company (same target as the Markets ↗).
const scHref = (symbol: string) => `/stock-centric?symbol=${encodeURIComponent(symbol)}`;

// Small ↗ marking a Stock Centric deep link.
function ScArrow() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="inline align-[-1px]"
    >
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

// Which pick-list a selection came from (the four firm types, or the fund
// managers). One selection is active at a time — picking in one dropdown resets
// the rest to their placeholder.
type PickSource = FirmType | "fm";

export default function FirmsAssetManagers() {
  // Default search so the tab isn't empty on load.
  const [query, setQuery] = useState("Franklin Templeton");
  const [submitted, setSubmitted] = useState("Franklin Templeton"); // the term actually searched
  const [pick, setPick] = useState<{ source: PickSource; value: string } | null>(null);
  const [compact, setCompact] = useState(true); // compact (just names) by default

  const { data: managers, error: managersError } = useSWR("fund-managers", listFundManagers, {
    revalidateOnFocus: false,
  });
  const { data: firms } = useSWR("firms", listFirms, { revalidateOnFocus: false });

  // Firms split into the four dropdown lists (already name-sorted by the API).
  const byType = useMemo(() => {
    const g: Record<FirmType, Firm[]> = { pms: [], aif: [], amc: [], ria: [] };
    for (const f of firms ?? []) g[f.type]?.push(f);
    return g;
  }, [firms]);

  const { data, error, isValidating, mutate } = useSWR<FirmSearchResult>(
    submitted ? ["firm-search", submitted] : null,
    () => firmSearch(submitted),
    // User-initiated search — don't auto-retry or revalidate; a Retry button
    // re-runs it on demand. keepPreviousData keeps the old list visible while
    // a new query loads.
    { revalidateOnFocus: false, shouldRetryOnError: false, keepPreviousData: true },
  );

  function run(term: string) {
    const t = term.trim();
    if (!t) return;
    // Re-running the same term keeps the SWR key unchanged, so force a refetch.
    if (t === submitted) mutate();
    else setSubmitted(t);
  }

  // Picking from any dropdown records which one is active (so the others reset to
  // their placeholder) and searches that entry's term.
  function pickFirm(type: FirmType, value: string) {
    if (!value) return;
    const f = byType[type][Number(value)];
    if (!f) return;
    setPick({ source: type, value });
    setQuery(f.search_term);
    run(f.search_term);
  }
  function pickManager(value: string) {
    if (!value) return;
    const m = (managers ?? [])[Number(value)];
    if (!m) return;
    setPick({ source: "fm", value });
    setQuery(m.manager);
    run(m.manager);
  }

  const companies = data?.companies ?? [];
  // With keepPreviousData, `data` still holds the previous query while a new one
  // loads, so gate "loading" on isValidating (the request is in flight), not on
  // an empty list — otherwise a second search would silently show stale results.
  const searching = isValidating && !error;

  // Full-height column: heading, subtitle, search box and the dropdowns stay
  // pinned at the top; only the results list below scrolls.
  return (
    <div className="flex h-full max-w-4xl flex-col">
      <h1 className="mb-1 shrink-0 text-2xl font-semibold">Firms &amp; Asset Managers</h1>
      <p className="mb-4 shrink-0 text-base text-neutral-500">
        Full-text search across screener.in filings, announcements &amp; concall transcripts — the companies that mention a
        firm or asset manager. Type your own term, or pick a fund manager from the rupeevest index.
      </p>

      {/* Free-text search — typing clears any dropdown selection. */}
      <div className="mb-3 flex max-w-2xl shrink-0 items-center gap-2">
        <Input
          aria-label="Search firm or asset manager"
          placeholder="e.g. Aequitas, Marcellus, Mukul Agrawal…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPick(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") run(query);
          }}
        />
        <button
          onClick={() => run(query)}
          className="h-9 shrink-0 border border-neutral-900 bg-neutral-900 px-4 text-base font-medium text-white hover:bg-neutral-700"
        >
          Search
        </button>
        {/* Compact = just company names, deep-linked into Stock Centric. */}
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-base text-neutral-700">
          <input
            type="checkbox"
            checked={compact}
            onChange={(e) => setCompact(e.target.checked)}
            className="h-4 w-4 accent-neutral-900"
          />
          Compact
        </label>
      </div>

      {/* Four SEBI-firm pick-lists + fund managers — mutually exclusive: picking
          one resets the others (value is bound to `pick.source`). */}
      <div className="mb-6 grid shrink-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {FIRM_DROPDOWNS.map(({ type, label }) => (
          <select
            key={type}
            aria-label={label}
            value={pick?.source === type ? pick.value : ""}
            onChange={(e) => pickFirm(type, e.target.value)}
            className="h-9 w-full truncate border border-neutral-300 bg-white px-2 text-base font-medium focus:outline-none focus:ring-1 focus:ring-neutral-400"
          >
            <option value="">
              {label} ({byType[type].length})
            </option>
            {byType[type].map((f, i) => (
              <option key={i} value={String(i)}>
                {f.name}
                {f.city ? ` — ${f.city}` : ""}
              </option>
            ))}
          </select>
        ))}
        <select
          aria-label="Fund manager index (rupeevest)"
          value={pick?.source === "fm" ? pick.value : ""}
          onChange={(e) => pickManager(e.target.value)}
          className="h-9 w-full truncate border border-neutral-300 bg-white px-2 text-base font-medium focus:outline-none focus:ring-1 focus:ring-neutral-400"
        >
          <option value="">
            {managersError ? "Fund managers unavailable" : `Fund managers (${managers?.length ?? 0})`}
          </option>
          {(managers ?? []).map((m, i) => (
            <option key={i} value={String(i)}>
              {m.manager} — {m.fund_house}
            </option>
          ))}
        </select>
      </div>

      {/* Only the results scroll; min-h-0 lets this box shrink in the flex column. */}
      <div className="min-h-0 flex-1 overflow-auto">
      {!submitted ? (
        <p className="text-base text-neutral-400">Search a firm or asset manager to see the companies that mention it.</p>
      ) : error ? (
        <div className="text-base text-red-600">
          Search failed: {String((error as Error).message ?? error)}.{" "}
          <button onClick={() => mutate()} className="underline hover:no-underline">
            Retry
          </button>
        </div>
      ) : searching ? (
        <p className="text-base text-neutral-400">Searching screener.in for “{submitted}”…</p>
      ) : companies.length === 0 ? (
        <p className="text-base text-neutral-400">No companies mention “{submitted}”.</p>
      ) : (
        <>
          <div className="mb-3 text-sm text-neutral-500">
            <span className="font-medium text-neutral-800">{companies.length}</span> compan
            {companies.length === 1 ? "y" : "ies"} for “{data?.query}”
            {data && data.total > companies.length && (
              <span> · {data.total.toLocaleString("en-IN")} document matches (top results)</span>
            )}
          </div>
          {compact ? (
            // Compact: just company names, each row deep-links into Stock Centric.
            <ul className="divide-y divide-neutral-200 border-y border-neutral-200">
              {companies.map((c) => (
                <li key={c.symbol}>
                  <Link
                    href={scHref(c.symbol)}
                    title={`Open ${c.symbol} in Stock Centric`}
                    className="flex items-baseline gap-2 py-1.5 text-neutral-900 hover:bg-neutral-50"
                  >
                    <span className="font-medium">{c.company_name}</span>
                    <span className="text-xs text-neutral-400">{c.symbol}</span>
                    <span className="ml-auto shrink-0 text-neutral-400">
                      <ScArrow />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            // Full: the matched document context; name → screener, symbol → Stock Centric.
            <ul className="divide-y divide-neutral-200 border-y border-neutral-200">
              {companies.map((c) => (
                <li key={c.symbol} className="py-3">
                  <div className="flex items-baseline gap-2">
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-lg font-medium leading-snug text-neutral-900 hover:underline"
                    >
                      {c.company_name}
                    </a>
                    <Link
                      href={scHref(c.symbol)}
                      title={`Open ${c.symbol} in Stock Centric`}
                      className="shrink-0 border border-neutral-300 px-1.5 py-0.5 text-xs font-medium text-neutral-600 hover:border-neutral-500"
                    >
                      {c.symbol} <ScArrow />
                    </Link>
                    <span className="shrink-0 text-xs text-neutral-400">
                      {c.matches} mention{c.matches === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="mt-0.5 text-sm text-neutral-400">
                    {c.doc_type ? <span>{c.doc_type}</span> : null}
                    {c.doc_type && c.date ? " · " : ""}
                    {c.date ?? ""}
                  </div>
                  {c.snippet && <p className="mt-1 line-clamp-2 text-base text-neutral-600">{c.snippet}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      </div>
    </div>
  );
}
