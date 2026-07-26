// Shared nav model — the desktop sidebar and the mobile bottom bar render from
// this one list so they never drift. `letter` is the compact mobile label.
export interface NavItem {
  href: string;
  label: string;
  letter: string;
}

export const NAV: NavItem[] = [
  { href: "/hunt", label: "HUNT", letter: "H" },
  { href: "/", label: "Markets", letter: "M" },
  { href: "/stock-centric", label: "Stock Centric", letter: "S" },
  { href: "/insider-centric", label: "Insider Centric", letter: "I" },
  { href: "/corporate-actions", label: "Corporate Actions", letter: "C" },
  { href: "/news", label: "News", letter: "N" },
  { href: "/firms", label: "Firms & Asset Managers", letter: "F" },
];
