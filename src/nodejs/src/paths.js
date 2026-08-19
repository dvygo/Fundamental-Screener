// The one place the repo root is computed — and the one place to override it.
//
// WHY IT IS CENTRAL
// Modules used to each derive ROOT from their own __dirname, which worked only
// because every module sat at the same depth. Two things break that:
//
//   * splitting src/ into india/ and us/ puts modules one level deeper, so a
//     hardcoded '../../..' is right for db.js and wrong for them;
//   * `npm run build` bundles every module into ONE file at dist/server.js, so
//     at runtime they all share that file's __dirname regardless of where the
//     source lived — a per-file depth cannot be correct in both modes at once.
//
// Deriving it here, from a file that stays at src/, gives one answer from
// source (src/paths.js -> ../../..) and from the bundle (dist/server.js ->
// ../../..), because src/ and dist/ sit at the same depth under src/nodejs/.
// If this file moves, that equality is what must be preserved.
//
// WHY IT IS OVERRIDABLE
// FS_DATA_ROOT points the API at a different tree without touching code —
// a copy of data/ restored from a snapshot, a second disk, a colleague's
// export. Set it in src/nodejs/.env (see .env.example). Unset, the derived
// path is used, so nothing changes for a normal checkout.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DERIVED = path.resolve(HERE, '..', '..', '..');

const override = (process.env.FS_DATA_ROOT ?? '').trim();

/** Repo root — the directory holding data/. Override with FS_DATA_ROOT. */
export const ROOT = override ? path.resolve(override) : DERIVED;

/** True when ROOT came from the environment rather than the file layout. */
export const ROOT_IS_OVERRIDDEN = Boolean(override);

/** Forward-slashed, for DuckDB globs (it will not take backslashes). */
export const posix = (p) => p.split(path.sep).join('/');

// Fail loudly and immediately on a bad override. An unreadable ROOT otherwise
// surfaces much later as empty screens — every glob matches nothing, which
// looks exactly like "the market was quiet" rather than "the path is wrong".
if (!fs.existsSync(path.join(ROOT, 'data'))) {
  const how = ROOT_IS_OVERRIDDEN ? 'FS_DATA_ROOT' : 'derived from the file layout';
  console.error(`FATAL: no data/ directory under ROOT (${how})\n  ROOT = ${ROOT}`);
  process.exit(1);
}
if (ROOT_IS_OVERRIDDEN) console.log(`ROOT overridden via FS_DATA_ROOT -> ${ROOT}`);
