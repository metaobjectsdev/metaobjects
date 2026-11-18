#!/usr/bin/env python3
"""Write an N-package load-benchmark model: N copies of the persistence-conformance
fitness model, each under its own root package (fitness_x00 ... fitness_xNN), one file per
copy, so a model N times the size has no name collisions and every reference still resolves.

usage: gen-model.py <copies> <out-dir>
"""
import json
import pathlib
import sys

SRC = pathlib.Path(__file__).resolve().parents[2] / "fixtures/persistence-conformance/canonical/meta.fitness.json"


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    copies, out = int(sys.argv[1]), pathlib.Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    text = SRC.read_text()
    for i in range(copies):
        pkg = f"fitness_x{i:02d}"
        body = text.replace('"package": "fitness"', f'"package": "{pkg}"', 1)
        json.loads(body)  # fail loudly on a bad rewrite
        (out / f"meta.{pkg}.json").write_text(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
