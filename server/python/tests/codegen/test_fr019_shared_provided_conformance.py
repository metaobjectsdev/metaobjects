"""Cross-port FR-019 conformance for Python codegen.

Loads the shared fixture (``fixtures/codegen-conformance/shared-provided-enum/input``) and asserts
the two FR-019 behaviors (ADR-0026):

* Shared materialization — a package-level abstract ``field.enum`` (``Priority``) extended by TWO
  entities is materialized ONCE as a module-level ``class Priority(str, Enum)`` in ``enums.py``;
  both models reference it (``from .enums import Priority``), neither inlines a ``Literal``.
* ``@provided`` — a package-level abstract ``field.enum`` (``Currency``, ``@provided: true``) is NOT
  materialized; consuming models import it from the configured module. A referenced ``@provided``
  enum with no configured module is a codegen-time error naming the enum.
"""
import importlib
import sys
from pathlib import Path

import pytest

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes

import json

from metaobjects import InMemoryStringSource, MetaDataFormat, MetaDataLoader
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import resolve_shared_enum_declaration
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.entity_model import EntityModelGenerator, entity_model
from metaobjects.codegen.runtime.fr019_shared_enum import (
    is_provided,
    materialized_shared_enums,
    resolve_shared_enum_decl,
)
from metaobjects.codegen.runner import run_gen


_FIXTURE_DIR = (
    Path(__file__).resolve().parents[4]
    / "fixtures/codegen-conformance/shared-provided-enum/input"
)
_EXPECTED_ENUM_TYPES = (
    Path(__file__).resolve().parents[4]
    / "fixtures/codegen-conformance/shared-provided-enum/expected-enum-types.json"
)


def _emit(config: GenConfig) -> dict[str, str]:
    root = MetaDataLoader.from_directory(_FIXTURE_DIR).root
    entities = [o for o in root.own_children() if isinstance(o, MetaObject)]
    ctx = GenContext(
        entities=entities,
        loaded_root=root,
        matches=lambda _e: True,
        config=config,
        warn=lambda _m: None,
    )
    return {f.path: f.content for f in EntityModelGenerator().generate(ctx)}


def test_shared_enum_is_materialized_once_and_referenced_by_both_entities() -> None:
    files = _emit(GenConfig(out_dir="", provided_enum_namespace="acme_ext.enums"))
    assert "enums.py" in files, "shared enums.py must be emitted"
    enums = files["enums.py"]
    assert enums.count("class Priority(str, Enum):") == 1, "Priority must be materialized exactly once"
    for member in ("LOW", "MEDIUM", "HIGH"):
        assert f'{member} = "{member}"' in enums

    for name in ("Ticket.py", "Order.py"):
        src = files[name]
        assert "priority: Priority" in src, f"{name} must type priority as the shared enum"
        assert "from .enums import Priority" in src, f"{name} must import the materialized enum"
        # Scoped to the `priority` field itself — the extended fixture also gives
        # Order its own inline enum (`status`), so the file as a whole legitimately
        # contains a Literal for that unrelated field.
        assert "priority: Literal" not in src, f"{name} must not inline priority as a Literal"


def test_provided_enum_is_not_materialized_and_imported_from_the_configured_module() -> None:
    files = _emit(GenConfig(out_dir="", provided_enum_namespace="acme_ext.enums"))
    assert "class Currency" not in files.get("enums.py", ""), "provided Currency must NOT be materialized"
    ticket = files["Ticket.py"]
    assert "from acme_ext.enums import Currency" in ticket, "currency must import from the configured module"
    assert "currency: Currency" in ticket


def test_provided_enum_with_no_module_config_is_a_codegen_error_naming_the_enum() -> None:
    with pytest.raises(ValueError) as excinfo:
        _emit(GenConfig(out_dir=""))  # no provided module configured
    assert "Currency" in str(excinfo.value)


def _emit_doc(doc: dict) -> dict[str, str]:
    root = MetaDataLoader().load(
        [InMemoryStringSource(json.dumps(doc), id="m.json", format=MetaDataFormat.JSON)]
    ).root
    entities = [o for o in root.own_children() if isinstance(o, MetaObject)]
    ctx = GenContext(
        entities=entities, loaded_root=root, matches=lambda _e: True,
        config=GenConfig(out_dir=""), warn=lambda _m: None,
    )
    return {f.path: f.content for f in EntityModelGenerator().generate(ctx)}


def test_shared_enum_members_are_uppercase_with_wire_value_preserved() -> None:
    """Python enum members follow the UPPER_CASE constant convention; the value keeps
    the wire form, so ``Enum("statistical")`` and ``member == "statistical"`` still work."""
    enums = _emit_doc({"metadata.root": {"package": "a::b", "children": [
        {"field.enum": {"name": "NumericalType", "abstract": True,
                        "@values": ["none", "statistical", "search_web"]}},
        {"object.value": {"name": "M", "children": [
            {"field.enum": {"name": "nt", "extends": "a::b::NumericalType"}}]}},
    ]}})["enums.py"]
    assert 'STATISTICAL = "statistical"' in enums
    assert 'SEARCH_WEB = "search_web"' in enums
    assert 'statistical = "statistical"' not in enums  # member is not the lowercase value


def test_multi_hop_enum_extends_still_resolves_to_the_shared_enum() -> None:
    """``Task.urgency`` extends ``Ticket.priority`` which extends the shared abstract ``Priority``:
    the shared declaration is found through the intermediate concrete field."""
    files = _emit(GenConfig(out_dir="", provided_enum_namespace="acme_ext.enums"))
    task = files["Task.py"]
    assert "urgency: Priority" in task
    assert "from .enums import Priority" in task
    # Scoped to `urgency` — the extended fixture also gives Task its own
    # inline/mid-chain-broken enums (`phase`, `weight`), which legitimately
    # inline as Literal elsewhere in the same file.
    assert "urgency: Literal" not in task


def test_decision_table_matches_fixture_exactly() -> None:
    """The decision-table fixture (``expected-enum-types.json``) pins, for EVERY
    object-hosted ``field.enum`` in every object — entities, the ``TicketSummary``
    projection, the ``TicketBadge`` value object — exactly what
    ``resolve_shared_enum_declaration`` (the one function every generator calls)
    answers. Exact equality both ways: no missing key, no extra key."""
    root = MetaDataLoader.from_directory(_FIXTURE_DIR).root
    objects = [o for o in root.own_children() if isinstance(o, MetaObject)]

    actual: dict[str, dict[str, object]] = {}
    for obj in objects:
        for f in obj.fields():
            if f.sub_type != fc.FIELD_SUBTYPE_ENUM:
                continue
            decl = resolve_shared_enum_declaration(f)
            actual[f"{obj.resolution_key()}.{f.name}"] = {
                "shared": decl.resolution_key() if decl is not None else None,
                "provided": is_provided(decl) if decl is not None else False,
            }

    expected = json.loads(_EXPECTED_ENUM_TYPES.read_text())
    assert actual == expected["fields"]

    materialized = sorted(e.name for e in materialized_shared_enums(objects))
    assert materialized == expected["materialized"]


def test_deprecated_resolver_name_still_answers_the_decision_table() -> None:
    """A generator ejected before the resolver moved to the metadata layer calls
    ``fr019_shared_enum.resolve_shared_enum_decl``. That name must still import and
    must answer what the decision-table fixture pins for every field, including the
    multi-hop ones (the removed one-hop predicate answered ``None`` for
    ``Task.importance``), while warning that it is deprecated."""
    root = MetaDataLoader.from_directory(_FIXTURE_DIR).root
    expected = json.loads(_EXPECTED_ENUM_TYPES.read_text())["fields"]

    actual: dict[str, str | None] = {}
    for obj in (o for o in root.own_children() if isinstance(o, MetaObject)):
        for f in obj.fields():
            if f.sub_type != fc.FIELD_SUBTYPE_ENUM:
                continue
            with pytest.warns(DeprecationWarning, match="resolve_shared_enum_declaration"):
                decl = resolve_shared_enum_decl(f)
            actual[f"{obj.resolution_key()}.{f.name}"] = (
                decl.resolution_key() if decl is not None else None
            )

    assert actual == {key: entry["shared"] for key, entry in expected.items()}
    assert actual["acme::shop::Task.importance"] == "acme::shop::Priority"


def test_generated_output_for_multi_hop_provided_and_negative_cases(
    tmp_path: Path,
) -> None:
    """Executes the real generated output (via ``run_gen`` + import, not string
    guessing) for every scenario the decision table above names explicitly."""
    root = MetaDataLoader.from_directory(_FIXTURE_DIR).root
    out_dir = tmp_path / "generated"
    config = GenConfig(out_dir=str(out_dir), provided_enum_namespace="acme_ext.enums")
    run_gen(config, root, generators=[entity_model()])

    # A stub for the @provided module (ADR-0001: it never lives in metadata, and
    # genuinely does not exist here) so Refund.py's cross-module import resolves
    # for real instead of being skipped.
    stub_pkg = tmp_path / "acme_ext"
    stub_pkg.mkdir()
    (stub_pkg / "__init__.py").write_text("")
    (stub_pkg / "enums.py").write_text(
        'from enum import Enum\n\n\nclass Currency(str, Enum):\n'
        '    USD = "USD"\n    EUR = "EUR"\n    GBP = "GBP"\n'
    )

    sys.path.insert(0, str(tmp_path))
    try:
        enums_mod = importlib.import_module("generated.enums")
        assert not hasattr(enums_mod, "Currency"), "a @provided enum must never be materialized"
        assert set(enums_mod.Priority.__members__) == {"LOW", "MEDIUM", "HIGH"}
        assert set(enums_mod.Money.__members__) == {"USD", "EUR", "GBP"}

        # Importing executes the real generated modules — proves the shared-enum
        # cross-module references actually resolve, not merely render as
        # plausible text.
        task = importlib.import_module("generated.Task")
        subtask = importlib.import_module("generated.Subtask")
        ticket_summary = importlib.import_module("generated.TicketSummary")
        ticket_badge = importlib.import_module("generated.TicketBadge")
        refund = importlib.import_module("generated.Refund")
        assert task.Task is not None
        assert subtask.Subtask is not None
        assert ticket_summary.TicketSummary is not None
        assert ticket_badge.TicketBadge is not None
        assert refund.Refund is not None

        task_src = (out_dir / "Task.py").read_text()
        subtask_src = (out_dir / "Subtask.py").read_text()
        ticket_summary_src = (out_dir / "TicketSummary.py").read_text()
        ticket_badge_src = (out_dir / "TicketBadge.py").read_text()
        refund_src = (out_dir / "Refund.py").read_text()
        enums_src = (out_dir / "enums.py").read_text()

        # Multi-hop consumers (Task.importance -> Ticket.severity -> Priority;
        # Subtask.rank three hops; a projection; a value object) reference the
        # shared type, with no per-object Literal.
        assert "importance: Priority" in task_src and "importance: Literal" not in task_src
        assert "rank: Priority" in subtask_src and "rank: Literal" not in subtask_src
        assert "level: Priority" in ticket_summary_src and "level: Literal" not in ticket_summary_src
        assert "badge: Priority" in ticket_badge_src and "badge: Literal" not in ticket_badge_src
        for src in (task_src, subtask_src, ticket_summary_src, ticket_badge_src):
            assert "from .enums import Priority" in src

        # Priority emitted exactly once across the whole model.
        assert enums_src.count("class Priority(str, Enum):") == 1

        # Refund: two fields whose immediate supers are same-named fields of
        # different objects (ticketTier -> Ticket.tier -> Priority; invoiceTier ->
        # Invoice.tier -> Money), plus the materialized Money the unit field
        # resolves to, plus the @provided Currency that is never materialized.
        assert "ticketTier: Priority" in refund_src and "ticketTier: Literal" not in refund_src
        assert "invoiceTier: Money" in refund_src and "invoiceTier: Literal" not in refund_src
        assert "unit: Money" in refund_src and "unit: Literal" not in refund_src
        assert "from .enums import Money" in refund_src
        assert "tender: Currency" in refund_src
        assert "from acme_ext.enums import Currency" in refund_src
        assert "class Currency" not in enums_src

        # Negatives: an own @values/@intValueMap breaks the chain, so these keep
        # an inline per-object Literal enum instead of referencing Priority.
        for src, field_name in (
            (task_src, "phase"),
            (task_src, "weight"),
            (subtask_src, "phase"),
            (subtask_src, "weight"),
            (refund_src, "orderStatus"),
        ):
            assert f"{field_name}: Literal[" in src, f"{field_name} must keep its inline enum"
    finally:
        sys.path.remove(str(tmp_path))
        for name in [
            m for m in sys.modules if m.split(".")[0] in ("generated", "acme_ext")
        ]:
            del sys.modules[name]


def test_narrowed_run_on_only_the_projection_still_materializes_the_shared_enum(
    tmp_path: Path,
) -> None:
    """A run narrowed to ONLY ``TicketSummary`` (a projection, via
    ``entity_filter``) must still emit ``Priority`` — must-generate turns on
    whether any SURVIVING consumer references the shared type, never on the
    hosting object's subtype."""
    root = MetaDataLoader.from_directory(_FIXTURE_DIR).root
    out_dir = tmp_path / "generated_narrow"
    config = GenConfig(out_dir=str(out_dir), provided_enum_namespace="acme_ext.enums")
    run_gen(config, root, generators=[entity_model()], entity_filter=["TicketSummary"])

    assert (out_dir / "enums.py").exists(), "narrowing to TicketSummary must still emit enums.py"
    enums_src = (out_dir / "enums.py").read_text()
    assert enums_src.count("class Priority(str, Enum):") == 1
    assert "class Money" not in enums_src, "Money has no consumer in the narrowed run"

    ticket_summary_src = (out_dir / "TicketSummary.py").read_text()
    assert "level: Priority" in ticket_summary_src
    assert "from .enums import Priority" in ticket_summary_src


def test_shared_enum_values_colliding_after_upper_are_a_codegen_error() -> None:
    with pytest.raises(ValueError, match="both map to the Python member OPEN"):
        _emit_doc({"metadata.root": {"package": "a::b", "children": [
            {"field.enum": {"name": "State", "abstract": True, "@values": ["Open", "open"]}},
            {"object.value": {"name": "M", "children": [
                {"field.enum": {"name": "st", "extends": "a::b::State"}}]}},
        ]}})
