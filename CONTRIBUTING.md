# Contributing

Thanks for taking an interest. This document covers how the repo is laid out, the
non-negotiable rules for scrapers and secrets, and what a reviewable change looks like.

By contributing you agree that your contributions are licensed under the
[BSD 3-Clause License](LICENSE.md).

## Repo shape

A monorepo with the Next.js UI vendored as a submodule:

| Path | Tracked |
|---|---|
| `src/python/` | Here — ELT loaders, scrapers, screens CLI |
| `src/nodejs/` | Here — Express 5 API and DuckDB views |
| `src/nextjs/` | **Submodule** → [hunt-internal](https://github.com/dvygo/hunt-internal) |

Changing the UI is a two-step commit — see [Submodule workflow](#submodule-workflow).
The submodule lives in its own repository; if you do not have access, clone without
`--recurse-submodules`. The Python pipeline and the API both run fine without it.

## Dev setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r setup/requirements.txt
cd src/nodejs && npm install        # API deps
cd ../nextjs  && npm install        # UI deps (inside the submodule, if you have it)
```

Run order for a live stack: MinIO (optional) → Python loaders → `node src/server.js`
(`:3000`) → `npm run dev` in `src/nextjs` (`:3001`). Full detail in
[`context/DEPLOY.md`](context/DEPLOY.md).

Start with [`context/00-start-here.md`](context/00-start-here.md) if you are new to the
codebase; [`context/01-architecture.md`](context/01-architecture.md) and
[`context/04-signals-and-hunt.md`](context/04-signals-and-hunt.md) explain why the layers are
split the way they are.

## The four rules (they are not optional)

1. **Never fabricate a URL.** Fetch only real listing codes and discovered links, followed to
   their final destination. A guessed URL that happens to 200 is still a bug.
2. **Cache and pace.** Raw HTML is cached under `data/raw/`; live requests are delayed.
   Re-runs parse from cache, not the network. Respect `robots.txt`.
3. **Degrade gracefully.** A blocked or changed page skips that company and logs it — never
   abort the run, and never emit a half-empty record as if it were complete.
4. **Outputs vs raw.** Parsed JSON/CSV goes to `data/` and is committed; raw HTML and
   re-fetchable bundles stay local and gitignored.

Read [`context/sources.md`](context/sources.md) before touching any scraper. It records what
each source permits, what it rate-limits, and what has already been tried.

## Secrets — never commit them

Credentials belong in gitignored files only:

- screener.in credentials in **`src/nodejs/.env`**
- MinIO root user/password in **`docker/.env`**
- rclone config and shared-drive id in **`/.data-sync.env`**
- the Google service-account JSON for Drive sync — copied to each server by hand
- TLS key and certificate for the API's optional HTTPS listener

Run the guard before every commit:

```bash
git diff --cached --name-only | grep -E '\.env$|today\.xml|data/raw/|\.pem$|\.key$'
```

Any output means stop and unstage. It must be empty.

## Changes we welcome

- **New sources** — with a `context/sources.md` entry covering terms, rate limits and cache
  strategy, written *before* the scraper.
- **New screens** — as DuckDB SQL in `screens.py`, mirrored into `db.js`. Both, or neither.
- **HUNT scoring** — changes to point values or windows need a note on which framework rule
  they implement, and must not silently start scoring a signal the data cannot support.
- **Correctness fixes** — especially parsing edge cases across NSE's inconsistent date and
  case conventions.

If a framework input has no data behind it, leave it scoring 0 and say so. A board that
invents a signal is worse than one that admits a gap.

## Code style

- **Python** — match the surrounding module's idiom. Loaders are idempotent and checkpointed:
  re-running must not duplicate rows or re-fetch what is already cached. Static-file
  extraction stays in Python.
- **Node** — ESM (`"type": "module"`). All screen SQL lives in `src/nodejs/src/db.js` (base
  views) and `screens.js`. Keep it there; do not inline ad-hoc SQL in routes. Query params
  interpolated into DuckDB SQL **must** be validated integers.
- **Frontend** — see the submodule's own `CONTRIBUTING.md`. `tsc --noEmit` and `eslint` must
  be clean before you push.

## Commits and pull requests

- Keep a commit to one logical change, and write the message to explain *why*, not just what.
- Say what you ran to verify. "Loaded 20260726, `/api/hunt` returns 340 rows, spot-checked
  INFY against the filing" beats "works".
- Note any source whose HTML you had to re-inspect — that is the part most likely to rot.

## Submodule workflow

The frontend evolves in `hunt-internal`; this repo records a pinned commit.

```bash
# 1. change and ship the UI (inside the submodule)
cd src/nextjs
#    ...edit... then, with tsc + eslint clean:
git add -A && git commit -m "…" && git push        # → hunt-internal

# 2. bump the pointer here
cd ../..
git add src/nextjs && git commit -m "chore: bump frontend submodule" && git push
```

A parent commit that forgets step 2 leaves everyone else on a stale UI.

## Disclaimer

This project is research tooling, not financial advice. Contributions that present output as
investment recommendations, or that add "buy/sell" semantics to the HUNT board, will not be
merged.
