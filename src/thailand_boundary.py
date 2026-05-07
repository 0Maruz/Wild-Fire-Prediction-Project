"""Thailand-only spatial filter.

The FIRMS BBOX (`96,4,107,22`) is a rectangle that necessarily includes
parts of Myanmar, Laos, Cambodia, Vietnam, and northern Malaysia. For a
Thailand-focused dashboard those neighbour-country cells are noise — the
model trained on them, but the operator only cares about the Thai outcome.

This module loads the 77-province Thailand boundary GeoJSON, merges it into
a single MultiPolygon at import time, and exposes a vectorised
``is_in_thailand(lats, lons)`` predicate. Used to drop predictions outside
the Thai land border at inference time.

Boundary source: https://github.com/apisit/thailand.json (CC BY 4.0)
"""

from __future__ import annotations

import json
import os
from typing import Iterable

import numpy as np
from shapely.geometry import Point, shape
from shapely.ops import unary_union
from shapely.prepared import prep

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOUNDARY_PATH = os.path.join(BASE_DIR, "data", "boundaries", "thailand.geojson")


def _load_thailand_polygon():
    if not os.path.exists(BOUNDARY_PATH):
        raise FileNotFoundError(
            f"Thailand boundary GeoJSON not found at {BOUNDARY_PATH}. "
            "Restore from https://github.com/apisit/thailand.json/blob/master/thailand.json"
        )
    with open(BOUNDARY_PATH, "r", encoding="utf-8") as f:
        gj = json.load(f)
    geoms = [shape(f["geometry"]) for f in gj["features"]]
    return unary_union(geoms)


# Eagerly construct the merged boundary + a prepared geometry that makes
# repeated `.contains()` calls O(log N) instead of O(N) per query.
_THAILAND = _load_thailand_polygon()
_THAILAND_PREPARED = prep(_THAILAND)
THAILAND_BOUNDS = _THAILAND.bounds  # (min_lon, min_lat, max_lon, max_lat)


def is_in_thailand(lats: Iterable[float], lons: Iterable[float]) -> np.ndarray:
    """Return a boolean array — True where (lat, lon) is inside Thailand's
    land border (any of the 77 provinces)."""
    lats_arr = np.asarray(lats, dtype=float)
    lons_arr = np.asarray(lons, dtype=float)
    if lats_arr.shape != lons_arr.shape:
        raise ValueError("lats and lons must have the same length")

    # Cheap bbox short-circuit before the polygon query — eliminates points
    # that are obviously outside (most cells in the wider FIRMS BBOX).
    min_lon, min_lat, max_lon, max_lat = THAILAND_BOUNDS
    inside = (
        (lats_arr >= min_lat) & (lats_arr <= max_lat)
        & (lons_arr >= min_lon) & (lons_arr <= max_lon)
    )

    # Polygon test only for points that survive the bbox cut.
    candidates = np.where(inside)[0]
    for idx in candidates:
        if not _THAILAND_PREPARED.contains(Point(lons_arr[idx], lats_arr[idx])):
            inside[idx] = False
    return inside
