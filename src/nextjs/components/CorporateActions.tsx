"use client";

import { useEffect, useRef } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import DataTable from "@/components/DataTable";
import { corporateActions } from "@/lib/corporate";

export default function CorporateActions() {
  const { data, error, isValidating } = useSWR("corporate-actions", corporateActions, {
    keepPreviousData: true,
    revalidateOnFocus: false,
    onError: (err) => toast.error("Failed to fetch corporate actions", { description: String(err) }),
  });

  // Stable toast id (no duplicate on a repeated effect run); loading persists
  // until the data lands, then morphs to a short-lived success.
  const loadingShown = useRef(false);
  useEffect(() => {
    if (isValidating) {
      toast.loading("Fetching corporate actions…", { id: "corp-actions", duration: Infinity });
      loadingShown.current = true;
      return;
    }
    if (!loadingShown.current) return;
    loadingShown.current = false;
    if (error) {
      toast.dismiss("corp-actions");
    } else if (data) {
      toast.success(`Corporate actions — ${data.length} rows`, { id: "corp-actions", duration: 1000 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isValidating]);

  // Full-page table: fill main's content box (viewport height minus its p-4),
  // header + blurb take their natural height, the grid grabs the rest.
  return (
    <div className="flex h-full flex-col">
      <h1 className="mb-4 text-2xl font-semibold">Corporate Actions</h1>
      <p className="mb-3 text-base text-neutral-500">
        Dividends, splits, bonus, buybacks &amp; more — EQ series, with ex-date and record date.
      </p>
      <DataTable rows={data ?? []} loading={isValidating} fill />
    </div>
  );
}
