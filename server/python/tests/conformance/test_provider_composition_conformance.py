"""Provider-composition conformance runner (Python port).

Five registry/provider error codes are Tier-1 cross-port invariants that the
metadata-input -> error corpus cannot reach: they are triggered by HOW providers
are composed and sealed, not by any metadata document. This runner gates them
from the shared corpus at fixtures/provider-composition-conformance/.

Each port supplies the SAME canonical named-provider set (see the corpus
README). A manifest names providers by id; the runner maps names -> provider
objects, composes, and asserts the surfaced .code. The registry-sealed scenario
composes, seals, then runs a probe provider's register_types against the sealed
registry.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.core_types import core_providers
from metaobjects.errors import ErrorCode, ParseError
from metaobjects.loader.meta_data_loader import MetaDataLoader
from metaobjects.meta.core.attr.attr_constants import ATTR_SUBTYPE_INT
from metaobjects.meta.presentation.view.view_constants import VIEW_SUBTYPE_CURRENCY
from metaobjects.provider import Provider, compose_registry
from metaobjects.registry import AttrSchema, ChildRule, TypeDefinition, TypeRegistry
from metaobjects.meta.template.meta_template import MetaTemplate
from metaobjects.shared.base_types import TYPE_ATTR, TYPE_VIEW

# Fresh, otherwise-unused template subtype the attr-conflict / seal providers use.
_CONFLICT_SUBTYPE = "compositionprobe"
_CONFLICT_ATTR = "conflictAttr"


def _corpus_root() -> Path:
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "fixtures" / "provider-composition-conformance"
        if candidate.is_dir():
            return candidate
    raise RuntimeError("could not locate fixtures/provider-composition-conformance from " + str(here))


def _noop_provider(provider_id: str, *deps: str) -> Provider:
    return Provider(provider_id, dependencies=tuple(deps))


def _attr_conflict_base_provider() -> Provider:
    """Registers a fresh test-only type carrying a single string attr."""
    p = Provider("attr-conflict-base")
    p.add(
        TypeDefinition(
            type="template",
            sub_type=_CONFLICT_SUBTYPE,
            factory=lambda t, s, n: MetaTemplate(t, s, n),
            attrs=[AttrSchema(_CONFLICT_ATTR, "string")],
            child_rules=[ChildRule(TYPE_ATTR, "*")],
        )
    )
    return p


class _AttrConflictClashProvider(Provider):
    """Extends the base's type, redefining the same attr name -> attr conflict."""

    def __init__(self) -> None:
        super().__init__("attr-conflict-clash", dependencies=("attr-conflict-base",))

    def register_types(self, registry: TypeRegistry) -> None:  # noqa: D401
        registry.extend(
            "template",
            _CONFLICT_SUBTYPE,
            attributes=[AttrSchema(_CONFLICT_ATTR, "string")],
        )


class _SealProbeProvider(Provider):
    """Attempts a mutating registration — throws against a sealed registry."""

    def __init__(self) -> None:
        super().__init__("seal-probe")

    def register_types(self, registry: TypeRegistry) -> None:  # noqa: D401
        registry.register(
            TypeDefinition(
                type="template",
                sub_type="sealprobe",
                factory=lambda t, s, n: MetaTemplate(t, s, n),
                attrs=[],
                child_rules=[],
            )
        )


class _ExtendSpecSubtypeProvider(Provider):
    """#265 `compose-load/` canonical named provider. Extends `view.currency` (a
    SPEC-DECLARED CORE subtype the library's own core-types provider registers)
    with a new `decimals` int attr. Deliberately NO dependencies — see the corpus
    README "Canonical named provider `extend-spec-subtype`" for why (cross-port
    id/dep parity vs. the `composeWithCore` ordering contract).
    """

    def __init__(self) -> None:
        super().__init__("extend-spec-subtype")

    def register_types(self, registry: TypeRegistry) -> None:  # noqa: D401
        registry.extend(
            TYPE_VIEW,
            VIEW_SUBTYPE_CURRENCY,
            attributes=[
                AttrSchema(
                    "decimals",
                    ATTR_SUBTYPE_INT,
                    required=False,
                    description="Test-only — #265 compose-load probe attr.",
                )
            ],
        )


def _providers() -> dict[str, Provider]:
    return {
        "duplicate-x": _noop_provider("duplicate-x"),
        # Same `.id` as duplicate-x — surfaces ERR_PROVIDER_DUPLICATE_ID at compose time.
        "duplicate-x-clone": _noop_provider("duplicate-x"),
        "depends-on-missing": _noop_provider("depends-on-missing", "does-not-exist"),
        "cycle-a": _noop_provider("cycle-a", "cycle-b"),
        "cycle-b": _noop_provider("cycle-b", "cycle-a"),
        "attr-conflict-base": _attr_conflict_base_provider(),
        "attr-conflict-clash": _AttrConflictClashProvider(),
        "seal-probe": _SealProbeProvider(),
        "extend-spec-subtype": _ExtendSpecSubtypeProvider(),
    }


def _resolve(providers: dict[str, Provider], pid: str) -> Provider:
    p = providers.get(pid)
    if p is None:
        raise ValueError(f'Unknown named provider "{pid}" in provider-composition corpus')
    return p


def _manifest_files() -> list[Path]:
    return sorted(_corpus_root().glob("*.json"))


def _compose_load_corpus_root() -> Path:
    return _corpus_root() / "compose-load"


def _compose_load_manifest_files() -> list[Path]:
    return sorted(_compose_load_corpus_root().glob("*.json"))


def _error_code(exc: object) -> str:
    # Accepts both a caught exception (ParseError) and a MetaError — both carry
    # a `.code: ErrorCode` attribute; only the container differs (raised vs.
    # collected in `LoadResult.errors`).
    code = getattr(exc, "code", None)
    if isinstance(code, ErrorCode):
        return code.value
    if isinstance(code, str):
        return code
    return "ERR_UNKNOWN"


def test_corpus_non_empty() -> None:
    assert len(_manifest_files()) > 0


@pytest.mark.parametrize("manifest_path", _manifest_files(), ids=lambda p: p.name)
def test_provider_composition(manifest_path: Path) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    providers = _providers()
    expected = manifest["expectedError"]
    resolved = [_resolve(providers, pid) for pid in manifest["providers"]]

    if "sealThenRegister" in manifest:
        # Compose (must succeed), seal, then run the probe against the sealed registry.
        registry = compose_registry(resolved)
        registry.seal()
        probe = _resolve(providers, manifest["sealThenRegister"])
        with pytest.raises(ParseError) as exc_info:
            probe.register_types(registry)
        assert _error_code(exc_info.value) == expected
        return

    # Ordinary scenario: the compose call itself throws.
    with pytest.raises(ParseError) as exc_info:
        compose_registry(resolved)
    assert _error_code(exc_info.value) == expected


# ---------------------------------------------------------------------------
# #265 `compose-load/` corpus — see the corpus README "The `compose-load/`
# subdir". Own directory, own loop: a manifest here never carries
# `expectedError` / `sealThenRegister` (the flat-corpus shape above); it
# carries `composeWithCore` / `expectAttrs` / `metadata` / `expectErrors`
# instead.
# ---------------------------------------------------------------------------


def test_compose_load_corpus_non_empty() -> None:
    assert len(_compose_load_manifest_files()) > 0


@pytest.mark.parametrize("manifest_path", _compose_load_manifest_files(), ids=lambda p: p.name)
def test_provider_composition_compose_load(manifest_path: Path) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    providers = _providers()
    resolved = [_resolve(providers, pid) for pid in manifest["providers"]]
    provider_list = [*core_providers, *resolved] if manifest.get("composeWithCore") else resolved

    if "expectAttrs" in manifest:
        registry = compose_registry(provider_list)
        expect_attrs = manifest["expectAttrs"]
        declared_names = [a.name for a in registry.attrs_of(expect_attrs["type"], expect_attrs["subType"])]
        for name in expect_attrs["contains"]:
            assert name in declared_names

    if "metadata" in manifest:
        content = json.dumps(manifest["metadata"])
        result = MetaDataLoader.from_string(content, providers=provider_list, strict=True)
        actual_codes = sorted(_error_code(e) for e in result.errors)
        expected_codes = sorted(manifest.get("expectErrors", []))
        assert actual_codes == expected_codes
