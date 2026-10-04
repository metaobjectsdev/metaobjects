"""ObjectManager reads a view-backed ``object.report`` (FR-044 Plan 2, Task 14).

A report declares no fields: its read shape is derived (Table B). The runtime reads
it through a detached READ MODEL (``report_read_model``) swapped in at
``_require_entity``, so the column list, filter/sort resolution, read coercion and
table resolution all see an ordinary view-backed object. These tests use a recording
driver (no database): they pin the SQL, the refusals, and that the loaded tree is
never touched. The rows themselves are proven by the six shared ``report-*`` persistence
scenarios against Postgres (``tests/integration/test_query_scenarios.py``).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from metaobjects import load_directory
from metaobjects.loader.meta_data_loader import MetaDataLoader
from metaobjects.loader.sources import InMemoryStringSource
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_REPORT
from metaobjects.meta.core.reporting.report_read_model import report_read_model
from metaobjects.runtime.object_manager import ObjectManager, SelectResult
from metaobjects.serializer_json import canonical_serialize
from metaobjects.shared.base_types import TYPE_OBJECT

CORPUS = Path(__file__).parents[4] / "fixtures" / "persistence-conformance"


class RecordingDriver:
    """Records every statement; answers with no rows (and a zero scalar)."""

    def __init__(self) -> None:
        self.sql: list[str] = []
        self.params: list[tuple[Any, ...]] = []

    def select(self, sql: str, params: tuple[Any, ...] = ()) -> SelectResult:
        self.sql.append(sql)
        self.params.append(params)
        return SelectResult([], {})

    def scalar(self, sql: str, params: tuple[Any, ...] = ()) -> Any:
        self.sql.append(sql)
        self.params.append(params)
        return 0

    def insert_returning(self, *a: Any, **k: Any) -> SelectResult:  # pragma: no cover - must not be reached
        raise AssertionError("a report write reached the driver")

    update_returning = insert_returning

    def execute_rowcount(self, *a: Any, **k: Any) -> int:  # pragma: no cover - must not be reached
        raise AssertionError("a report write reached the driver")


def _canonical_root():
    result = load_directory(CORPUS / "canonical")
    assert not result.errors, "\n".join(e.message for e in result.errors)
    return result.root


def _om(root: Any, driver: RecordingDriver, **kw: Any) -> ObjectManager:
    return ObjectManager(root, driver, **kw)  # type: ignore[arg-type]


def _load(text: str):
    result = MetaDataLoader().load([InMemoryStringSource(text, "t.json")])
    assert result.errors == [], [e.message for e in result.errors]
    return result.root


# A report beside an entity; `source` is spliced into the report's children.
def _model(report_sources: str, *, extra_report: str = "") -> str:
    return """{ "metadata.root": { "package": "acme", "children": [
  { "object.entity": { "name": "Sale", "children": [
    { "source.rdb": { "name": "primary", "@table": "sales" } },
    { "field.long": { "name": "id" } },
    { "field.string": { "name": "region", "@required": true } },
    { "field.int": { "name": "units" } },
    { "identity.primary": { "name": "pk", "@fields": ["id"] } },
    { "dimension.attribute": { "name": "region", "@of": "Sale.region" } },
    { "measure.aggregate": { "name": "total", "@agg": "sum", "@of": "Sale.units" } }
  ]} },
  { "object.report": { "name": "SalesByRegion", "@from": "Sale",
      "@dimensions": ["region"], "@measures": ["total"], "children": [
    %s
  ]%s } }
]} }""" % (report_sources, extra_report)


# --- the canonical reports through the runtime ------------------------------------------------


def test_find_many_selects_the_derived_columns_from_the_view() -> None:
    root = _canonical_root()
    drv = RecordingDriver()
    _om(root, drv).find_many("ProgramMinutes")
    assert drv.sql[0] == (
        'SELECT "program", "programTitle", "weeks", "longWeeks", "labels", "slots", '
        '"totalMinutes", "avgMinutes", "minMinutes", "maxMinutes", "longShare" '
        'FROM "v_program_minutes"'
    )


def test_filter_sort_limit_on_derived_fields() -> None:
    root = _canonical_root()
    drv = RecordingDriver()
    _om(root, drv).find_many(
        "ProgramMinutes", {"weeks": {"gte": 2}}, sort=[("totalMinutes", "desc")], limit=1
    )
    sql = drv.sql[0]
    assert sql.endswith('FROM "v_program_minutes" WHERE "weeks" >= %s ORDER BY "totalMinutes" DESC LIMIT 1')
    assert drv.params[0] == (2,)


def test_count_reads_the_view() -> None:
    root = _canonical_root()
    drv = RecordingDriver()
    assert _om(root, drv).count("ProgramMinutes", {"weeks": {"gte": 1}}) == 0
    assert drv.sql[0] == 'SELECT COUNT(*) FROM "v_program_minutes" WHERE "weeks" >= %s'


def test_the_naming_strategy_applies_to_the_derived_name() -> None:
    """The derived field carries no @column, so snake_case turns ``programTitle`` into
    ``program_title`` (a column the lowering emits under the same strategy)."""
    root = _canonical_root()
    drv = RecordingDriver()
    _om(root, drv, column_naming="snake_case").find_many("ProgramMinutes", {"programTitle": "x"})
    assert '"program_title"' in drv.sql[0]
    assert '"programTitle"' not in drv.sql[0]


def test_an_unknown_field_in_a_report_filter_is_not_silently_mapped() -> None:
    """Same as any object: an unknown field name is used verbatim as the column, so the
    database (not the runtime) refuses it. Pins that a report adds no special case."""
    root = _canonical_root()
    drv = RecordingDriver()
    _om(root, drv).find_many("ProgramMinutes", {"nope": 1})
    assert '"nope" = %s' in drv.sql[0]


@pytest.mark.parametrize("op", ["find_by_id", "create", "insert_preserving", "update", "delete"])
def test_by_id_and_every_write_are_refused_read_only_no_identity(op: str) -> None:
    root = _canonical_root()
    drv = RecordingDriver()
    om = _om(root, drv)
    args: dict[str, tuple[Any, ...]] = {
        "find_by_id": ("ProgramMinutes", 1),
        "create": ("ProgramMinutes", {"weeks": 1}),
        "insert_preserving": ("ProgramMinutes", {"weeks": 1}),
        "update": ("ProgramMinutes", 1, {"weeks": 1}),
        "delete": ("ProgramMinutes", 1),
    }
    with pytest.raises(ValueError, match="read-only and has no identity"):
        getattr(om, op)(*args[op])
    assert drv.sql == []


def test_relate_and_primary_key_field_are_refused() -> None:
    om = _om(_canonical_root(), RecordingDriver())
    with pytest.raises(ValueError, match="read-only and has no identity"):
        om.relate("ProgramMinutes", {"id": 1}, "weeks")
    with pytest.raises(ValueError, match="read-only and has no identity"):
        om.primary_key_field("ProgramMinutes")


def test_a_non_report_object_is_unchanged() -> None:
    root = _canonical_root()
    drv = RecordingDriver()
    om = _om(root, drv)
    declared = next(c for c in root.children() if c.type == TYPE_OBJECT and c.name == "Program")
    assert om._require_entity("Program") is declared
    om.find_many("Program", {"id": 1}, limit=1)
    assert drv.sql[0].startswith('SELECT ') and 'FROM "programs"' in drv.sql[0]
    assert om.primary_key_field("Program") == "id"


def test_reading_reports_leaves_the_loaded_tree_untouched() -> None:
    root = _canonical_root()
    before = canonical_serialize(root)
    n_objects = len([c for c in root.children() if c.type == TYPE_OBJECT])
    om = _om(root, RecordingDriver())
    for name in ("ProgramMinutes", "FitnessTotals", "ProgramsByMonth"):
        om.find_many(name)
        om.count(name)
    assert len([c for c in root.children() if c.type == TYPE_OBJECT]) == n_objects
    assert canonical_serialize(root) == before
    # The report's source node still belongs to the report (never re-parented).
    report = next(c for c in root.children() if c.name == "ProgramMinutes")
    assert all(c.parent is report for c in report.own_children())


def test_the_runtime_reads_through_the_cached_read_model() -> None:
    root = _canonical_root()
    om = _om(root, RecordingDriver())
    assert om._require_entity("ProgramMinutes") is om._require_entity("ProgramMinutes")
    report = next(c for c in root.children() if c.name == "ProgramMinutes")
    assert report_read_model(report, root) is om._require_entity("ProgramMinutes")
    # Detached: the model is not the declared node and has no parent.
    assert om._require_entity("ProgramMinutes") is not report
    assert om._require_entity("ProgramMinutes").parent is None
    assert om._require_entity("ProgramMinutes").sub_type == OBJECT_SUBTYPE_REPORT


# --- shapes the loader permits, built inline --------------------------------------------------


def test_a_sourceless_report_is_not_served() -> None:
    root = _load(_model(""))
    drv = RecordingDriver()
    om = _om(root, drv)
    for read in (lambda: om.find_many("SalesByRegion"), lambda: om.count("SalesByRegion")):
        with pytest.raises(ValueError, match="is not served"):
            read()
    assert drv.sql == []


def test_a_write_on_a_sourceless_report_is_refused_as_read_only_not_unserved() -> None:
    om = _om(_load(_model("")), RecordingDriver())
    with pytest.raises(ValueError, match="read-only and has no identity"):
        om.create("SalesByRegion", {"total": 1})
    with pytest.raises(ValueError, match="read-only and has no identity"):
        om.find_by_id("SalesByRegion", 1)


def test_an_unmanaged_view_backed_report_is_still_read() -> None:
    root = _load(_model('{ "source.rdb": { "@kind": "view", "@view": "v_sales_by_region", "@unmanaged": true } }'))
    drv = RecordingDriver()
    om = _om(root, drv)
    om.find_many("SalesByRegion")
    om.count("SalesByRegion")
    assert drv.sql[0] == 'SELECT "region", "total" FROM "v_sales_by_region"'
    assert drv.sql[1] == 'SELECT COUNT(*) FROM "v_sales_by_region"'


def test_a_replica_declared_before_the_primary_view_reads_the_primary() -> None:
    """The read model names the view by the same rule the lowering uses: the own read-only
    source with @role primary, else the first. Decoy names would show up in the SQL."""
    root = _load(_model(
        '{ "source.rdb": { "name": "r", "@kind": "view", "@view": "v_replica", "@role": "replica" } },'
        '{ "source.rdb": { "name": "p", "@kind": "view", "@view": "v_primary", "@role": "primary" } }'
    ))
    drv = RecordingDriver()
    _om(root, drv).find_many("SalesByRegion")
    assert 'FROM "v_primary"' in drv.sql[0]
    assert "v_replica" not in drv.sql[0]


def test_a_view_with_no_explicit_role_is_read() -> None:
    root = _load(_model('{ "source.rdb": { "@kind": "view", "@view": "v_plain" } }'))
    drv = RecordingDriver()
    _om(root, drv).find_many("SalesByRegion")
    assert 'FROM "v_plain"' in drv.sql[0]


def test_required_and_carried_attrs_come_from_the_derived_shape() -> None:
    root = _load(_model('{ "source.rdb": { "@kind": "view", "@view": "v" } }'))
    report = next(c for c in root.children() if c.name == "SalesByRegion")
    model = report_read_model(report, root)
    assert isinstance(model, MetaObject)
    by_name = {f.name: f for f in model.fields()}
    assert list(by_name) == ["region", "total"]
    assert by_name["region"].sub_type == "string"
    assert by_name["region"].get_meta_attr("required") is True  # dimension: the @of field's @required
    assert by_name["total"].sub_type == "long"
    assert by_name["total"].get_meta_attr("required") is False  # a sum is nullable
    assert all(f.get_meta_attr("column") is None for f in model.fields())  # @column is never carried
