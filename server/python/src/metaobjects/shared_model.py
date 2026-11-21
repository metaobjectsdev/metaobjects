"""FR-023 §4.3 — the shared-model CONTRACT, publisher side: the flattened shared-model artifact
and the manifest that pins it, the pair a consumer's ``deps sync`` copies into its own repo and
verifies.

Mirrors ``build-shared-model.ts`` in ``codegen-ts`` (and ``SharedModel`` in the JVM and C#
ports), and is held to it by the shared ``fixtures/shared-model-conformance/`` corpus: the
artifact and manifest bytes are the contract, so a project that changes which port publishes
sees no spurious ``drifted``.

Two stages, both pure of the run, and both in the package on purpose. A generator that an
application owns decides which source files may contribute and which version is published, and
calls these for everything a consumer checks: what is selected, that the selection is closed,
the document's bytes, the hash over them, and the manifest's shape and file names. An owned copy
that changed any of those would publish an artifact a consumer's sync refuses, or worse,
accepts and cannot load, so they are not in the copy.

:func:`build_shared_model` (design §4.3 steps 1 to 5), in order:

1. Standalone, strict load of ``files`` with the run's composed providers (the SAME vocabulary
   the project's own metadata loaded with).
2. Select the top-level nodes matching the compiled include/exclude scope. Never ``template.*``
   (a publisher's prompts are not a consumer's shapes), and never ``requirement.*`` unless the
   publisher opts in with ``requirements`` (default off): a published ledger is design a
   consumer can choose to inherit, so publishing one is the publisher's decision.
3. Closure check: every ``extends`` target and every ref-bearing attribute value of a selected
   node (and of its own descendants) must resolve to a SELECTED node, else the selection is not
   self-contained and the build fails naming the ``(referrer, target)`` pairs. A selected
   requirement's ``@implementedBy`` claims are followed too: they are deliberately not loader
   references (a planned claim may name a node that does not exist yet), but an exported
   requirement claiming a node the export leaves out would dangle in every consumer that
   inherits it.
4. Serialize the selection with :func:`~metaobjects.serializer_json.serialize_shared_document`.
5. Re-load the emitted document standalone with CORE providers only, strict: a consumer loads
   it with ITS providers, and an export must not need the publisher's non-core vocabulary.

:func:`render_shared_model_files` (step 6): ``<name>.metaobjects.json`` and
``metaobjects.pkg.json``, the manifest carrying the sha256 of the artifact's bytes.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from .core_types import core_providers
from .loader.meta_data_loader import MetaDataLoader
from .loader.sources import InMemoryStringSource, UriSource
from .meta.core.requirement.requirement_constants import REQUIREMENT_ATTR_IMPLEMENTED_BY
from .meta.core.requirement.resolve_claim import resolve_claim_target
from .meta.meta_data import MetaData
from .naming import package_of_resolution_key
from .naming_refs import (
    CHILD_REF_SEP,
    REF_BEARING_ATTR_NAMES,
    is_ref_bearing_attr,
    resolve_object_ref,
)
from .registry_manifest import METAMODEL_VERSION
from .requirement_check import effective_package as effective_requirement_package
from .scope import compile_scope, matches_scope
from .serializer_json import serialize_shared_document
from .shared.base_types import TYPE_REQUIREMENT, TYPE_TEMPLATE
from .shared.separators import PACKAGE_SEP

#: The FR-023 manifest/artifact file conventions (design §3.2, §4.3, "Hash format"), the same
#: values as ``dependencies.py`` and every other port.
MANIFEST_FILE = "metaobjects.pkg.json"
ARTIFACT_SUFFIX = ".metaobjects.json"
INTEGRITY_PREFIX = "sha256-"
#: design §3.2 — the manifest schema's own version, distinct from ``metamodelVersion``.
MANIFEST_SCHEMA_VERSION = 1

#: Why a publish was refused: the contract the conformance corpus pins (the message is not).
REASON_EMPTY_SELECTION = "empty-selection"
REASON_NOT_CLOSED = "not-closed"
REASON_NON_CORE_VOCABULARY = "non-core-vocabulary"


class SharedModelError(ValueError):
    """A publish the contract refuses. ``reason`` is one of the ``REASON_*`` constants;
    ``pairs`` is, for ``not-closed``, the exhaustive ``(referrer, target)`` resolution keys the
    selection leaves dangling, sorted by referrer then target."""

    def __init__(self, reason: str, message: str, pairs: Sequence[tuple[str, str]] = ()) -> None:
        super().__init__(message)
        self.reason = reason
        self.pairs = tuple(pairs)


@dataclass(frozen=True)
class SharedModel:
    """A selection that passed every check, serialized. Produced by :func:`build_shared_model`
    and consumed by :func:`render_shared_model_files`; nothing else should construct or change
    one, because ``document`` is exactly the bytes that were re-loaded with core vocabulary and
    the manifest's hash is taken over them."""

    name: str
    #: The canonical-JSON ``metadata.root`` document: the artifact's bytes.
    document: str
    #: The metadata packages the selection spans, sorted.
    packages: tuple[str, ...]
    #: The resolution key of every selected top-level node, sorted.
    nodes: tuple[str, ...]


@dataclass(frozen=True)
class SharedModelFiles:
    """The two files a shared model is published as: ``(path, content)`` each."""

    artifact: tuple[str, str]
    manifest: tuple[str, str]


def artifact_file_name(name: str) -> str:
    """``<name>.metaobjects.json``: the artifact's file name, as ``deps sync`` reads it."""
    return f"{name}{ARTIFACT_SUFFIX}"


def _ref_owner(ref: str) -> str:
    """The object part of a possibly dotted ref: everything before the first child separator
    that follows the LAST package separator (package segments never fold onto a non-root
    child, so a ``.`` before the final ``::`` segment cannot occur)."""
    last = ref.rfind(PACKAGE_SEP)
    start = 0 if last == -1 else last + len(PACKAGE_SEP)
    dot = ref.find(CHILD_REF_SEP, start)
    return ref if dot == -1 else ref[:dot]


def _walk_own(node: MetaData) -> list[MetaData]:
    """A node and its OWN descendants, node itself first. ADR-0039 sanctioned own-only case:
    ``serialize_shared_document`` emits each selected node's OWN layer only (``extends``
    preserved, not flattened), so the closure check walks exactly what will be emitted, never
    what ``extends`` would additionally contribute (that is the base's own layer, checked
    separately if the base is itself selected)."""
    out = [node]
    for child in node.own_children():  # ADR-0039 sanctioned own: see the docstring
        out.extend(_walk_own(child))
    return out


def _check_closure(
    root: MetaData, selected: Sequence[MetaData], selected_keys: set[str]
) -> list[tuple[str, str]]:
    """design §4.3 step 3. ``root`` already loaded (step 1), so every ref found here resolves
    to some node in it: the loader's own validation rejects a dangling ``extends`` or object
    ref before this runs. What is not guaranteed is that the resolved node is selected."""
    pairs: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for top in selected:
        referrer_key = top.resolution_key()
        for node in _walk_own(top):
            referrer_pkg = node.effective_package() or ""
            candidates: list[str] = []
            if node.super_ref is not None:
                candidates.append(node.super_ref)
            # ADR-0039 sanctioned own-only case (same rationale as _walk_own): an INHERITED
            # ref-bearing attr belongs to the base node's own layer and is checked when the
            # base itself is walked; reading it through the resolving accessor here would
            # attribute the base's reference to this node.
            own = node.own_attrs()
            for attr_name in sorted(REF_BEARING_ATTR_NAMES):
                if not is_ref_bearing_attr(node, attr_name):
                    continue
                value = own.get(attr_name)
                if isinstance(value, str):
                    candidates.append(value)
            targets: list[MetaData] = []
            for raw in candidates:
                resolved = resolve_object_ref(root, _ref_owner(raw), referrer_pkg)
                if resolved is not None:  # else already refused at load: defensive only
                    targets.append(resolved)
            if node.type == TYPE_REQUIREMENT:
                # `@implementedBy` resolves with the requirement's own resolver, in the
                # requirement's effective package (ADR-0042), owner segment only: a member
                # claim (`Customer.email`) is closed when its owner is selected. A claim that
                # resolves nothing names nothing the export could carry (a planned requirement
                # may name a node that does not exist yet), so it is not a pair.
                claims = own.get(REQUIREMENT_ATTR_IMPLEMENTED_BY)
                claim_pkg = effective_requirement_package(node)  # type: ignore[arg-type]
                for ref in claims if isinstance(claims, list) else []:
                    if not isinstance(ref, str):
                        continue
                    owner = resolve_claim_target(root, ref.split(CHILD_REF_SEP)[0], claim_pkg)
                    if owner is not None:
                        targets.append(owner)
            for resolved in targets:
                target_key = resolved.resolution_key()
                if target_key in selected_keys:
                    continue
                pair = (referrer_key, target_key)
                if pair in seen:
                    continue
                seen.add(pair)
                pairs.append(pair)
    return sorted(pairs)


def build_shared_model(
    name: str,
    files: Sequence[str | Path],
    include: Sequence[str],
    exclude: Sequence[str] = (),
    *,
    requirements: bool = False,
    providers: Sequence[object] = (),
) -> SharedModel:
    """Load ``files`` standalone, select by ``include`` / ``exclude``, and return the selection
    as a checked, serialized shared model (design §4.3 steps 1 to 5).

    ``providers`` are the run's own consumer-supplied providers, honoured exactly as they were
    for the project's main load (core vocabulary is always included). Raises
    :class:`SharedModelError` when the selection is empty, is not closed, or needs vocabulary a
    consumer's toolchain does not ship; any load error of ``files`` is raised as a
    :class:`ValueError` carrying its code and message."""
    # Step 1 — standalone, strict load with the run's composed providers.
    loader = MetaDataLoader(providers=[*core_providers, *providers], strict=True)
    loaded = loader.load([UriSource(Path(f).resolve().as_uri()) for f in files])
    if loaded.errors:
        first = loaded.errors[0]
        raise ValueError(f"sharedModel({name!r}): {first.code}: {first.message}")
    root = loaded.root

    # Step 2 — select top-level nodes. ADR-0039 sanctioned own: the root never extends, so its
    # own children ARE its effective children.
    compiled = compile_scope(include, exclude)
    selected = [
        n
        for n in root.own_children()
        if n.type != TYPE_TEMPLATE
        and (requirements or n.type != TYPE_REQUIREMENT)
        and matches_scope(n.resolution_key(), compiled)
    ]
    if not selected:
        dropped = "template.*" if requirements else "requirement.* and template.*"
        raise SharedModelError(
            REASON_EMPTY_SELECTION,
            f"sharedModel({name!r}): selected no nodes (include/exclude, always excluding "
            f"{dropped}); nothing to publish. Check `include`.",
        )

    # Step 3 — closure.
    selected_keys = {n.resolution_key() for n in selected}
    failures = _check_closure(root, selected, selected_keys)
    if failures:
        template_keys = {
            n.resolution_key() for n in root.own_children() if n.type == TYPE_TEMPLATE
        }
        lines = "\n".join(
            f"  {referrer} -> {target}: "
            + (
                "templates are never exported; exclude the referrer"
                if target in template_keys
                else "include it or exclude the referrer"
            )
            for referrer, target in failures
        )
        raise SharedModelError(
            REASON_NOT_CLOSED,
            f"sharedModel({name!r}): the selection is not closed; these references point "
            f"outside it:\n{lines}",
            failures,
        )

    # Step 4 — serialize (sorted by resolution key; the callee also refuses an unpackaged node).
    document = serialize_shared_document(selected)

    # Step 5 — re-load with CORE providers only, strict. A consumer loads this artifact with
    # ITS providers, never the publisher's, so an export needing publisher-only vocabulary must
    # fail here, not at the consumer.
    core = MetaDataLoader(providers=list(core_providers), strict=True).load(
        [InMemoryStringSource(document, id=artifact_file_name(name))]
    )
    if core.errors:
        first = core.errors[0]
        raise SharedModelError(
            REASON_NON_CORE_VOCABULARY,
            f"sharedModel({name!r}): the export needs a provider this toolchain does not "
            f"ship; exports must load with core vocabulary: {first.message}",
        )

    return SharedModel(
        name=name,
        document=document,
        packages=tuple(sorted({package_of_resolution_key(k) for k in selected_keys})),
        nodes=tuple(sorted(selected_keys)),
    )


def render_shared_model_files(model: SharedModel, version: str) -> SharedModelFiles:
    """The artifact and the manifest that pins it (design §4.3 step 6, §3.2), as the two files
    a consumer's ``deps sync`` reads: the manifest names the artifact and carries the sha256 of
    its bytes, so the pair is rendered together and never one without the other."""
    artifact_path = artifact_file_name(model.name)
    integrity = INTEGRITY_PREFIX + hashlib.sha256(model.document.encode("utf-8")).hexdigest()
    manifest = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "name": model.name,
        "version": version,
        "metamodelVersion": METAMODEL_VERSION,
        "artifact": artifact_path,
        "integrity": integrity,
        "packages": list(model.packages),
        "nodes": list(model.nodes),
    }
    return SharedModelFiles(
        artifact=(artifact_path, model.document),
        manifest=(MANIFEST_FILE, json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"),
    )
