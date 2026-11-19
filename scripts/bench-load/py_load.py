"""Warm-load driver for the Python loader.

usage: py_load.py <model-dir> <timed-loads> [--canonical <out-file>]
env:   MO_PY_SRC  the package's src/ directory (default: this checkout's)
"""
import json
import pathlib
import resource
import os
import statistics
import sys
import time
import warnings

sys.path.insert(0, os.environ.get("MO_PY_SRC") or str(pathlib.Path(__file__).resolve().parents[2] / "server/python/src"))
from metaobjects.loader.meta_data_loader import MetaDataLoader  # noqa: E402
from metaobjects.serializer_json import canonical_serialize  # noqa: E402

warnings.simplefilter("ignore")
directory, n, *rest = sys.argv[1:]
canonical_out = rest[1] if rest[:1] == ["--canonical"] else None


def load():
    r = MetaDataLoader.from_directory(directory)
    if r.errors:
        raise SystemExit(f"load errors: {r.errors[0]}")
    return r


first = load()  # warm-up
if canonical_out:
    pathlib.Path(canonical_out).write_text(canonical_serialize(first.root))
times = []
for _ in range(int(n)):
    t0 = time.perf_counter()
    load()
    times.append((time.perf_counter() - t0) * 1000)
print(json.dumps({"port": "python", "loads": len(times), "median_ms": round(statistics.median(times), 1),
                  "peak_rss_mib": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)}))
