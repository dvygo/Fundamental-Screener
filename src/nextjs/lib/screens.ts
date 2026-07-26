// Layer A screens (requirement.md 1-5) — all market-wide (scan every symbol
// for a session/window). Per-stock drill-down (B4) is a separate feature,
// reached from a row in one of these tables, not one of the 5 itself.

export type Row = Record<string, string | number | null>;

export interface ScreenParams {
  n: number;
  top: number;
}

export interface Panel {
  title: string;
  path: (params: ScreenParams) => string;
}

export interface ScreenConfig {
  id: string;
  label: string;
  usesN?: boolean;
  usesTop?: boolean;
  /** Each inner array renders side-by-side; groups themselves stack vertically. */
  panelGroups: Panel[][];
}

export const SCREENS: ScreenConfig[] = [
  {
    id: "52w-high",
    label: "52-Week High",
    usesN: true,
    panelGroups: [
      [{ title: "New 52-week highs — last N days", path: ({ n }) => `/screens/52w-high?n=${n}` }],
    ],
  },
  {
    id: "52w-low",
    label: "52-Week Low",
    usesN: true,
    panelGroups: [
      [{ title: "New 52-week lows — last N days", path: ({ n }) => `/screens/52w-low?n=${n}` }],
    ],
  },
  {
    id: "gainers-nday",
    label: "Gainers — N-Day",
    usesN: true,
    usesTop: true,
    panelGroups: [
      [{ title: "Recurrence in top gainers", path: ({ n, top }) => `/screens/gainers/recurrence?n=${n}&top=${top}` }],
    ],
  },
  {
    id: "losers-nday",
    label: "Losers — N-Day",
    usesN: true,
    usesTop: true,
    panelGroups: [
      [{ title: "Recurrence in top losers", path: ({ n, top }) => `/screens/losers/recurrence?n=${n}&top=${top}` }],
    ],
  },
  {
    id: "circuit",
    label: "Upper & Lower Circuit",
    panelGroups: [
      [
        { title: "Upper circuit — last session", path: () => "/screens/upper-circuit" },
        { title: "Lower circuit — last session", path: () => "/screens/lower-circuit" },
      ],
    ],
  },
];
