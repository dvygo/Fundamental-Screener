#!/usr/bin/env python3
"""Push data/ to a Google Drive shared drive as timestamped snapshots (rclone).

A thin Python wrapper around the rclone binary (Go) — same ELT discipline as the
rest of src/python. Auth is a Google **service account** (JSON key), targeting the
"Fundamental-Screener" shared drive. rclone is driven with an on-the-fly `:drive:`
remote, so there's no rclone.conf to manage.

Design — **manual, append-only snapshots**:
  * Each `push` copies the WHOLE data/ into a fresh folder `data-YYYYMMDD_T_HHMMSS`.
  * It uses rclone **copy**, never sync — nothing on the drive is ever deleted, so
    losing local files never touches earlier snapshots.
  * There is no automation and no restore-mirror: you run pushes yourself, and
    disaster recovery is downloading a snapshot by hand (`pull`, or the Drive UI).
  * Trade-off: every push uploads the full ~data size again (no cross-snapshot
    dedup) — that's the point (independent, immutable point-in-time copies).

The JSON key is a SECRET: gitignored, copied to each server's root by hand. This
script never prints or commits it — only its *path* is passed to rclone.

Config — env vars, or a gitignored `.data-sync.env` at the repo root (see
`setup/data_sync.env.example`); env wins, then .data-sync.env, then the defaults:
    FS_RCLONE_SA_FILE      path to the service-account JSON key
    FS_RCLONE_DRIVE_ID     shared-drive (team drive) id
    FS_RCLONE_REMOTE_ROOT  optional parent folder for the snapshots (default: drive root)

Usage:
    python src/python/data_sync.py config              # resolved config (no secrets)
    python src/python/data_sync.py drives              # list shared drives (auth test)
    python src/python/data_sync.py push [--dry-run]    # data/ -> drive:data-<ts>  (copy)
    python src/python/data_sync.py ls                  # list existing snapshots
    python src/python/data_sync.py pull <snapshot> [dest]   # download a snapshot (additive)
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DATA_DIR = REPO / "data"
ENV_FILE = REPO / ".data-sync.env"

# Non-secret defaults (overridable via env / .data-sync.env). The drive id is just
# an identifier, not a credential — safe to ship; the key it authenticates with is not.
DEFAULT_DRIVE_ID = "0AP0BEyLWWv-zUk9PVA"  # shared drive "Fundamental-Screener"
DEFAULT_REMOTE_ROOT = ""  # empty = drive root; snapshots are top-level data-<ts>
DEFAULT_SA_FILE = REPO / "fundamental-screener-503703-e380e2e89533.json"

SNAPSHOT_FMT = "data-%Y%m%d_T_%H%M%S"  # e.g. data-20260727_T_094512 (local time)

# OS cruft we never want mirrored.
EXCLUDES = [".DS_Store", "**/.DS_Store", "**/__pycache__/**", "**/*.pyc"]
# Drive-friendly transfer tuning: --fast-list cuts API calls on big trees.
XFER = ["--fast-list", "--transfers", "8", "--checkers", "16",
        "--drive-chunk-size", "64M", "--stats", "10s", "--stats-one-line", "-v"]


def load_env_file(path: Path) -> None:
    """Load simple KEY=VALUE lines from a gitignored .data-sync.env (no override)."""
    if not path.is_file():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def cfg() -> tuple[Path, str, str]:
    load_env_file(ENV_FILE)
    sa = Path(os.environ.get("FS_RCLONE_SA_FILE", str(DEFAULT_SA_FILE))).expanduser()
    drive_id = os.environ.get("FS_RCLONE_DRIVE_ID", DEFAULT_DRIVE_ID).strip()
    remote_root = os.environ.get("FS_RCLONE_REMOTE_ROOT", DEFAULT_REMOTE_ROOT).strip("/")
    return sa, drive_id, remote_root


def require_rclone() -> None:
    if not shutil.which("rclone"):
        sys.exit("rclone not found. Install it:  brew install rclone  "
                 "(or see https://rclone.org/install)")


def team_flags(sa: Path, drive_id: str) -> list[str]:
    if not sa.is_file():
        sys.exit(f"service-account key not found: {sa}\n"
                 "Set FS_RCLONE_SA_FILE (or drop the JSON key there — it's gitignored).")
    flags = ["--drive-service-account-file", str(sa), "--drive-scope", "drive"]
    if drive_id:
        flags += ["--drive-team-drive", drive_id]
    return flags


def remote(remote_root: str, sub: str = "") -> str:
    """On-the-fly rclone remote into the shared drive: ':drive:<root>/<sub>'."""
    path = "/".join(p for p in (remote_root, sub) if p)
    return f":drive:{path}"


def excludes() -> list[str]:
    return [x for e in EXCLUDES for x in ("--exclude", e)]


def run(args: list[str]) -> int:
    print("+ rclone " + " ".join(args), file=sys.stderr)
    return subprocess.call(["rclone", *args])


def cmd_config(_args) -> int:
    sa, drive_id, root = cfg()
    print(f"repo          {REPO}")
    print(f"local data    {DATA_DIR}")
    print(f"SA key        {sa}  ({'found' if sa.is_file() else 'MISSING'})")
    print(f"drive id      {drive_id or '(unset)'}")
    print(f"snapshot dest {remote(root, 'data-<ts>')}   (copy, append-only)")
    print(f"env file      {ENV_FILE}  ({'present' if ENV_FILE.is_file() else 'absent'})")
    print(f"rclone        {shutil.which('rclone') or 'NOT INSTALLED'}")
    return 0


def cmd_drives(_args) -> int:
    sa, _, _ = cfg()
    require_rclone()
    # no team-drive flag needed — we're enumerating the drives themselves.
    return run(["backend", "drives", ":drive:", *team_flags(sa, "")])


def cmd_push(args) -> int:
    sa, drive_id, root = cfg()
    require_rclone()
    snapshot = datetime.now().strftime(SNAPSHOT_FMT)
    dest = remote(root, snapshot)
    print(f"snapshot: {dest}", file=sys.stderr)
    # copy (never sync) into a NEW folder — append-only, deletes nothing.
    a = ["copy", str(DATA_DIR), dest, *team_flags(sa, drive_id), *XFER, *excludes()]
    if args.dry_run:
        a.append("--dry-run")
    return run(a)


def cmd_ls(_args) -> int:
    sa, drive_id, root = cfg()
    require_rclone()
    # lsd = list the snapshot folders. `rclone size <remote>` gives totals.
    return run(["lsd", remote(root), *team_flags(sa, drive_id)])


def cmd_pull(args) -> int:
    sa, drive_id, root = cfg()
    require_rclone()
    dest = Path(args.dest) if args.dest else (REPO / "restore" / args.snapshot)
    # copy = additive; never deletes anything already in dest.
    a = ["copy", remote(root, args.snapshot), str(dest), *team_flags(sa, drive_id), *XFER, *excludes()]
    if args.dry_run:
        a.append("--dry-run")
    print(f"restoring {remote(root, args.snapshot)} -> {dest}", file=sys.stderr)
    return run(a)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="rclone snapshot push of data/ -> the Fundamental-Screener shared drive")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("config", help="show resolved config (no secrets)").set_defaults(fn=cmd_config)
    sub.add_parser("drives", help="list shared drives the service account can see").set_defaults(fn=cmd_drives)

    pp = sub.add_parser("push", help="copy data/ into a new drive:data-<timestamp> snapshot")
    pp.add_argument("--dry-run", action="store_true", help="show what would upload, change nothing")
    pp.set_defaults(fn=cmd_push)

    sub.add_parser("ls", help="list existing snapshots on the drive").set_defaults(fn=cmd_ls)

    pl = sub.add_parser("pull", help="download a snapshot (additive; DR is manual)")
    pl.add_argument("snapshot", help="snapshot folder name, e.g. data-20260727_T_094512")
    pl.add_argument("dest", nargs="?", help="local destination (default: ./restore/<snapshot>)")
    pl.add_argument("--dry-run", action="store_true")
    pl.set_defaults(fn=cmd_pull)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
