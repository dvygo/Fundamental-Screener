# 07 · Your mission

Two steps, **in this order**.

## 1 · Build memory FIRST — before you touch any code

You've read `00`–`06`. Now write the durable facts into your **persistent project
memory** so they survive context resets and you don't re-derive them every session.
At minimum, capture:

- the **architecture** — three tiers, ports (3000/3001/9000/9001), and where code
  lives ([01](01-architecture.md));
- the **HUNT scoring model** — the point table and the **five honesty rules**
  ([04](04-signals-and-hunt.md)); the column-sum-to-`score` invariant;
- the **data-coverage caveat** — only ~5 daily bhavcopies loaded today
  ([06](06-state-and-open-threads.md));
- the **security constraints** — the secret guard; `src/nodejs/.env` and `data/raw/`
  are never committed ([../CONTRIBUTING.md](../CONTRIBUTING.md));
- the **submodule setup** — `src/nextjs` → hunt-internal, and the bump workflow
  ([05](05-frontend.md));
- the **open threads** ([06](06-state-and-open-threads.md)).

Memory before code: a refactor guided by facts you've internalised beats one you
re-derive from scratch.

## 2 · THEN refactor

Guardrails — do not regress these:

- the four scraping rules and the secret guard ([../CONTRIBUTING.md](../CONTRIBUTING.md));
- `tsc --noEmit` + `eslint` clean on the frontend; **validated-integer** params in
  any DuckDB SQL;
- **verify against real data** before and after — the board and screens have exact
  invariants (e.g. HUNT columns must sum to `score`; no duplicate 52w dates).

Known, grounded targets (not invented — see [06](06-state-and-open-threads.md)):

1. **Dedupe the screen SQL** — one source of truth instead of `screens.py` +
   `screens.js` maintained by hand.
2. **Wire the unwired HUNT signals** — volume ×1.5, sector tailwind/headwind, a real
   announcements feed.
3. **v1 → v2 MinIO cutover** — flip `db.js` globs to `s3://raw/…`.
4. **Layer C classifier** — announcement → event type.
5. **rupeevest per-fincode holdings loop** — paced, lossless, landing per-fincode JSON.

Confirm scope with the user before any large change. **Commit only when asked**,
directly on `main`, with the secret guard run first.
