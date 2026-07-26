"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";

// Switching pages should leave the previous page's work behind: dismiss every
// toast on navigation so a leftover "Fetching…" (whose success/dismiss never
// fired because its component unmounted mid-request) can't linger on the new
// page. Rendered before <main> so this runs ahead of the incoming page's own
// toast effects — the new page's toasts survive, the old page's don't.
export default function RouteCleanup() {
  const pathname = usePathname();
  useEffect(() => {
    toast.dismiss();
  }, [pathname]);
  return null;
}
