# 04 · Signals & HUNT

## The client requirements

[requirements/20260717/requirement.md](requirements/20260717/requirement.md) —
Layer A (bhavcopy screens 1-5), Layer B (screener signals), Layer C (announcement
engine). Layered design as built: [PLAN.md](PLAN.md).

| Layer | As built (UI tab) | SQL |
|---|---|---|
| **A** — market-wide | Markets: 52w high/low, gainers/losers recurrence, circuits | `db.js` + `screens.js` |
| **B** — per-symbol | Stock Centric: insider, promoter/FII/DII, mcap/PE/EPS | `companies.js` |
| **C** — flow | Insider Centric, Corporate Actions, News | `companies.js`, `corporate.js`, `news.js` |

## HUNT — the convergence scoreboard

The payload. Source: the *Idea Hunting Framework*
([requirements/20260717/Idea Hunting Framework.pdf](requirements/20260717/)). Every
tripwire carries flat points; a name accrues them over a rolling window and the
highest total floats up. **Convergence** — many independent signals on one name —
is the tell. The authoritative, heavily-commented implementation is
**`src/nodejs/src/hunt.js`**; the scoring table and what's unwired are in
[PLAN.md](PLAN.md).

**The five honesty rules it enforces** (framework Part 3) — internalise these,
they're the correctness contract:

1. Rolling **~21 trading sessions** (session-equivalent span; oldest rolls off).
2. Count per signal **per session, not per mention** — insider trades are deduped
   (the XBRL repeats each trade across contexts) and scored **open-market only**
   (Market Purchase / Block Deal; ESOP/gift/off-market = 0); news headlines deduped.
3. Repetition accumulates (a fresh 52-week breakout that keeps making highs keeps
   earning).
4. Fluff scores 0 (no keyword → never climbs).
5. Volume ×1.5 confirmer — **not yet wired** (see [06](06-state-and-open-threads.md)).

> Invariant to preserve across any change: the per-signal columns must **sum to
> `score`**, and `signals` = count of families that fired. Verify against real data.
