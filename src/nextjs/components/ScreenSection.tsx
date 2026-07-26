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
  const [open, setOpen] = useState(false); // collapsed by default; tables still load
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

  // A STABLE toast id per screen: a second effect run (Strict Mode, Fast Refresh)
  // reuses the same toast instead of stacking a duplicate. loadingShown gates the
  // success/dismiss so we only finish a toast we actually started.
  const toastId = `mkt-${screen.id}`;
  const loadingShown = useRef(false);
  useEffect(() => {
    if (isValidating) {
      // Infinity: the loading toast persists for the WHOLE fetch (synced to the
      // table's own loading overlay), instead of auto-dismissing on a 1s timer.
      toast.loading(`Fetching ${screen.label}…`, { id: toastId, duration: Infinity });
      loadingShown.current = true;
      return;
    }
    if (!loadingShown.current) return;
    loadingShown.current = false;
    if (error) {
      toast.dismiss(toastId);
    } else if (data) {
      const totalRows = data.reduce((sum, p) => sum + p.rows.length, 0);
      // Morph the same toast to success with the short auto-dismiss.
      toast.success(`${screen.label} — ${totalRows} rows`, { id: toastId, duration: 1000 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isValidating]);

  const panelRows = (title: string) => data?.find((p) => p.title === title)?.rows ?? [];

  return (
    <section id={`screen-${screen.id}`} className="scroll-mt-8">
      {/* Collapsible: ▶ rotates to ▼ on expand. Content below stays mounted while
          collapsed (h-0), so its tables still fetch/populate in the background and
          revealing is instant. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-b border-neutral-200 pb-2 text-left text-xl font-semibold"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`shrink-0 text-neutral-500 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        {screen.label}
      </button>

      <div className={open ? "mt-3" : "h-0 overflow-hidden"}>
        {(screen.usesN || screen.usesTop) && (
          <div className="mb-3 flex gap-4 text-base">
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
                  <DataTable rows={panelRows(p.title)} loading={isValidating} linkSymbol />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
