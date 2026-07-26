import { fetchJson } from "@/lib/api";
import type { Row } from "@/lib/screens";

// The HUNT convergence scoreboard — every stock ranked by the flat-point signal
// score it accrued over a rolling window of the last `sessions` trading sessions
// (framework default 21). Each column is the points one signal family
// contributed; they sum to `score`. See src/nodejs/src/hunt.js.
export function huntBoard(sessions: number): Promise<Row[]> {
  return fetchJson(`/hunt?sessions=${sessions}`);
}
