"""The model half of the skip key (ADR-0064 section 3): a hash tree over the LOADED root.

Each root-level node (an object, a shared field, a template node) is hashed in its canonical
EFFECTIVE form (:func:`metaobjects.serializer_json.canonical_serialize_effective`: ``extends``
and overlays applied, attributes in fixed order, no source positions). Node hashes roll up
into one hash per package (sorted ``name:hash`` lines) and one for the model.

Nothing here reads a metadata source file, so a file that is reformatted, reordered or split
in two without changing what loads does not change the key, and an edit to an abstract parent
changes the key of every node that inherits from it. The tree is exposed whole so a later
per-object or per-package key can reuse the node and package hashes.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

from metaobjects.meta.meta_data import MetaData
from metaobjects.serializer_json import canonical_serialize_effective

from .template_codegen.template_data import package_of


@dataclass(frozen=True)
class ModelTree:
    #: resolution key -> sha256 of the node's canonical effective form.
    nodes: dict[str, str] = field(default_factory=dict)
    #: package -> sha256 over its sorted ``resolution-key:node-hash`` lines.
    packages: dict[str, str] = field(default_factory=dict)
    #: sha256 over the sorted ``package:package-hash`` lines.
    model: str = ""


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def node_hash(node: MetaData) -> str:
    """The node's effective canonical form, hashed. The node's own ``package`` attribute is
    dropped from the body: the RESOLVED package is part of its resolution key, so moving a
    node to another file of the same package (which may or may not restate the package)
    does not change it."""
    parsed = json.loads(canonical_serialize_effective(node))
    for body in parsed.values():
        if isinstance(body, dict):
            body.pop("package", None)
    return _sha(json.dumps(parsed, sort_keys=True, ensure_ascii=False))


def build_model_tree(root: MetaData) -> ModelTree:
    # ADR-0039 sanctioned own: top-level scan of the loader ROOT (metadata.root is never
    # extended, so own == effective).
    nodes: dict[str, str] = {}
    by_package: dict[str, list[str]] = {}
    for child in root.own_children():
        key = child.resolution_key()
        digest = node_hash(child)
        nodes[key] = digest
        by_package.setdefault(package_of(child), []).append(f"{key}:{digest}")
    packages = {p: _sha("\n".join(sorted(lines))) for p, lines in by_package.items()}
    model = _sha("\n".join(f"{p}:{h}" for p, h in sorted(packages.items())))
    return ModelTree(nodes, packages, model)
