"""SP-G registry-conformance: Python emits the byte-identical canonical manifest.

Walks the assembled core ``TypeRegistry`` (the full default provider set the
metamodel conformance runner composes — ``core_providers`` = core types +
DB-domain + documentation + template/output, mirroring TS's ``coreProviders``)
and asserts the emitted manifest is byte-identical to the single committed
canonical, ``fixtures/registry-conformance/expected-registry.json`` — the
cross-port logical-vocabulary contract (see that file's README). The canonical
includes the DB-domain field attrs (``@column`` / ``@dbColumnType``) and the
template/output ``@xmlText`` field marker, so the registry must compose the
full provider set (not just core + documentation).
"""
from __future__ import annotations

from pathlib import Path

from metaobjects.core_types import core_providers
from metaobjects.provider import compose_registry
from metaobjects.registry_manifest import (
    ExclusionReason,
    classify_per_type_attr,
    classify_type_subtype,
    emit_registry_manifest,
)


def _registry_conformance_canonical() -> Path:
    """Locate fixtures/registry-conformance/expected-registry.json (no hardcoded paths)."""
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "fixtures" / "registry-conformance" / "expected-registry.json"
        if candidate.is_file():
            return candidate
    raise RuntimeError(
        "could not locate fixtures/registry-conformance/expected-registry.json from "
        + str(here)
    )


def test_python_registry_matches_canonical() -> None:
    # The core registry — the same provider set the metamodel conformance runner
    # composes by default (see tests/conformance/conformance_adapter.py).
    registry = compose_registry(core_providers)
    actual = emit_registry_manifest(registry)
    expected = _registry_conformance_canonical().read_text(encoding="utf-8")

    # Newline-normalize (guard against CRLF on the committed canonical) — the
    # contract is otherwise byte-exact, including the single trailing newline.
    assert actual.replace("\r\n", "\n") == expected.replace("\r\n", "\n"), (
        "SP-G registry-conformance: Python's emitted metamodel registry manifest "
        "diverges from the cross-port canonical "
        "(fixtures/registry-conformance/expected-registry.json). "
        "Fix the Python registration to match the cross-port contract "
        "(canonical/TS is the source of truth), or escalate if TS is wrong."
    )


# Wave 3b — the in/out boundary is an EXPLICIT classification (a reason category
# per carve-out), not a bare name-match.
def test_every_registered_per_type_attr_is_explicitly_classified() -> None:
    registry = compose_registry(core_providers)
    for definition in registry._defs.values():  # noqa: SLF001 (no public iterator)
        for attr in definition.attrs:
            # Total function — always a defined ExclusionReason member, no silent default.
            assert isinstance(classify_per_type_attr(attr.name), ExclusionReason)


def test_carve_outs_carry_their_declared_reason_category() -> None:
    assert classify_per_type_attr("extends") is ExclusionReason.STRUCTURAL_KEYWORD
    assert classify_per_type_attr("isArray") is ExclusionReason.STRUCTURAL_KEYWORD
    assert classify_per_type_attr("object") is ExclusionReason.NATIVE_BINDING
    assert classify_per_type_attr("objectAdapter") is ExclusionReason.NATIVE_BINDING
    assert classify_per_type_attr("description") is ExclusionReason.COMMON_ATTR_DUP
    # Genuinely logical attrs are INCLUDED.
    assert classify_per_type_attr("column") is ExclusionReason.INCLUDED
    assert classify_per_type_attr("maxLength") is ExclusionReason.INCLUDED
    # Row classification.
    assert classify_type_subtype("metadata", "base") is ExclusionReason.INHERITANCE_ANCHOR
    assert classify_type_subtype("view", "dropdown") is ExclusionReason.PRESENTATION_ONLY
    assert classify_type_subtype("view", "currency") is ExclusionReason.INCLUDED
