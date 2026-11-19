#!/usr/bin/env python3
"""Write an N-package load-benchmark model: N copies of the persistence-conformance
fitness model, each under its own root package (fitness_x00 ... fitness_xNN), one file per
copy, so a model N times the size has no name collisions and every reference still resolves.

usage: gen-model.py <copies> <out-dir> [--unique-names]

--unique-names also gives every top-level declaration (and every reference to it) a per-copy
suffix, so the copies share no entity name. The load benchmark does not need that, but a
generation run does: two copies of `Program` collide on a collection name, a shared enum and a
relation, and every generator refuses the model. Without the flag the output is unchanged.
"""
import json
import pathlib
import re
import sys

SRC = pathlib.Path(__file__).resolve().parents[2] / "fixtures/persistence-conformance/canonical/meta.fitness.json"


def top_level_names(doc: dict) -> set[str]:
    """The name of every declaration directly under the root."""
    names = set()
    for child in doc["metadata.root"]["children"]:
        for body in child.values():
            if isinstance(body, dict) and isinstance(body.get("name"), str):
                names.add(body["name"])
    return names


def rename(node, pattern: re.Pattern, suffix: str):
    """Suffix every whole-word occurrence of a top-level name in a string value, so a bare
    reference ("Program") and a path into one ("Program.weeks") both follow the rename."""
    if isinstance(node, str):
        return pattern.sub(lambda m: m.group(0) + suffix, node)
    if isinstance(node, list):
        return [rename(x, pattern, suffix) for x in node]
    if isinstance(node, dict):
        return {k: rename(v, pattern, suffix) for k, v in node.items()}
    return node


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--unique-names"]
    unique = len(args) != len(sys.argv) - 1
    if len(args) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    copies, out = int(args[0]), pathlib.Path(args[1])
    out.mkdir(parents=True, exist_ok=True)
    text = SRC.read_text()
    names = top_level_names(json.loads(text)) if unique else set()
    pattern = re.compile(r"\b(" + "|".join(sorted(map(re.escape, names), key=len, reverse=True)) + r")\b") if names else None
    for i in range(copies):
        pkg = f"fitness_x{i:02d}"
        body = text.replace('"package": "fitness"', f'"package": "{pkg}"', 1)
        if unique:
            body = json.dumps(rename(json.loads(body), pattern, f"X{i:02d}"), indent=2) + "\n"
        json.loads(body)  # fail loudly on a bad rewrite
        (out / f"meta.{pkg}.json").write_text(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
