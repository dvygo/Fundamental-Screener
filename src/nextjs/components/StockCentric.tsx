"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import DataTable from "@/components/DataTable";
import StockDrilldown from "@/components/StockDrilldown";
import { Input } from "@/components/ui/input";
import { searchCompanies, companyInsider, companyShareholding, type CompanyMatch } from "@/lib/companies";

export default function StockCentric() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selected, setSelected] = useState<CompanyMatch | null>(null);
  const [showResults, setShowResults] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { data: matches } = useSWR(
    debouncedQuery.length > 0 ? ["company-search", debouncedQuery] : null,
    () => searchCompanies(debouncedQuery),
  );

  const {
    data: insiderRows,
    error: insiderError,
    isValidating: insiderLoading,
  } = useSWR(selected ? ["insider", selected.symbol] : null, () => companyInsider(selected!.symbol), {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

  const {
    data: shareholdingRows,
    error: shareholdingError,
    isValidating: shareholdingLoading,
  } = useSWR(selected ? ["shareholding", selected.symbol] : null, () => companyShareholding(selected!.symbol), {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

  const fetchToastId = useRef<string | number | null>(null);
  const loading = insiderLoading || shareholdingLoading;
  useEffect(() => {
    if (!selected) return;
    if (loading) {
      fetchToastId.current = toast.loading(`Fetching ${selected.symbol}…`);
      return;
    }
    if (fetchToastId.current === null) return;
    if (insiderError || shareholdingError) {
      toast.dismiss(fetchToastId.current);
    } else {
      const total = (insiderRows?.length ?? 0) + (shareholdingRows?.length ?? 0);
      toast.success(`${selected.symbol} — ${total} rows`, { id: fetchToastId.current });
    }
    fetchToastId.current = null;
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

      <div className="relative mb-6 mt-3 max-w-sm">
        <Input
          placeholder="Search symbol or company name…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setShowResults(true);
          }}
          onFocus={() => setShowResults(true)}
        />
        {showResults && matches && matches.length > 0 && (
          <ul className="absolute z-10 mt-1 w-full border border-neutral-200 bg-white shadow-sm">
            {matches.map((m) => (
              <li key={m.symbol}>
                <button
                  className="block w-full px-3 py-2 text-left text-base hover:bg-neutral-100"
                  onClick={() => {
                    setSelected(m);
                    setQuery(`${m.symbol} — ${m.company_name}`);
                    setShowResults(false);
                  }}
                >
                  <span className="font-medium">{m.symbol}</span>{" "}
                  <span className="text-neutral-500">{m.company_name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {!selected && <p className="text-base text-neutral-400">Search for a stock to see its details.</p>}

      {selected && (
        <div className="flex flex-col gap-8">
          <StockDrilldown symbol={selected.symbol} />

          <div>
            <h3 className="mb-2 text-base font-medium text-neutral-500">
              Promoter holding {current ? `— ${current.promoter_pct}%` : ""}
              {change !== null && (
                <span className={change >= 0 ? "text-emerald-600" : "text-red-600"}>
                  {" "}
                  ({change >= 0 ? "+" : ""}
                  {change} pp vs prior filing)
                </span>
              )}
            </h3>
            <DataTable rows={shareholdingRows ?? []} loading={shareholdingLoading} />
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
