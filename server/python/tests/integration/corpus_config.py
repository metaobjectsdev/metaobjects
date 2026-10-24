"""The project config a conformance corpus pins in its own ``.metaobjects/config.json``."""
from __future__ import annotations

from pathlib import Path

from metaobjects.config.neutral_config import find_project_dir
from metaobjects.meta.meta_data import MetaData
from metaobjects.wire import attach_wire


def attach_corpus_wire(root: MetaData, meta_json: Path) -> MetaData:
    """Set the ``wire`` setting of the corpus holding *meta_json* on *root*, read from the
    nearest ``.metaobjects/config.json`` above it (never a literal), so a generated lane
    writes the form the corpus pins."""
    project = find_project_dir(meta_json.parent)
    if project is None:
        raise RuntimeError(f"no .metaobjects/config.json at or above {meta_json}")
    return attach_wire(root, project)
