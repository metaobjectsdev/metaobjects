"""``packages``, ``entities`` and ``options`` on a ``generators`` entry (L-PY-0).

An entry written as a mapping may limit one generator to some packages and objects and hand it
its own settings, packaged generator or a team's own. A name the model does not hold and an
option the generator does not take are refused, never ignored: a typo here would otherwise drop
a generator's output and the run would still say it succeeded.
"""
from __future__ import annotations

import json
import textwrap
from pathlib import Path

import pytest

from metaobjects.cli import main
from metaobjects.codegen.generator_registry import GeneratorOption, resolve_options, snake_case_option
from metaobjects.codegen.project_config import ConfigError, GeneratorSettings, load_project_config


def _value(name: str) -> dict:
    return {
        "object.entity": {
            "name": name,
            "children": [
                {"source.rdb": {"@table": name.lower() + "s"}},
                {"field.long": {"name": "id"}},
                {"identity.primary": {"name": "pk", "@fields": ["id"]}},
            ],
        }
    }


def _model(root: Path) -> None:
    meta = root / "metaobjects"
    meta.mkdir(parents=True, exist_ok=True)
    for pkg, names in (("acme::sales", ["Order", "Invoice"]), ("acme::hr", ["Person"])):
        (meta / f"meta.{pkg.split('::')[1]}.json").write_text(
            json.dumps({"metadata.root": {"package": pkg, "children": [_value(n) for n in names]}}),
            encoding="utf-8",
        )


def _project(root: Path, generators: str, extra: str = "") -> Path:
    _model(root)
    (root / "metaobjects.config.yaml").write_text(
        f"targets:\n  app:\n    outDir: gen\n    generators:\n{textwrap.indent(generators, '      ')}\n{extra}",
        encoding="utf-8",
    )
    return root / "gen"


def _stems(out: Path) -> set[str]:
    return {p.stem for p in out.rglob("*.py") if p.stem != "__init__"}


def test_the_config_reads_the_three_keys(tmp_path: Path) -> None:
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(
        "targets:\n  app:\n    outDir: gen\n    generators:\n      - entity\n"
        "      - name: names\n        packages: [acme::sales]\n        entities: [Order]\n"
        "        options: {a: 1}\n",
        encoding="utf-8",
    )
    [target] = load_project_config(cfg).targets
    assert target.generators == ["entity", "names"]
    assert target.generator_settings == {
        "names": GeneratorSettings(packages=("acme::sales",), entities=("Order",), options={"a": 1})
    }


@pytest.mark.parametrize(
    "generators",
    [
        "- {name: names, packages: [acme::sales]}\n- {name: names, packages: [acme::hr]}",
        "- names\n- {name: names, entities: [Order]}",
        "- {name: names, options: {a: 1}}\n- names",
        "- {name: names, handEdits: overwrite}\n- {name: names}",
    ],
)
def test_a_generator_listed_twice_with_settings_is_refused(tmp_path: Path, generators: str) -> None:
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(
        f"targets:\n  app:\n    outDir: gen\n    generators:\n{textwrap.indent(generators, '      ')}\n",
        encoding="utf-8",
    )
    with pytest.raises(ConfigError, match="'names' is listed twice"):
        load_project_config(cfg)


def test_a_generator_listed_twice_with_no_settings_is_allowed(tmp_path: Path) -> None:
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(
        "targets:\n  app:\n    outDir: gen\n    generators:\n      - names\n      - names\n",
        encoding="utf-8",
    )
    [target] = load_project_config(cfg).targets
    assert target.generators == ["names", "names"]


@pytest.mark.parametrize(
    ("entry", "fragment"),
    [
        ("packages: []", "'packages' must be a non-empty list"),
        ("packages: acme", "'packages' must be a non-empty list"),
        ("entities: [1]", "'entities' must be a non-empty list"),
        ("options: [a]", "'options' must be a mapping"),
        ("selection: [A]", "unknown key(s) ['selection']"),
    ],
)
def test_a_malformed_entry_is_refused(tmp_path: Path, entry: str, fragment: str) -> None:
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(
        f"targets:\n  app:\n    outDir: gen\n    generators:\n      - name: names\n        {entry}\n",
        encoding="utf-8",
    )
    with pytest.raises(ConfigError, match=fragment.replace("[", r"\[").replace("]", r"\]").replace("(", r"\(").replace(")", r"\)")):
        load_project_config(cfg)


def test_a_generator_is_limited_to_its_packages_and_entities(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out = _project(
        tmp_path,
        "- entity\n- name: names\n  packages: [acme::sales]\n",
    )
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    stems = _stems(out)
    assert {"order", "invoice", "person"} <= {s.lower() for s in stems}
    names = {s for s in stems if s.endswith("_names")}
    assert names == {"order_names", "invoice_names"}


def test_entities_select_by_short_name(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    out = _project(tmp_path, "- name: names\n  entities: [Person]\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert {s for s in _stems(out) if s.endswith("_names")} == {"person_names"}


@pytest.mark.parametrize(
    ("entry", "fragment"),
    [
        ("entities: [Nobody]", "entities ['Nobody'] name no object in this target"),
        ("packages: [acme::nope]", "packages ['acme::nope'] hold no object in this target"),
    ],
)
def test_a_name_the_model_does_not_hold_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
    entry: str, fragment: str,
) -> None:
    out = _project(tmp_path, f"- name: names\n  {entry}\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) != 0
    assert fragment in capsys.readouterr().err
    assert not out.exists() or not _stems(out)


def test_a_generator_may_not_cover_what_its_required_generator_is_limited_away_from(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # `routes` imports the filter allowlist of each entity it routes. Limiting the allowlist to
    # Invoice while routes covers Order and Person would emit routers that fail to import.
    out = _project(
        tmp_path, "- entity\n- {name: filter-allowlist, entities: [Invoice]}\n- routes\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) != 0
    err = capsys.readouterr().err
    assert "'routes' requires 'filter-allowlist', which is limited away from" in err
    assert "'Order'" in err and "'Person'" in err and "'Invoice'" not in err
    assert not out.exists() or not _stems(out)


def test_an_unlimited_generator_does_not_count_objects_it_writes_nothing_for(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # `routes` writes no router for an abstract object or a sourceless one, so limiting the
    # allowlist to the packages that hold the routed entities leaves nothing dangling.
    out = _project(
        tmp_path,
        "- entity\n- {name: filter-allowlist, packages: ['acme::sales', 'acme::hr']}\n- routes\n",
    )
    (tmp_path / "metaobjects" / "meta.common.json").write_text(
        json.dumps({"metadata.root": {"package": "acme::common", "children": [
            {"object.entity": {"name": "Base", "abstract": True, "children": [
                {"field.long": {"name": "id"}},
            ]}},
            {"object.entity": {"name": "Remote", "children": [
                {"field.long": {"name": "id"}},
                {"identity.primary": {"name": "pk", "@fields": ["id"]}},
            ]}},
        ]}}),
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    stems = _stems(out)
    assert {"order_router", "invoice_router", "person_router"} <= stems
    assert "remote_router" not in stems and "base_router" not in stems


def _sales_with_common_base(root: Path, *, order_extends_base: bool) -> None:
    meta = root / "metaobjects"
    (meta / "meta.hr.json").unlink()
    order = _value("Order")["object.entity"]
    if order_extends_base:
        order["extends"] = "acme::common::Base"
    (meta / "meta.sales.json").write_text(
        json.dumps({"metadata.root": {"package": "acme::sales", "children": [
            {"object.entity": order}, _value("Invoice"),
        ]}}),
        encoding="utf-8",
    )
    (meta / "meta.common.json").write_text(
        json.dumps({"metadata.root": {"package": "acme::common", "children": [
            {"object.entity": {"name": "Base", "abstract": True, "children": [
                {"field.string": {"name": "label"}},
            ]}},
        ]}}),
        encoding="utf-8",
    )


def test_an_abstract_base_no_routed_object_extends_is_not_needed_from_entity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out = _project(tmp_path, "- {name: entity, packages: ['acme::sales']}\n- routes\n")
    _sales_with_common_base(tmp_path, order_extends_base=False)
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert {"order_router", "invoice_router"} <= _stems(out)


def test_the_abstract_base_a_routed_object_extends_is_needed_from_entity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    out = _project(tmp_path, "- {name: entity, packages: ['acme::sales']}\n- routes\n")
    _sales_with_common_base(tmp_path, order_extends_base=True)
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) != 0
    err = capsys.readouterr().err
    assert "'routes' requires 'entity', which is limited away from ['Base']" in err
    assert not out.exists() or not _stems(out)


def test_the_many_to_many_target_a_routed_object_imports_is_needed_from_entity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    out = _project(tmp_path, "- {name: entity, packages: ['acme::sales']}\n- routes\n")
    meta = tmp_path / "metaobjects"
    (meta / "meta.hr.json").unlink()
    order = _value("Order")["object.entity"]
    order["children"].append({"relationship.association": {
        "name": "tags", "@cardinality": "many",
        "@objectRef": "acme::common::Tag", "@through": "OrderTag",
    }})
    order_tag = {"object.entity": {"name": "OrderTag", "children": [
        {"source.rdb": {"@table": "order_tags"}},
        {"field.long": {"name": "orderId", "@required": True}},
        {"field.long": {"name": "tagId", "@required": True}},
        {"identity.primary": {"name": "pk", "@fields": ["orderId", "tagId"]}},
        {"identity.reference": {"name": "fkOrder", "@fields": "orderId", "@references": "Order"}},
        {"identity.reference": {
            "name": "fkTag", "@fields": "tagId", "@references": "acme::common::Tag",
        }},
    ]}}
    (meta / "meta.sales.json").write_text(
        json.dumps({"metadata.root": {"package": "acme::sales", "children": [
            {"object.entity": order}, order_tag,
        ]}}),
        encoding="utf-8",
    )
    (meta / "meta.common.json").write_text(
        json.dumps({"metadata.root": {"package": "acme::common", "children": [_value("Tag")]}}),
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) != 0
    err = capsys.readouterr().err
    assert "'routes' requires 'entity', which is limited away from ['Tag']" in err
    assert not out.exists() or not _stems(out)


def test_limiting_a_generator_and_the_one_it_requires_to_the_same_entity_is_accepted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out = _project(
        tmp_path,
        "- entity\n- {name: filter-allowlist, entities: [Invoice]}\n"
        "- {name: routes, entities: [Invoice]}\n",
    )
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert "invoice_router" in _stems(out) and "order_router" not in _stems(out)


def test_the_selection_stays_inside_the_targets_entities(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _project(tmp_path, "- name: names\n  entities: [Person]\n", "")
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(cfg.read_text(encoding="utf-8").replace("    outDir: gen\n", "    outDir: gen\n    entities: [Order]\n"), encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) != 0
    assert "name no object in this target" in capsys.readouterr().err


def test_a_packaged_generators_options_reach_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _model(tmp_path)
    out = _project(
        tmp_path,
        "- entity\n- routes\n- name: report-export\n  options: {maxRows: 7, xmlNulls: nil, csvBom: true}\n",
    )
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    # No report is served here, so the shared writer is not written; the options still had to
    # build the generator, which is what a bad value would have failed.
    assert out.exists()


def test_a_packaged_option_changes_what_the_generator_is_built_with() -> None:
    import dataclasses

    from metaobjects.codegen.generator_registry import GENERATOR_REGISTRY, GeneratorBuildContext

    ctx = dataclasses.replace(
        GeneratorBuildContext(), options={"max_rows": 7, "xml_nulls": "nil", "csv_bom": True}
    )
    built = GENERATOR_REGISTRY["report-export"].factory(ctx)
    assert (built.max_rows, built.xml_nulls, built.csv_bom) == (7, "nil", True)  # type: ignore[attr-defined]
    routes = GENERATOR_REGISTRY["routes"].factory(dataclasses.replace(ctx, options={"report_max_rows": 5}))
    assert routes.report_max_rows == 5  # type: ignore[attr-defined]


def test_a_bad_option_is_refused_and_names_what_is_accepted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _project(tmp_path, "- name: report-export\n  options: {maxRow: 7}\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) != 0
    err = capsys.readouterr().err
    assert "generator 'report-export' takes no option 'maxRow'; options: csvBom, maxRows, xmlNulls" in err


def test_a_generator_with_no_options_refuses_any(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _project(tmp_path, "- name: names\n  options: {x: 1}\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) != 0
    assert "generator 'names' takes no option 'x'; options: none" in capsys.readouterr().err


def test_option_values_are_checked() -> None:
    accepted = (
        GeneratorOption("maxRows", "integer", "", minimum=1),
        GeneratorOption("xmlNulls", "string", "", choices=("empty", "nil")),
        GeneratorOption("csvBom", "boolean", ""),
    )
    kwargs, errors = resolve_options("g", accepted, {"maxRows": 5, "xmlNulls": "nil", "csvBom": True})
    assert (kwargs, errors) == ({"max_rows": 5, "xml_nulls": "nil", "csv_bom": True}, [])
    _, errors = resolve_options("g", accepted, {"maxRows": 0, "xmlNulls": "x", "csvBom": "yes"})
    assert errors == [
        "generator 'g' option 'maxRows' must be at least 1, got 0",
        "generator 'g' option 'xmlNulls' must be one of empty, nil, got 'x'",
        "generator 'g' option 'csvBom' must be true or false, got 'yes'",
    ]
    _, errors = resolve_options("g", accepted, {"maxRows": True})
    assert errors == ["generator 'g' option 'maxRows' must be a whole number, got True"]


def test_snake_case_option() -> None:
    assert snake_case_option("maxRows") == "max_rows"
    assert snake_case_option("reportMaxRows") == "report_max_rows"
    assert snake_case_option("csv") == "csv"


# --- a team's own generator ------------------------------------------------------------------

_OWNED = """\
from metaobjects.codegen.generator import EmittedFile


class Stamp:
    name = "stamp"

    def __init__(self, label: str = "none", copies: int = 1) -> None:
        self.label = label
        self.copies = copies

    def generate(self, ctx):
        return [EmittedFile(path="stamp.txt", content=f"{self.label} x{self.copies}\\n")]


def stamp(label: str = "none", copies: int = 1):
    return Stamp(label, copies)


def open_stamp(**options):
    return Stamp(**options)


def stamp_from_ctx(ctx):
    return Stamp(label=str(dict(ctx.options)))


INSTANCE = Stamp()
"""


def _owned_project(root: Path, entry: str) -> Path:
    (root / "stamps.py").write_text(_OWNED, encoding="utf-8")
    return _project(root, entry)


def _stamp(out: Path) -> str:
    return (out / "stamp.txt").read_text(encoding="utf-8")


def test_options_reach_a_team_factory_as_snake_case_keywords(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out = _owned_project(tmp_path, "- name: 'stamps:stamp'\n  options: {label: hi, copies: 3}\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert _stamp(out) == "hi x3\n"


def test_options_reach_a_team_class_and_a_kwargs_factory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out = _owned_project(tmp_path, "- name: 'stamps:Stamp'\n  options: {label: cls}\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert _stamp(out) == "cls x1\n"
    out = _owned_project(tmp_path / "second", "- name: 'stamps:open_stamp'\n  options: {copies: 2}\n") \
        if (tmp_path / "second").mkdir() is None else out
    monkeypatch.chdir(tmp_path / "second")
    assert main(["gen"]) == 0
    assert _stamp(out) == "none x2\n"


def test_a_factory_that_takes_the_context_reads_the_options_there(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out = _owned_project(tmp_path, "- name: 'stamps:stamp_from_ctx'\n  options: {anyKey: 1}\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert _stamp(out) == "{'anyKey': 1} x1\n"


def test_an_option_a_team_factory_does_not_take_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _owned_project(tmp_path, "- name: 'stamps:stamp'\n  options: {lable: hi}\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) != 0
    err = capsys.readouterr().err
    assert "stamp() takes no option(s) 'lable'; it takes: copies, label" in err


def test_options_on_a_generator_instance_are_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _owned_project(tmp_path, "- name: 'stamps:INSTANCE'\n  options: {label: hi}\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) != 0
    assert "is a generator instance, which takes no options" in capsys.readouterr().err


def test_a_team_generator_can_be_limited_like_a_packaged_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out = _owned_project(tmp_path, "- name: 'stamps:stamp'\n  packages: [acme::hr]\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert _stamp(out) == "none x1\n"
