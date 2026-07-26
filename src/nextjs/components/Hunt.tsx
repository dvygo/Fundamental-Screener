"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import DataTable from "@/components/DataTable";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { huntBoard } from "@/lib/hunt";
import type { Row } from "@/lib/screens";

export default function Hunt() {
  const [sessions, setSessions] = useState(21); // framework window: ~21 trading sessions

  const { data, error, isValidating } = useSWR(["hunt", sessions], () => huntBoard(sessions), {
    keepPreviousData: true,
    revalidateOnFocus: false,
    onError: (err) => toast.error("Failed to build the hunt board", { description: String(err) }),
  });

  // Stable toast id so a re-run reuses the toast; loadingShown gates the
  // success/dismiss so we only finish a toast we started (same pattern as the
  // Markets sections and Insider Centric).
  const loadingShown = useRef(false);
  useEffect(() => {
    if (isValidating) {
      toast.loading("Scoring signals…", { id: "hunt", duration: Infinity });
      loadingShown.current = true;
      return;
    }
    if (!loadingShown.current) return;
    loadingShown.current = false;
    if (error) toast.dismiss("hunt");
    else if (data) toast.success(`HUNT — ${data.length} names ranked`, { id: "hunt", duration: 1000 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isValidating]);

  const rows = (data ?? []) as Row[];

  // Full-page: heading, blurb and the N-days control pin at the top; the ranked
  // board fills the rest and scrolls on its own.
  return (
    <div className="flex h-full flex-col">
      <h1 className="mb-1 shrink-0 text-2xl font-semibold">HUNT</h1>
      <p className="mb-3 max-w-4xl shrink-0 text-base text-neutral-500">
        The convergence scoreboard. Every tripwire — insider buys, fresh 52-week highs &amp; lows, recurring gainers
        &amp; losers, corporate actions and news keywords — carries flat points; a name accrues them each session over a
        rolling window of the last N trading sessions, and the highest running total floats to the top. Each signal is
        counted once per session, not per mention. Convergence is the tell: the more independent signals land on one
        name, the harder it&apos;s worth a look. This ranks where to look first — never what to buy.
      </p>

      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor="hunt-sessions" className="text-base">
            Last N sessions
          </Label>
          <Input
            id="hunt-sessions"
            type="number"
            min={1}
            value={sessions}
            onChange={(e) => setSessions(Math.max(1, Number(e.target.value) || 1))}
            className="w-20 text-base"
          />
        </div>
        <p className="text-sm text-neutral-400">
          Points — insider buy 5 · fresh 52w 5 (+1/session) · news 3/2/1 · rights 2 / bonus·split·buyback 1 · gainer or
          loser 1
        </p>
      </div>

      <DataTable rows={rows} loading={isValidating} fill linkSymbol emptyMessage="No signals in this window" />
    </div>
  );
}
