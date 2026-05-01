"""Format-agnostic table I/O.

Reads/writes CSV or Parquet based on file extension. Parquet is preferred for
on-disk caches because it's 5-10× smaller than CSV for our hotspot data and
faster to load. CSV is still supported so existing files (and the FIRMS HTTP
response, which only comes as CSV) keep working.
"""

from __future__ import annotations

import os
from io import StringIO
from typing import Iterable, Optional

import pandas as pd


def _ext(path: str) -> str:
    return os.path.splitext(path)[1].lower()


def resolve_existing(path: str) -> Optional[str]:
    """Return the actual on-disk path, transparently swapping CSV ↔ Parquet.

    If ``path`` exists, return it. Otherwise, if the sibling with the other
    extension exists, return that. Lets callers default to ``foo.parquet`` and
    still pick up a leftover ``foo.csv`` (or vice-versa) without forcing a
    migration. Returns None if neither exists.
    """
    if os.path.exists(path):
        return path
    ext = _ext(path)
    if ext == ".parquet":
        alt = path[: -len(".parquet")] + ".csv"
    elif ext == ".csv":
        alt = path[: -len(".csv")] + ".parquet"
    else:
        return None
    return alt if os.path.exists(alt) else None


def read_table(path: str, **kwargs) -> pd.DataFrame:
    """Read a CSV or Parquet file based on extension; falls back to the sibling format if missing."""
    actual = resolve_existing(path)
    if actual is None:
        raise FileNotFoundError(f"No CSV or Parquet found at {path}")
    if _ext(actual) == ".parquet":
        return pd.read_parquet(actual, **kwargs)
    return pd.read_csv(actual, **kwargs)


def write_table(df: pd.DataFrame, path: str, **kwargs) -> None:
    """Write a CSV or Parquet file based on extension."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    if _ext(path) == ".parquet":
        df.to_parquet(path, index=False, **kwargs)
    else:
        df.to_csv(path, index=False, **kwargs)


def read_csv_text(text: str, **kwargs) -> pd.DataFrame:
    """Parse CSV from a string (used by fetch_firms for the HTTP response body)."""
    return pd.read_csv(StringIO(text), **kwargs)


def list_tables(paths_or_globs: Iterable[str]) -> list[str]:
    """Resolve a mix of files / dirs / globs into concrete table file paths.

    When a directory or glob matches both ``foo.csv`` and ``foo.parquet`` for
    the same basename, the Parquet sibling wins — this prevents row duplication
    after a partial migration.
    """
    import glob

    resolved: list[str] = []
    for p in paths_or_globs:
        if not p:
            continue
        if any(ch in p for ch in "*?["):
            resolved.extend(sorted(glob.glob(p)))
        elif os.path.isdir(p):
            resolved.extend(sorted(glob.glob(os.path.join(p, "*.csv"))))
            resolved.extend(sorted(glob.glob(os.path.join(p, "*.parquet"))))
        elif os.path.exists(p):
            resolved.append(p)
        else:
            alt = resolve_existing(p)
            if alt:
                resolved.append(alt)

    # Dedupe by stem: when both foo.csv and foo.parquet are listed, keep parquet.
    by_stem: dict[str, str] = {}
    for path in resolved:
        stem, ext = os.path.splitext(path)
        ext = ext.lower()
        if stem not in by_stem:
            by_stem[stem] = path
        else:
            existing_ext = os.path.splitext(by_stem[stem])[1].lower()
            if ext == ".parquet" and existing_ext == ".csv":
                by_stem[stem] = path
    return sorted(by_stem.values())
