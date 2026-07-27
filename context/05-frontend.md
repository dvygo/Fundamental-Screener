# 05 · Frontend

`src/nextjs/` is a **git submodule** → [github.com/dvygo/hunt-internal](https://github.com/dvygo/hunt-internal).
Its own `README`, `CONTRIBUTING` and `context/` live inside the submodule.

## Tabs

HUNT · Markets · Stock Centric · Insider Centric · Corporate Actions · News ·
Firms & Asset Managers. One shared nav model (`lib/nav.ts`) drives both the desktop
sidebar and the mobile bottom bar; every symbol deep-links (↗) into Stock Centric.

## Stack

Next.js 16 (App Router) · React 19 · AG Grid · SWR · sonner · Tailwind v4 ·
next-themes. All data comes from the API via `lib/api.ts` (`NEXT_PUBLIC_API_BASE`,
default `http://localhost:3000/api`).

## Working on it

- **Submodule flow:** change the UI in `src/nextjs`, commit + push to hunt-internal,
  then bump the pointer here (`git add src/nextjs && commit`). See
  [../CONTRIBUTING.md](../CONTRIBUTING.md).
- Fresh clone: `git submodule update --init src/nextjs && (cd src/nextjs && npm install)`.
- **Caveat:** "this is not the Next.js you know" — read `node_modules/next/dist/docs/`
  before writing App Router code (the submodule's `AGENTS.md`).
- `tsc --noEmit` and `eslint` must be clean before pushing the UI.
