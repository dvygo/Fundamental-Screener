#!/usr/bin/env python3
"""Push data/ to a Google Drive shared drive as compressed timestamped snapshots.

A thin Python wrapper around `tar` + the rclone binary (Go) — same ELT discipline
as the rest of src/python. Auth is a Google **service account** (JSON key),
targeting the "Fundamental-Screener" shared drive via an on-the-fly `:drive:`
remote (no rclone.conf to manage).

Design — **manual, append-only, compressed snapshots**:
  * Each `push` tars+gzips the WHOLE data/ into one archive `data-YYYYMMDD_T_HHMMSS.tar.gz`
    and uploads that single file (rclone copyto). One big file, not thousands of
    tiny ones — avoids Drive's crippling per-file API overhead.
  * Append-only: a new archive each time; nothing on the drive is ever deleted, so
    losing local files can't touch earlier snapshots. (Prune old archives yourself.)
  * No automation: you run pushes; disaster recovery is `pull` (or the Drive UI)
    then `tar xzf`.

The JSON key is a SECRET: gitignored, copied to each server's root by hand. This
script never prints or commits it — only its *path* is passed to rclone.

Config — env vars, or a gitignored `.data-sync.env` at the repo root (see
`setup/data_sync.env.example`); env wins, then .data-sync.env, then the defaults:
    FS_RCLONE_SA_FILE      path to the service-account JSON key
    FS_RCLONE_DRIVE_ID     shared-drive (team drive) id
    FS_RCLONE_REMOTE_ROOT  optional parent folder for the archives (default: drive root)

Usage:
    python src/python/data_sync.py config               # resolved config (no secrets)
    python src/python/data_sync.py drives               # list shared drives (auth test)
    python src/python/data_sync.py push [--dry-run] [--keep]   # tar.gz data/ -> drive
    python src/python/data_sync.py archive [--out PATH]        # build the tar.gz only
    python src/python/data_sync.py ls                          # list snapshots on the drive
    python src/python/data_sync.py pull <archive> [dest] [--extract]  # download a snapshot
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
STAGE_DIR = REPO / ".snapshots"          # local build staging (gitignored)
ENV_FILE = REPO / ".data-sync.env"

# Non-secret defaults (overridable via env / .data-sync.env). The drive id is just
# an identifier, not a credential — safe to ship; the key it authenticates with is not.
DEFAULT_DRIVE_ID = "0AP0BEyLWWv-zUk9PVA"  # shared drive "Fundamental-Screener"
DEFAULT_REMOTE_ROOT = ""  # empty = drive root; archives are top-level data-<ts>.tar.gz
DEFAULT_SA_FILE = REPO / "fundamental-screener-503703-e380e2e89533.json"

SNAPSHOT_FMT = "data-%Y%m%d_T_%H%M%S"  # -> data-20260727_T_094512.tar.gz (local time)
TAR_EXCLUDES = [".DS_Store", "__pycache__", "*.pyc"]  # OS/py cruft, never archived

XFER = ["--drive-chunk-size", "128M", "--stats", "5s", "--stats-one-line", "-v"]


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


def require(tool: str) -> None:
    if not shutil.which(tool):
        hint = "  brew install rclone  (or https://rclone.org/install)" if tool == "rclone" else ""
        sys.exit(f"{tool} not found.{hint}")


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


def run(args: list[str]) -> int:
    print("+ " + " ".join(args), file=sys.stderr)
    return subprocess.call(args)


def human(nbytes: int) -> str:
    val = float(nbytes)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if val < 1024 or unit == "TiB":
            return f"{val:.1f} {unit}"
        val /= 1024
    return f"{nbytes} B"


def build_archive(archive: Path) -> None:
    """tar+gzip data/ into `archive` (relative 'data/...' paths). Uses pigz (parallel
    gzip) when available for speed, else tar's built-in gzip."""
    require("tar")
    archive.parent.mkdir(parents=True, exist_ok=True)
    excludes = [f"--exclude={pat}" for pat in TAR_EXCLUDES]
    if shutil.which("pigz"):
        # tar -C REPO -c data | pigz > archive
        print(f"+ tar -C {REPO} -c data | pigz > {archive}", file=sys.stderr)
        with open(archive, "wb") as out:
            tar = subprocess.Popen(["tar", "-C", str(REPO), *excludes, "-c", "data"],
                                   stdout=subprocess.PIPE)
            pigz = subprocess.Popen(["pigz"], stdin=tar.stdout, stdout=out)
            tar.stdout.close()  # let tar get SIGPIPE if pigz dies
            pigz.communicate()
            tar.wait()
            if tar.returncode or pigz.returncode:
                archive.unlink(missing_ok=True)
                sys.exit(f"archive failed (tar={tar.returncode}, pigz={pigz.returncode})")
    else:
        rc = run(["tar", "-C", str(REPO), *excludes, "-czf", str(archive), "data"])
        if rc:
            archive.unlink(missing_ok=True)
            sys.exit(f"tar failed ({rc})")


def dir_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


# ---- subcommands ---------------------------------------------------------

def cmd_config(_a) -> int:
    sa, drive_id, root = cfg()
    print(f"repo          {REPO}")
    print(f"local data    {DATA_DIR}  ({human(dir_size(DATA_DIR))})" if DATA_DIR.is_dir() else f"local data    {DATA_DIR}  (missing)")
    print(f"stage dir     {STAGE_DIR}")
    print(f"SA key        {sa}  ({'found' if sa.is_file() else 'MISSING'})")
    print(f"drive id      {drive_id or '(unset)'}")
    print(f"archive dest  {remote(root, 'data-<ts>.tar.gz')}   (copy, append-only)")
    print(f"env file      {ENV_FILE}  ({'present' if ENV_FILE.is_file() else 'absent'})")
    print(f"tools         tar={shutil.which('tar') or 'MISSING'}  "
          f"pigz={shutil.which('pigz') or '-'}  rclone={shutil.which('rclone') or 'MISSING'}")
    return 0


def cmd_drives(_a) -> int:
    sa, _, _ = cfg()
    require("rclone")
    # no team-drive flag — we're enumerating the drives themselves.
    return run(["rclone", "backend", "drives", ":drive:", *team_flags(sa, "")])


def cmd_archive(a) -> int:
    name = datetime.now().strftime(SNAPSHOT_FMT) + ".tar.gz"
    archive = Path(a.out) if a.out else (STAGE_DIR / name)
    build_archive(archive)
    print(f"{archive}  ({human(archive.stat().st_size)})")
    return 0


def cmd_push(a) -> int:
    sa, drive_id, root = cfg()
    require("rclone")
    name = datetime.now().strftime(SNAPSHOT_FMT) + ".tar.gz"
    dest = remote(root, name)
    if a.dry_run:
        print(f"[dry-run] would tar.gz {DATA_DIR} ({human(dir_size(DATA_DIR))}) "
              f"-> {STAGE_DIR / name} -> {dest}")
        return 0
    archive = STAGE_DIR / name
    build_archive(archive)
    size = archive.stat().st_size
    print(f"archive {human(size)} -> {dest}", file=sys.stderr)
    # copyto = upload the single file under its exact name.
    rc = run(["rclone", "copyto", str(archive), dest, *team_flags(sa, drive_id), *XFER])
    if a.keep:
        print(f"kept local archive: {archive}", file=sys.stderr)
    else:
        archive.unlink(missing_ok=True)
    return rc


def cmd_ls(_a) -> int:
    sa, drive_id, root = cfg()
    require("rclone")
    # top-level files only (the .tar.gz snapshots) with sizes; ignores any folders.
    return run(["rclone", "lsl", remote(root), "--max-depth", "1", *team_flags(sa, drive_id)])


def cmd_pull(a) -> int:
    sa, drive_id, root = cfg()
    require("rclone")
    dest = Path(a.dest) if a.dest else (REPO / "restore" / a.archive)
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {remote(root, a.archive)} -> {dest}", file=sys.stderr)
    rc = run(["rclone", "copyto", remote(root, a.archive), str(dest), *team_flags(sa, drive_id), *XFER])
    if rc == 0 and a.extract:
        require("tar")
        out = dest.parent
        print(f"extracting -> {out}", file=sys.stderr)
        rc = run(["tar", "-C", str(out), "-xzf", str(dest)])
    return rc


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="compressed rclone snapshot push of data/ -> the Fundamental-Screener shared drive")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("config", help="show resolved config (no secrets)").set_defaults(fn=cmd_config)
    sub.add_parser("drives", help="list shared drives the service account can see").set_defaults(fn=cmd_drives)

    pp = sub.add_parser("push", help="tar.gz data/ and upload as drive:data-<ts>.tar.gz")
    pp.add_argument("--dry-run", action="store_true", help="show the plan; build/upload nothing")
    pp.add_argument("--keep", action="store_true", help="keep the local .tar.gz after upload")
    pp.set_defaults(fn=cmd_push)

    ar = sub.add_parser("archive", help="build the data-<ts>.tar.gz locally only (no upload)")
    ar.add_argument("--out", help="output path (default: .snapshots/data-<ts>.tar.gz)")
    ar.set_defaults(fn=cmd_archive)

    sub.add_parser("ls", help="list snapshots on the drive").set_defaults(fn=cmd_ls)

    pl = sub.add_parser("pull", help="download a snapshot archive (DR is manual)")
    pl.add_argument("archive", help="archive name, e.g. data-20260727_T_094512.tar.gz")
    pl.add_argument("dest", nargs="?", help="local path (default: ./restore/<archive>)")
    pl.add_argument("--extract", action="store_true", help="tar xzf after download")
    pl.set_defaults(fn=cmd_pull)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
