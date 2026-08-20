# Spec — three-pane app shell

**Status: specified, not built.** Decided 2026-08-20, after wealth.truedata.in.
Layout only — no chart, no announcement markers, no AI verdict.

## The shape

    ┌──────────┬───────────────┬──────────────────────────────┐
    │ NAV      │ FEED          │ HERO                         │
    │ (fixed)  │ (collapsible) │ (Stock Centric by default)   │
    │          │               │                              │
    │ HUNT     │ ○ News        │  ┌────────────────────────┐  │
    │ Markets  │ ○ Announce    │  │ tiles / tables         │  │
    │ Stock C. │               │  │                        │  │
    │ Insider  │ [feed rows]   │  │                        │  │
    │ Corp Act │               │  └────────────────────────┘  │
    │ News     │               │                              │
    │ Firms    │               │                              │
    │ ───────  │               │                              │
    │ Market ▾ │               │                              │
    │ Server ▾ │               │                              │
    └──────────┴───────────────┴──────────────────────────────┘

**NAV — the existing sidebar, unchanged and NOT collapsible.** Same nav model
(`lib/nav.ts`), same market filtering, the Market and Server dropdowns stay
pinned at the bottom. This pane is the app's spine; nothing about it changes.

**FEED — new, collapsible.** Two sources only: News and Announcements, switched
within the pane. Collapsing it hands its width to the hero. Collapsed state
persists, same mechanism as the market/server pickers (localStorage read through
useSyncExternalStore, since reading storage during render breaks hydration and
setState-in-effect is banned by the lint rule).

**HERO — the working area.** Market Centric or Stock Centric, with **Stock
Centric as the default landing view**. This inverts today's behaviour, where
`/` is Markets.

## What this changes

**Today:** single pane, one tab at a time, `/` = Markets.
**After:** the feed is always available beside whatever you are working on, and
the default view is a company rather than a board.

The feed pane is why this is worth doing. Announcements and news are context you
want *while* looking at a stock, not a destination you navigate away to. That is
the whole reason TrueWealth's layout works, and it is independent of every AI
feature they wrap around it.

## Consequences to accept

**Three panes need a width budget.** NAV is w-56 today. On a laptop, NAV + FEED
+ HERO leaves the hero cramped unless FEED defaults to collapsed below some
breakpoint. Decide the breakpoint deliberately rather than discovering it.

**Mobile has no room for three.** `BottomNav` already replaces NAV below md.
FEED should collapse to nothing there — reachable via the existing News tab, not
rendered as a pane.

**News and Announcements keep their tabs.** The feed pane is a second surface
onto the same data, not a replacement. Removing the tabs would make the content
unreachable when the pane is collapsed.

**Stock Centric as default needs an empty state that is useful.** Landing on a
company page with no company selected is worse than landing on Markets. Either
remember the last symbol, or show a search-first view that does not look broken.

## Build order

1. Shell: add the FEED pane to `app/(app)/layout.tsx`, collapsible, persisted.
2. Feed content: reuse the existing News data; Announcements needs the loader
   from `announcements-tab.md` first, so ship News-only and add the second
   source when the data exists.
3. Default route: `/` -> Stock Centric. Needs the empty-state decision above.
4. Market Centric / Stock Centric switch within the hero.

Steps 1 and 3 are independent of the announcements work and can ship first.
