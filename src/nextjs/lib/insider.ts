import { fetchJson } from "@/lib/api";
import type { Row } from "@/lib/screens";

// Market-wide insider trades filed in the last `days` sessions (all symbols).
export function insiderRecent(days: number): Promise<Row[]> {
  return fetchJson(`/insider/recent?days=${days}`);
}
