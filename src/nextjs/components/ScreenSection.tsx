"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import DataTable from "@/components/DataTable";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchJson } from "@/lib/api";
import type { Panel, Row, ScreenConfig } from "@/lib/screens";

type PanelResult = { title: string; rows: Row[] };

async function fetchPanels(panels: Panel[], n: number, top: number): Promise<PanelResult[]> {
  const results = await Promise.all(panels.map((p) => fetchJson<Row[]>(p.path({ n, top }))));
  return panels.map((p, i) => ({ title: p.title, rows: results[i] }));
}

export default function ScreenSection({ screen }: { screen: ScreenConfig }) {
  const [n, setN] = useState(30);
  const [top, setTop] = useState(20);
  const allPanels = screen.panelGroups.flat();

  // keepPreviousData keeps the prior tables on screen (dimmed under the loading
  // overlay) while a param-change refetch is in flight; isValidating (unlike
  // isLoading) stays true during those refetches, so it drives both the overlay
  // and the toast. revalidateOnFocus off to avoid overlay flashes on tab focus.
  const { data, error, isValidating } = useSWR(
    [screen.id, n, top],
    () => fetchPanels(allPanels, n, top),
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      onError: (err) => toast.error(`Failed to fetch ${screen.label}`, { description: String(err) }),
    },
  );

  const loadingToastId = useRef<string | number | null>(null);
  useEffect(() => {
    if (isValidating) {
      loadingToastId.current = toast.loading(`Fetching ${screen.label}…`);
      return;
    }
    if (loadingToastId.current === null) return;
    if (error) {
      toast.dismiss(loadingToastId.current);
    } else if (data) {
      const totalRows = data.reduce((sum, p) => sum + p.rows.length, 0);
      toast.success(`${screen.label} — ${totalRows} rows`, { id: loadingToastId.current });
    }
    loadingToastId.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isValidating]);

  const panelRows = (title: string) => data?.find((p) => p.title === title)?.rows ?? [];

  return (
    <section id={`screen-${screen.id}`} className="scroll-mt-8">
      <h2 className="mb-1 border-b border-neutral-200 pb-2 text-xl font-semibold">
        {screen.label}
      </h2>

      {(screen.usesN || screen.usesTop) && (
        <div className="mb-3 mt-2 flex gap-4 text-base">
          {screen.usesN && (
            <div className="flex items-center gap-2">
              <Label htmlFor={`n-days-${screen.id}`} className="text-base">N days</Label>
              <Input
                id={`n-days-${screen.id}`}
                type="number"
                min={1}
                value={n}
                onChange={(e) => setN(Math.max(1, Number(e.target.value) || 1))}
                className="w-20 text-base"
              />
            </div>
          )}
          {screen.usesTop && (
            <div className="flex items-center gap-2">
              <Label htmlFor={`top-n-${screen.id}`} className="text-base">Top N</Label>
              <Input
                id={`top-n-${screen.id}`}
                type="number"
                min={1}
                value={top}
                onChange={(e) => setTop(Math.max(1, Number(e.target.value) || 1))}
                className="w-20 text-base"
              />
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-4">
        {screen.panelGroups.map((group, i) => (
          <div
            key={i}
            className={group.length > 1 ? "grid grid-cols-1 gap-4 lg:grid-cols-2" : "flex flex-col gap-4"}
          >
            {group.map((p) => (
              <div key={p.title}>
                <h3 className="mb-1 text-base font-medium text-neutral-500">{p.title}</h3>
                <DataTable rows={panelRows(p.title)} loading={isValidating} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
