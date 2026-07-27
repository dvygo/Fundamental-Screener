# Contributing

## Repo shape

This is a monorepo with the Next.js UI vendored as a submodule:

- `src/python/`, `src/nodejs/` — tracked here directly.
- `src/nextjs/` — a **submodule** pointing at
  [hunt-internal](https://github.com/dvygo/hunt-internal). Changing the UI is a
  two-step commit (see [Submodule workflow](#submodule-workflow)).

Clone with `--recurse-submodules`, or run `git submodule update --init src/nextjs`
after a plain clone.

## Dev setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r setup/requirements.txt
cd src/nodejs && npm install        # API deps
cd ../nextjs  && npm install        # UI deps (inside the submodule)
```

Run order for a live stack: MinIO (optional) → Python loaders → `node src/server.js`
(:3000) → `npm run dev` in `src/nextjs` (:3001). See
[context/DEPLOY.md](context/DEPLOY.md).

## The four rules (they are not optional)

1. **Never fabricate a URL.** Fetch only real listing codes / discovered links,
   followed to their final destination.
2. **Cache and pace.** Raw HTML is cached under `data/raw/`; live requests are
   delayed. Re-runs parse from cache, not the network. Respect `robots.txt`.
3. **Degrade gracefully.** A blocked or changed page skips that company and logs
   it — never abort the run, never emit a half-empty record as complete.
4. **Outputs vs raw.** Parsed JSON/CSV goes to `data/` and is committed; raw HTML
   and re-fetchable bundles stay local (gitignored).

Read [context/sources.md](context/sources.md) before touching any scraper.

## Secrets — never commit them

- screener.in credentials live in **`src/nodejs/.env`** (gitignored). They must
  **never** be staged.
- `data/raw/` (cached HTML, `today.xml`) and each package's `.env*` are gitignored.
- Run the secret guard before every commit:

  ```bash
  git diff --cached --name-only | grep -E '\.env$|today\.xml|data/raw/'
  ```

  Any output = stop and unstage. It must be empty.

## Commits

- Commit only what was asked; on `main`, commit directly (established workflow).
- End co-authored commit messages with the standard trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## Submodule workflow

The frontend evolves in `hunt-internal`; this repo records a pinned commit.

```bash
# 1. change + ship the UI (inside the submodule)
cd src/nextjs
#    ...edit... then, with tsc + eslint clean:
git add -A && git commit -m "…" && git push        # → hunt-internal

# 2. bump the pointer here
cd ../..
git add src/nextjs && git commit -m "chore: bump frontend submodule" && git push
```

A parent commit that forgets step 2 leaves collaborators on a stale UI.

## Code style

- **Python** — match the surrounding module's idiom; loaders are idempotent and
  checkpointed. Static-file extraction stays in Python.
- **Node** — ESM (`"type": "module"`). All screen SQL lives in `src/nodejs/src/db.js`
  (base views) and `screens.js` — keep it there, don't inline ad-hoc SQL in routes.
  Query params interpolated into DuckDB SQL must be validated integers.
- **Frontend** — see the submodule's own `CONTRIBUTING.md`; `tsc --noEmit` and
  `eslint` must be clean before you push.
