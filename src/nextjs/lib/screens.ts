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
    id: "1",
    label: "52-Week Highs & Lows",
    usesN: true,
    panelGroups: [
      [
        { title: "Highs — last session", path: () => "/screens/52w-high" },
        { title: "Lows — last session", path: () => "/screens/52w-low" },
      ],
      [
        { title: "Highs — N-day event count", path: ({ n }) => `/screens/52w-high/events?n=${n}` },
        { title: "Lows — N-day event count", path: ({ n }) => `/screens/52w-low/events?n=${n}` },
      ],
    ],
  },
  {
    id: "2",
    label: "Gainers & Losers",
    usesTop: true,
    panelGroups: [
      [
        { title: "Top Gainers — last session", path: ({ top }) => `/screens/gainers?top=${top}` },
        { title: "Top Losers — last session", path: ({ top }) => `/screens/losers?top=${top}` },
      ],
    ],
  },
  {
    id: "3",
    label: "Gainers — N-day recurrence",
    usesN: true,
    usesTop: true,
    panelGroups: [
      [
        {
          title: "Recurrence in top gainers",
          path: ({ n, top }) => `/screens/gainers/recurrence?n=${n}&top=${top}`,
        },
      ],
    ],
  },
  {
    id: "4",
    label: "Upper & Lower Circuit",
    panelGroups: [
      [
        { title: "Upper circuit — last session", path: () => "/screens/upper-circuit" },
        { title: "Lower circuit — last session", path: () => "/screens/lower-circuit" },
      ],
    ],
  },
];
