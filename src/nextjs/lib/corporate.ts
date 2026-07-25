import { fetchJson } from "@/lib/api";
import type { Row } from "@/lib/screens";

export function corporateActions(): Promise<Row[]> {
  return fetchJson("/corporate-actions");
}
