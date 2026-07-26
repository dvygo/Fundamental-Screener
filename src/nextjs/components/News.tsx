"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { fetchNews, type NewsItem } from "@/lib/news";

const ALL = "ALL";

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return "";
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function News() {
  const { data, error, isValidating } = useSWR("news", fetchNews, {
    keepPreviousData: true,
    revalidateOnFocus: false,
    onError: (err) => toast.error("Failed to fetch news", { description: String(err) }),
  });

  // Default is ALL — every article in today.xml. Picking a stock narrows to the
  // articles whose headline named it.
  const [filter, setFilter] = useState<string>(ALL);

  // Indian listed companies only: keep just the articles whose headline tagged
  // an NSE stock (drops global/foreign and unlisted-company news).
  const articles = useMemo<NewsItem[]>(() => (data ?? []).filter((a) => a.symbols.length > 0), [data]);

  // The stocks that actually appear in today's feed, with their article counts —
  // the only meaningful options for the filter (companies with no news today are
  // not listed).
  const stockOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of articles) for (const s of a.symbols) counts.set(s.symbol, (counts.get(s.symbol) ?? 0) + 1);
    return [...counts.entries()].map(([symbol, count]) => ({ symbol, count })).sort((a, b) => a.symbol.localeCompare(b.symbol));
  }, [articles]);

  const shown = useMemo(
    () => (filter === ALL ? articles : articles.filter((a) => a.symbols.some((s) => s.symbol === filter))),
    [articles, filter],
  );

  const loadingShown = useRef(false);
  useEffect(() => {
    if (isValidating) {
      toast.loading("Fetching news…", { id: "news", duration: Infinity });
      loadingShown.current = true;
      return;
    }
    if (!loadingShown.current) return;
    loadingShown.current = false;
    if (error) toast.dismiss("news");
    else if (data) {
      const n = data.filter((a) => a.symbols.length > 0).length;
      toast.success(`News — ${n} Indian-company article${n === 1 ? "" : "s"}`, { id: "news", duration: 1000 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isValidating]);

  // Full-height column: heading + subtitle + filter stay pinned at the top; only
  // the article feed below scrolls (h-[calc(100vh-2rem)] fills main minus its p-4).
  return (
    <div className="flex h-full max-w-4xl flex-col">
      <h1 className="mb-1 shrink-0 text-2xl font-semibold">News</h1>
      <p className="mb-4 shrink-0 text-base text-neutral-500">
        LiveMint · Companies — today · Indian listed companies only, each headline tagged with the stock(s) it names.
      </p>

      {/* Stock filter — default "All stocks" shows every article. */}
      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-2">
        <select
          aria-label="Filter by stock"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-9 shrink-0 border border-neutral-300 bg-white px-2 text-base font-medium focus:outline-none focus:ring-1 focus:ring-neutral-400"
        >
          <option value={ALL}>All stocks ({articles.length})</option>
          {stockOptions.map((o) => (
            <option key={o.symbol} value={o.symbol}>
              {o.symbol} ({o.count})
            </option>
          ))}
        </select>
        {filter !== ALL && (
          <button
            onClick={() => setFilter(ALL)}
            className="h-9 shrink-0 border border-neutral-300 bg-white px-2.5 text-base font-medium text-neutral-600 hover:bg-neutral-50"
          >
            Clear
          </button>
        )}
        <span className="text-sm text-neutral-400">
          {shown.length} article{shown.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Only this feed scrolls; min-h-0 lets it shrink inside the flex column. */}
      <div className="min-h-0 flex-1 overflow-auto">
      {error && !data ? (
        <p className="text-base text-red-600">Couldn&apos;t load news. Retrying…</p>
      ) : shown.length === 0 ? (
        <p className="text-base text-neutral-400">
          {isValidating ? "Loading…" : filter === ALL ? "No Indian-company news today." : "No news for this stock today."}
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 border-y border-neutral-200">
          {shown.map((a, i) => (
            <li key={`${a.link}-${i}`} className="flex gap-4 py-4">
              {a.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={a.image}
                  alt=""
                  loading="lazy"
                  className="hidden h-20 w-28 shrink-0 object-cover sm:block"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-sm text-neutral-400">{formatTime(a.published)}</div>
                <a
                  href={a.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-lg font-medium leading-snug text-neutral-900 hover:underline"
                >
                  {a.title}
                </a>
                {a.description && <p className="mt-1 line-clamp-2 text-base text-neutral-600">{a.description}</p>}
                {a.symbols.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {a.symbols.map((s) => (
                      <button
                        key={s.symbol}
                        onClick={() => setFilter(s.symbol)}
                        title={s.company_name}
                        className={`border px-1.5 py-0.5 text-xs font-medium transition-colors ${
                          filter === s.symbol
                            ? "border-neutral-900 bg-neutral-900 text-white"
                            : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500"
                        }`}
                      >
                        {s.symbol}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      </div>
    </div>
  );
}
