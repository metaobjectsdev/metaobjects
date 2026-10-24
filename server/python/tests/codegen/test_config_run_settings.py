"""ADR-0058 — column and table naming is ONE project setting, ``naming`` in
``.metaobjects/config.json``, read by every port from the loaded root. Templates is
unrelated and stays declared once in ``metaobjects.config.yaml``.

Through 1.1.0's release candidates the column naming was a flag, then briefly a
``columnNaming`` key in ``metaobjects.config.yaml`` — that key never shipped and is
refused outright (ADR-0058 Decision 4), same as the ``--column-naming`` flag and
``ObjectManager(column_naming=...)``. The migration guide replaced a script's
``metaobjects gen <dir> --out ... --generators ...`` with a plain ``metaobjects gen``
once the config declared the generator list, and that plain run used this port's old
default, ``literal``: it rewrote every ``*_names.py`` with camelCase column names the
database does not have. ``verify --codegen`` then advised regenerating, which commits
the wrong names. Now ``naming`` in ``.metaobjects/config.json`` declares the rule once,
``gen`` and ``verify`` both read it from the loaded root, the old flag/key are refused,
and a verify whose naming differs from the one the committed output was generated with
says so instead of "regenerate".

``verify --templates`` reads the same ``metaobjects.config.yaml``, so a project does not
spell its metadata and template directories a second time for that gate.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.cli import main
from metaobjects.codegen.project_config import ConfigError, load_project_config

REPO = Path(__file__).parents[4]
FITNESS = REPO / "fixtures" / "persistence-conformance" / "canonical" / "meta.fitness.json"

# `createdAt` has a case boundary, so its column is `createdAt` under `literal` and
# `created_at` under `snake_case`. `OrderItem` names no table, so its table comes from the
# table rule: `order_items` under `snake_case`, `OrderItems` under `literal`.
MODEL = {
    "metadata.root": {
        "package": "acme",
        "children": [
            {"object.entity": {"name": "Subscriber", "children": [
                {"source.rdb": {"@table": "subscribers"}},
                {"field.long": {"name": "id"}},
                {"field.string": {"name": "createdAt"}},
                {"identity.primary": {"@fields": "id"}},
            ]}},
            {"object.entity": {"name": "OrderItem", "children": [
                {"source.rdb": {}},
                {"field.long": {"name": "id"}},
                {"field.long": {"name": "unitPrice"}},
                {"identity.primary": {"@fields": "id"}},
            ]}},
        ],
    }
}

SNAKE = 'SUBSCRIBER_CREATED_AT_COLUMN: Final[str] = "created_at"'
LITERAL = 'SUBSCRIBER_CREATED_AT_COLUMN: Final[str] = "createdAt"'


def _write_naming(root: Path, naming: dict[str, str]) -> None:
    """ADR-0058 — the ONE project setting, in the port-neutral config file."""
    dot = root / ".metaobjects"
    dot.mkdir(parents=True, exist_ok=True)
    (dot / "config.json").write_text(
        json.dumps({"schema_version": 1, "naming": naming}), encoding="utf-8"
    )


def _project(root: Path, naming: dict[str, str] | None = None) -> Path:
    meta = root / "metaobjects"
    meta.mkdir(parents=True, exist_ok=True)
    (meta / "meta.acme.json").write_text(json.dumps(MODEL), encoding="utf-8")
    (root / "metaobjects.config.yaml").write_text(
        "targets:\n  app:\n    outDir: gen\n    generators: [names]\n", encoding="utf-8"
    )
    if naming is not None:
        _write_naming(root, naming)
    return root / "gen"


def _names(out: Path) -> str:
    [path] = list(out.rglob("subscriber_names.py"))
    return path.read_text(encoding="utf-8")


def test_naming_columns_in_dot_metaobjects_config_makes_a_plain_gen_write_snake_case_and_verify_agrees(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    out = _project(tmp_path, {"columns": "snake_case"})
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    names = _names(out)
    assert SNAKE in names
    assert LITERAL not in names
    capsys.readouterr()
    assert main(["verify", "--codegen"]) == 0
    assert "in sync" in capsys.readouterr().out


def test_naming_columns_literal_makes_a_plain_gen_write_literal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    out = _project(tmp_path, {"columns": "literal"})
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    names = _names(out)
    assert LITERAL in names
    assert SNAKE not in names


def test_no_naming_block_defaults_to_snake_case(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # ADR-0058 — the default FLIPPED in 1.1.0 (this port used to default to `literal`).
    out = _project(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    names = _names(out)
    assert SNAKE in names
    assert LITERAL not in names


def test_the_column_naming_flag_is_refused_on_gen_and_verify(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    out = _project(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["gen", "--column-naming", "literal"]) == 2
    err = capsys.readouterr().err
    assert "--column-naming was removed in 1.1.0" in err
    assert '"naming": { "columns": "literal" }' in err
    assert "docs/features/migrations/physical-naming.md" in err
    assert not out.exists()
    assert main(["gen"]) == 0
    capsys.readouterr()
    assert main(["verify", "--codegen", "--column-naming", "snake_case"]) == 2
    assert "--column-naming was removed in 1.1.0" in capsys.readouterr().err
    # A verify that runs no codegen gate refuses it too, rather than ignoring it.
    assert main(["verify", "--templates", "--column-naming", "snake_case"]) == 2
    assert "--column-naming was removed in 1.1.0" in capsys.readouterr().err


def test_the_column_naming_flag_is_refused_before_the_config_is_looked_for(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["gen", "--column-naming", "literal"]) == 2
    assert "--column-naming was removed in 1.1.0" in capsys.readouterr().err


def test_the_column_naming_key_in_the_yaml_config_is_refused(tmp_path: Path) -> None:
    _project(tmp_path)
    (tmp_path / "metaobjects.config.yaml").write_text(
        "columnNaming: snake_case\ntargets:\n  app:\n    outDir: gen\n    generators: [names]\n",
        encoding="utf-8",
    )
    with pytest.raises(
        ConfigError,
        match=r"columnNaming in metaobjects\.config\.yaml was removed in 1\.1\.0",
    ):
        load_project_config(tmp_path / "metaobjects.config.yaml")


def test_verify_with_another_naming_says_the_naming_differs_not_regenerate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    # Committed with the project's naming set to snake_case...
    out = _project(tmp_path, {"columns": "snake_case"})
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert SNAKE in _names(out)
    # ...then the project's naming changes to literal (nothing about the metadata itself
    # changed), so a plain verify's regen disagrees with the committed names.
    _write_naming(tmp_path, {"columns": "literal"})
    capsys.readouterr()
    assert main(["verify", "--codegen"]) == 1
    err = capsys.readouterr().err
    assert (
        'The committed output was generated with "naming": { "columns": "snake_case", '
        '"tables": "snake_case" }; this run used "naming": { "columns": "literal", '
        '"tables": "snake_case" } (.metaobjects/config.json; each rule defaults to snake_case). '
        "Do not regenerate" in err
    )
    assert (
        'Declare "naming": { "columns": "snake_case", "tables": "snake_case" } in '
        ".metaobjects/config.json" in err
    )
    assert "regenerate (metaobjects gen)" not in err


def _order_item_names(out: Path) -> str:
    [path] = list(out.rglob("order_item_names.py"))
    return path.read_text(encoding="utf-8")


def test_verify_with_another_table_rule_says_the_naming_differs_not_regenerate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    # Committed under literal tables ("OrderItems"); then the config drops the table rule, so
    # the default snake_case ("order_items") disagrees. Regenerating would bind the entity to a
    # table the database does not have, so verify names the table rule that reproduces it.
    out = _project(tmp_path, {"tables": "literal"})
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert '"OrderItems"' in _order_item_names(out)
    _write_naming(tmp_path, {})
    capsys.readouterr()
    assert main(["verify", "--codegen"]) == 1
    err = capsys.readouterr().err
    assert (
        'The committed output was generated with "naming": { "columns": "snake_case", '
        '"tables": "literal" }; this run used "naming": { "columns": "snake_case", '
        '"tables": "snake_case" }' in err
    )
    assert (
        'Declare "naming": { "columns": "snake_case", "tables": "literal" } in '
        ".metaobjects/config.json" in err
    )
    assert "regenerate (metaobjects gen)" not in err


def test_verify_finds_a_column_and_table_rule_that_differ_together(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    # Committed under literal columns AND literal tables; the config now declares neither.
    # No single rule change reproduces the committed tree; the two together do.
    _project(tmp_path, {"columns": "literal", "tables": "literal"})
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    _write_naming(tmp_path, {})
    capsys.readouterr()
    assert main(["verify", "--codegen"]) == 1
    err = capsys.readouterr().err
    assert (
        'Declare "naming": { "columns": "literal", "tables": "literal" } in '
        ".metaobjects/config.json" in err
    )
    assert "regenerate (metaobjects gen)" not in err


def test_real_drift_still_says_regenerate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    out = _project(tmp_path, {"columns": "snake_case"})
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    [path] = list(out.rglob("subscriber_names.py"))
    path.write_text(path.read_text(encoding="utf-8") + "# edited\n", encoding="utf-8")
    capsys.readouterr()
    assert main(["verify", "--codegen"]) == 1
    err = capsys.readouterr().err
    assert "regenerate (metaobjects gen) and commit the result." in err
    assert "The committed output was generated with" not in err


# --- wire (ADR-0019 Amendment 2) ----------------------------------------------------------

PRICED_MODEL = {
    "metadata.root": {
        "package": "acme",
        "children": [
            {"object.entity": {"name": "Invoice", "children": [
                {"source.rdb": {"@table": "invoices"}},
                {"field.long": {"name": "id"}},
                {"field.decimal": {"name": "amount", "@precision": 12, "@scale": 2}},
                {"identity.primary": {"@fields": "id"}},
            ]}},
        ],
    }
}


def _wire_project(root: Path, wire: dict[str, str] | None) -> Path:
    meta = root / "metaobjects"
    meta.mkdir(parents=True, exist_ok=True)
    (meta / "meta.acme.json").write_text(json.dumps(PRICED_MODEL), encoding="utf-8")
    (root / "metaobjects.config.yaml").write_text(
        "targets:\n  app:\n    outDir: gen\n    generators: [entity, filter-allowlist, routes]\n",
        encoding="utf-8",
    )
    _write_wire(root, wire)
    return root / "gen"


def _write_wire(root: Path, wire: dict[str, str] | None) -> None:
    dot = root / ".metaobjects"
    dot.mkdir(parents=True, exist_ok=True)
    raw: dict[str, object] = {"schema_version": 1, "naming": {"columns": "literal"}}
    if wire is not None:
        raw["wire"] = wire
    (dot / "config.json").write_text(json.dumps(raw), encoding="utf-8")


def test_wire_in_dot_metaobjects_config_reaches_the_generated_router(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    out = _wire_project(tmp_path, {"decimals": "string", "nullMembers": "omit"})
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    [router] = list(out.rglob("invoice_router.py"))
    assert '_WIRE = WireOutput(decimals="string", null_members="omit")' in router.read_text(encoding="utf-8")
    capsys.readouterr()
    assert main(["verify", "--codegen"]) == 0


def test_verify_with_another_wire_says_the_wire_block_differs_not_regenerate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    # Committed under the portable form; then the config drops the wire block, so the native
    # default disagrees. Regenerating would change the JSON the routes write to existing clients.
    _wire_project(tmp_path, {"decimals": "string", "nullMembers": "omit"})
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    _write_wire(tmp_path, None)
    capsys.readouterr()
    assert main(["verify", "--codegen"]) == 1
    err = capsys.readouterr().err
    assert (
        'The committed output was generated with "wire": { "decimals": "string", '
        '"nullMembers": "omit" }; this run used "wire": { "decimals": "native", '
        '"nullMembers": "native" } (the wire block of .metaobjects/config.json; each key '
        "defaults to native). Do not regenerate" in err
    )
    assert (
        'Declare "wire": { "decimals": "string", "nullMembers": "omit" } in '
        ".metaobjects/config.json" in err
    )
    assert "regenerate (metaobjects gen)" not in err


def test_verify_with_unrelated_drift_next_to_a_wire_change_still_says_regenerate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    out = _wire_project(tmp_path, {"decimals": "string"})
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    [router] = list(out.rglob("invoice_router.py"))
    router.write_text(router.read_text(encoding="utf-8") + "# edited\n", encoding="utf-8")
    capsys.readouterr()
    assert main(["verify", "--codegen"]) == 1
    err = capsys.readouterr().err
    assert "regenerate (metaobjects gen) and commit the result." in err
    assert "this run used \"wire\"" not in err


# --- templates ----------------------------------------------------------------------------


def _template_project(root: Path, extra: str, body: str = "Program: {{title}}\n") -> None:
    """The fitness model, whose one prompt `coachNote` reads `fitness/coach-note`, with its
    body under ``tpl/`` (neither default name, so only the config can point at it)."""
    meta = root / "metaobjects"
    meta.mkdir(parents=True, exist_ok=True)
    (meta / FITNESS.name).write_text(FITNESS.read_text(encoding="utf-8"), encoding="utf-8")
    body_dir = root / "tpl" / "fitness"
    body_dir.mkdir(parents=True, exist_ok=True)
    (body_dir / "coach-note.mustache").write_text(body, encoding="utf-8")
    (root / "metaobjects.config.yaml").write_text(
        f"{extra}targets:\n  app:\n    outDir: gen\n    generators: [entity, render-helper]\n",
        encoding="utf-8",
    )


def test_templates_in_the_config_reaches_gen_and_both_verify_gates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    _template_project(tmp_path, "templates: tpl\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert list((tmp_path / "gen").rglob("*render*.py"))
    capsys.readouterr()
    assert main(["verify", "--codegen"]) == 0
    # S9: no <metadata_dir>, no --prompts: both come from the config.
    assert main(["verify", "--templates"]) == 0
    assert "template ref(s) clean" in capsys.readouterr().out


def test_verify_templates_from_the_config_still_catches_drift(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    _template_project(tmp_path, "templates: tpl\n", body="Program: {{nope}}\n")
    monkeypatch.chdir(tmp_path)
    capsys.readouterr()
    assert main(["verify", "--templates"]) == 1
    assert "metaobjects verify --templates: 1 drift error(s)." in capsys.readouterr().err


def test_a_template_directory_flag_that_contradicts_the_config_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    _template_project(tmp_path, "templates: tpl\n")
    (tmp_path / "prompts").mkdir()
    monkeypatch.chdir(tmp_path)
    assert main(["gen", "--templates", "prompts"]) == 2
    assert "contradicts templates: tpl in metaobjects.config.yaml" in capsys.readouterr().err
    assert main(["verify", "--templates", "--prompts", "prompts"]) == 2
    assert main(["gen", "--templates", "tpl"]) == 0


def test_an_absolute_templates_path_and_a_flag_naming_the_same_directory_agree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _template_project(tmp_path, f"templates: {tmp_path / 'sub' / '..' / 'tpl'}\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen", "--templates", "tpl"]) == 0
    assert main(["verify", "--templates", "--prompts", "tpl"]) == 0


def test_verify_templates_with_no_config_and_no_metadata_dir_says_what_it_needs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["verify", "--templates"]) == 2
    assert "run it beside a metaobjects.config.yaml" in capsys.readouterr().err
