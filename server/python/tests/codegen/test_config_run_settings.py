"""The run settings ``metaobjects.config.yaml`` declares once: ``columnNaming`` and ``templates``.

Through 1.1.0's release candidates the column naming and the template directory were flags
only. The migration guide replaced a script's ``metaobjects gen <dir> --out ... --generators ...``
with a plain ``metaobjects gen`` once the config declared the list, and that plain run used
the default naming, ``literal``: it rewrote every ``*_names.py`` with camelCase column names the
database does not have. ``verify --codegen`` then advised regenerating, which commits the wrong
names. Now the config declares both settings, ``gen`` and ``verify`` read them from there, a
flag that contradicts the config is refused, and a verify whose naming differs from the one the
committed output was generated with says so instead of "regenerate".

``verify --templates`` reads the same config, so a project does not spell its metadata and
template directories a second time for that gate.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.cli import main
from metaobjects.codegen.project_config import COLUMN_NAMING_VALUES, ConfigError, load_project_config
from metaobjects.naming import COLUMN_NAMING_STRATEGIES

REPO = Path(__file__).parents[4]
FITNESS = REPO / "fixtures" / "persistence-conformance" / "canonical" / "meta.fitness.json"

# `createdAt` has a case boundary, so its column is `createdAt` under `literal` and
# `created_at` under `snake_case`.
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
        ],
    }
}

SNAKE = 'SUBSCRIBER_CREATED_AT_COLUMN: Final[str] = "created_at"'
LITERAL = 'SUBSCRIBER_CREATED_AT_COLUMN: Final[str] = "createdAt"'


def _project(root: Path, extra: str = "") -> Path:
    meta = root / "metaobjects"
    meta.mkdir(parents=True, exist_ok=True)
    (meta / "meta.acme.json").write_text(json.dumps(MODEL), encoding="utf-8")
    (root / "metaobjects.config.yaml").write_text(
        f"{extra}targets:\n  app:\n    outDir: gen\n    generators: [names]\n", encoding="utf-8"
    )
    return root / "gen"


def _names(out: Path) -> str:
    [path] = list(out.rglob("subscriber_names.py"))
    return path.read_text(encoding="utf-8")


def test_column_naming_values_match_the_cli() -> None:
    assert sorted(COLUMN_NAMING_VALUES) == sorted(COLUMN_NAMING_STRATEGIES)


def test_column_naming_snake_case_in_the_config_makes_a_plain_gen_write_snake_case_and_verify_agrees(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    out = _project(tmp_path, "columnNaming: snake_case\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    names = _names(out)
    assert SNAKE in names
    assert LITERAL not in names
    capsys.readouterr()
    assert main(["verify", "--codegen"]) == 0
    assert "in sync" in capsys.readouterr().out


def test_a_flag_that_agrees_is_accepted_and_one_that_contradicts_the_config_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    out = _project(tmp_path, "columnNaming: snake_case\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen", "--column-naming", "snake_case"]) == 0
    capsys.readouterr()
    assert main(["verify", "--codegen", "--column-naming", "literal"]) == 2
    assert (
        "--column-naming literal contradicts columnNaming: snake_case in metaobjects.config.yaml"
        in capsys.readouterr().err
    )
    (tmp_path / "gen").rename(tmp_path / "kept")
    assert main(["gen", "--column-naming", "literal"]) == 2
    assert not out.exists()


def test_verify_with_another_naming_says_the_naming_differs_not_regenerate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    # Committed with snake_case through the flag; the config declares nothing, so a plain
    # verify runs the default, literal.
    out = _project(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["gen", "--column-naming", "snake_case"]) == 0
    assert SNAKE in _names(out)
    capsys.readouterr()
    assert main(["verify", "--codegen"]) == 1
    err = capsys.readouterr().err
    assert (
        "The committed output was generated with column naming snake_case; this run used "
        "literal (the default). Do not regenerate" in err
    )
    assert "`columnNaming: snake_case` in metaobjects.config.yaml" in err
    assert "regenerate (metaobjects gen)" not in err


def test_real_drift_still_says_regenerate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    out = _project(tmp_path, "columnNaming: snake_case\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    [path] = list(out.rglob("subscriber_names.py"))
    path.write_text(path.read_text(encoding="utf-8") + "# edited\n", encoding="utf-8")
    capsys.readouterr()
    assert main(["verify", "--codegen"]) == 1
    err = capsys.readouterr().err
    assert "regenerate (metaobjects gen) and commit the result." in err
    assert "column naming" not in err


def test_the_loader_refuses_an_unknown_column_naming(tmp_path: Path) -> None:
    _project(tmp_path, "columnNaming: PascalCase\n")
    with pytest.raises(ConfigError, match="'columnNaming' must be one of"):
        load_project_config(tmp_path / "metaobjects.config.yaml")


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


def test_verify_templates_with_no_config_and_no_metadata_dir_says_what_it_needs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["verify", "--templates"]) == 2
    assert "run it beside a metaobjects.config.yaml" in capsys.readouterr().err
