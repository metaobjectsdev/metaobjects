"""Per-file write decision based on the @generated marker.
Mirrors codegen-ts/src/overwrite-policy.ts. Three-way merge is a later enhancement."""
from __future__ import annotations

import os

from .constants import GENERATED_MARKER

# status: "new" | "overwrite" | "refused" | "skipped"


def decide_and_write(path: str, content: str, strategy: str = "overwrite") -> str:
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(content)
        return "new"

    with open(path, encoding="utf-8") as fh:
        current = fh.read()
    if GENERATED_MARKER not in current:
        return "refused"
    if strategy == "skip-existing":
        return "skipped"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)
    return "overwrite"
