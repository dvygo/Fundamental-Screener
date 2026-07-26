"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import DataTable from "@/components/DataTable";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { insiderRecent } from "@/lib/insider";
import type { Row } from "@/lib/screens";

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "Buy", label: "Buys" },
  { key: "Sell", label: "Sells" },
];

export default function InsiderCentric() {
  const [days, setDays] = useState(7);
  const [filter, setFilter] = useState("all");

  const { data, error, isValidating } = useSWR(["insider-recent", days], () => insiderRecent(days), {
    keepPreviousData: true,
    revalidateOnFocus: false,
    onError: (err) => toast.error("Failed to fetch insider trades", { description: String(err) }),
  });

  const loadingShown = useRef(false);
  useEffect(() => {
    if (isValidating) {
      toast.loading("Fetching insider trades…", { id: "insider-recent", duration: Infinity });
      loadingShown.current = true;
      return;
    }
    if (!loadingShown.current) return;
    loadingShown.current = false;
    if (error) toast.dismiss("insider-recent");
    else if (data) toast.success(`Insider trades — ${data.length} rows`, { id: "insider-recent", duration: 1000 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isValidating]);

  // Buy/Sell counts (over the full window, before the active filter narrows it).
  const counts = useMemo(() => {
    const all = data ?? [];
    return {
      total: all.length,
      Buy: all.filter((r) => r.txn_type === "Buy").length,
      Sell: all.filter((r) => r.txn_type === "Sell").length,
    };
  }, [data]);

  const rows = useMemo<Row[]>(() => {
    const all = data ?? [];
    return filter === "all" ? all : all.filter((r) => r.txn_type === filter);
  }, [data, filter]);

  // Full-page: header + controls take their natural height, the table fills the rest.
  return (
    <div className="flex h-full flex-col">
      <h1 className="mb-1 shrink-0 text-2xl font-semibold">Insider Centric</h1>
      <p className="mb-3 shrink-0 text-base text-neutral-500">
        Insider trades filed across all stocks in the last N days — buys, sells &amp; pledges from NSE PIT filings.
      </p>

      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Label htmlFor="insider-days" className="text-base">
            Last N days
          </Label>
          <Input
            id="insider-days"
            type="number"
            min={1}
            value={days}
            onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 1))}
            className="w-20 text-base"
          />
        </div>
        <div className="flex items-center gap-1.5">
          {FILTERS.map((f) => {
            const label =
              f.key === "all" ? `${f.label} (${counts.total})` : `${f.label} (${counts[f.key as "Buy" | "Sell"]})`;
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`h-9 border px-3 text-base font-medium transition-colors ${
                  filter === f.key
                    ? "border-neutral-900 bg-neutral-900 text-white"
                    : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <DataTable rows={rows} loading={isValidating} fill linkSymbol emptyMessage="No insider trades in this window" />
    </div>
  );
}
