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

  const loadingToastId = useRef<string | number | null>(null);
  useEffect(() => {
    if (isValidating) {
      loadingToastId.current = toast.loading("Fetching corporate actions…");
      return;
    }
    if (loadingToastId.current === null) return;
    if (error) {
      toast.dismiss(loadingToastId.current);
    } else if (data) {
      toast.success(`Corporate actions — ${data.length} rows`, { id: loadingToastId.current });
    }
    loadingToastId.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isValidating]);

  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Corporate Actions</h1>
      <p className="mb-3 text-base text-neutral-500">
        Dividends, splits, bonus, buybacks &amp; more — EQ series, with ex-date and record date.
      </p>
      <DataTable rows={data ?? []} loading={isValidating} />
    </>
  );
}
