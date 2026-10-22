"""One generator list, one gen command (ADR-0034 Amendment 9), as the Python port answers it.

``metaobjects.config.yaml`` is the list: ``metaobjects gen`` runs exactly the entries its
targets declare, documentation included, and ``verify --codegen`` regenerates the same list
and diffs it. Nothing is generated that the config does not declare; a config that declares
nothing writes nothing and says so; a run with no config, or with the 1.0 docs block, fails
before it writes anything; and ``metaobjects docs`` only says where documentation went.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.cli import (
    DOCS_COMMAND_REMOVED,
    legacy_docs_message,
    main,
    no_generator_list_message,
)

REPO = Path(__file__).parents[4]
FITNESS = REPO / "fixtures" / "persistence-conformance" / "canonical" / "meta.fitness.json"
TEMPLATE_CORPUS = REPO / "fixtures" / "template-codegen-conformance"


def _metadata(root: Path) -> Path:
    meta = root / "metaobjects"
    meta.mkdir(parents=True, exist_ok=True)
    (meta / FITNESS.name).write_text(FITNESS.read_text(encoding="utf-8"), encoding="utf-8")
    return meta


def _config(root: Path, text: str) -> Path:
    cfg = root / "metaobjects.config.yaml"
    cfg.write_text(text, encoding="utf-8")
    return cfg


def _files(root: Path) -> set[str]:
    """Every file under *root*, relative, ignoring interpreter droppings."""
    if not root.exists():
        return set()
    return {p.relative_to(root).as_posix() for p in root.rglob("*")
            if p.is_file() and "__pycache__" not in p.parts}


# --- a. a list that declares nothing writes nothing ---------------------------------------


def test_a_target_that_declares_nothing_writes_zero_files_and_says_so(
    tmp_path: Path, monkeypatch, capsys,
) -> None:
    _metadata(tmp_path)
    _config(tmp_path, "targets:\n  main:\n    outDir: gen\n    generators: []\n")
    before = _files(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert "target 'main' declares no generators; nothing written" in capsys.readouterr().out
    assert _files(tmp_path / "gen") == set()
    assert _files(tmp_path) == before


# --- b. one listed generator writes only its own files ------------------------------------


def test_a_target_listing_only_api_docs_writes_only_its_pages_with_its_options(
    tmp_path: Path, monkeypatch,
) -> None:
    _metadata(tmp_path)
    _config(
        tmp_path,
        "apiDocs:\n  apiSubDir: reference/py\n  projectName: shop\n"
        "  modelBaseUrl: https://docs.example.com/model\n"
        "targets:\n  docs:\n    outDir: docs\n    generators: [api-docs]\n",
    )
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    written = _files(tmp_path / "docs")
    assert written and all(w.startswith("reference/py/") and w.endswith(".md") for w in written)
    assert {"reference/py/README.md", "reference/py/AGENT-API.md"} <= written
    pages = {w: (tmp_path / "docs" / w).read_text(encoding="utf-8") for w in written}
    assert "shop" in pages["reference/py/AGENT-API.md"]
    assert any("https://docs.example.com/model/" in text for text in pages.values())
    # Nothing else in the project was generated: no code target, no stray directory.
    assert not (tmp_path / "gen").exists()


def test_a_target_listing_only_entity_writes_only_entity_files(tmp_path: Path, monkeypatch) -> None:
    _metadata(tmp_path)
    _config(tmp_path, "targets:\n  main:\n    outDir: gen\n    generators: [entity]\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    written = _files(tmp_path / "gen")
    assert "Program.py" in written
    assert not any(w.endswith((".md", "_router.py", "_filter_allowlist.py", "_names.py"))
                   for w in written)
    assert not (tmp_path / "docs").exists()


# --- c. the removed command ---------------------------------------------------------------


def test_the_docs_command_prints_its_removal_line_and_writes_nothing(
    tmp_path: Path, monkeypatch, capsys,
) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["docs", "anything", "--out", "x"]) == 2
    captured = capsys.readouterr()
    assert captured.err.strip() == DOCS_COMMAND_REMOVED
    assert captured.out == ""
    assert _files(tmp_path) == set()


def test_the_removal_line_is_the_amendment_s() -> None:
    assert DOCS_COMMAND_REMOVED == (
        "metaobjects docs was removed in 1.1.0. `metaobjects gen` writes documentation now: "
        "declare each docs generator in a target's `generators` in metaobjects.config.yaml. "
        'See https://github.com/metaobjectsdev/metaobjects/blob/v1.1.0/docs/features/migrations/docs-are-generators.md, section "Python".'
    )


# --- d. the 1.0 docs block ----------------------------------------------------------------


@pytest.mark.parametrize("argv, command", [
    (["gen"], "metaobjects gen"),
    (["verify", "--codegen"], "metaobjects verify --codegen"),
])
def test_a_1_0_docs_block_fails_before_anything_is_written(
    argv: list[str], command: str, tmp_path: Path, monkeypatch, capsys,
) -> None:
    _metadata(tmp_path)
    _config(
        tmp_path,
        "docs:\n  generators: [codegen.generators.api_docs:api_docs_generator]\n"
        "targets:\n  main:\n    outDir: gen\n    generators: [entity]\n",
    )
    monkeypatch.chdir(tmp_path)
    assert main(argv) == 2
    assert legacy_docs_message(command) in capsys.readouterr().err
    assert not (tmp_path / "gen").exists()


def test_the_1_0_shape_line_is_the_amendment_s() -> None:
    assert legacy_docs_message("metaobjects gen") == (
        "metaobjects gen: found 1.0 docs configuration (the docs block in "
        "metaobjects.config.yaml). Nothing reads it any more, so this run would write no "
        "documentation. Declare each docs generator in a target's `generators` in "
        "metaobjects.config.yaml. See https://github.com/metaobjectsdev/metaobjects/blob/v1.1.0/docs/features/migrations/docs-are-generators.md, "
        'section "Python".'
    )


# --- e. no list at all --------------------------------------------------------------------


@pytest.mark.parametrize("argv, command", [
    (["gen"], "metaobjects gen"),
    (["gen", "./metaobjects", "--out", "gen", "--generators", "entity"], "metaobjects gen"),
    (["verify", "--codegen"], "metaobjects verify --codegen"),
    (["verify", "--codegen", "./metaobjects", "--out", "gen"], "metaobjects verify --codegen"),
])
def test_no_config_fails_and_writes_nothing(
    argv: list[str], command: str, tmp_path: Path, monkeypatch, capsys,
) -> None:
    _metadata(tmp_path)
    before = _files(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(argv) == 2
    assert no_generator_list_message(command) in capsys.readouterr().err
    assert _files(tmp_path) == before


def test_the_no_list_line_is_the_amendment_s() -> None:
    assert no_generator_list_message("metaobjects gen") == (
        "metaobjects gen: no metaobjects.config.yaml. The generator list lives there in 1.1.0, "
        'documentation included. See https://github.com/metaobjectsdev/metaobjects/blob/v1.1.0/docs/features/migrations/docs-are-generators.md, section "Python".'
    )


def test_the_1_0_flag_form_beside_a_config_is_refused(tmp_path: Path, monkeypatch, capsys) -> None:
    """A config is there, but the run also names a directory and an outDir of its own: that
    would be a second list, so it is refused rather than either one silently winning."""
    _metadata(tmp_path)
    _config(tmp_path, "targets:\n  main:\n    outDir: gen\n    generators: [entity]\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen", "./metaobjects", "--out", "elsewhere"]) == 2
    assert "<metadata_dir> and --out are not read in 1.1.0" in capsys.readouterr().err
    assert not (tmp_path / "gen").exists() and not (tmp_path / "elsewhere").exists()


# --- f. --generators narrows, never adds --------------------------------------------------


def test_generators_naming_an_undeclared_entry_is_refused(tmp_path: Path, monkeypatch, capsys) -> None:
    _metadata(tmp_path)
    _config(tmp_path, "targets:\n  main:\n    outDir: gen\n    generators: [entity]\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen", "--generators", "entity,routes"]) != 0
    err = capsys.readouterr().err
    assert "--generators names 'routes'" in err and "only narrows the declared list" in err
    assert not (tmp_path / "gen").exists()


def test_generators_naming_a_declared_entry_runs_only_it(tmp_path: Path, monkeypatch) -> None:
    _metadata(tmp_path)
    _config(
        tmp_path,
        "targets:\n  main:\n    outDir: gen\n    generators: [entity, routes]\n"
        "  docs:\n    outDir: docs\n    generators: [api-docs]\n",
    )
    monkeypatch.chdir(tmp_path)
    assert main(["gen", "--generators", "api-docs"]) == 0
    assert _files(tmp_path / "docs")
    assert not (tmp_path / "gen").exists()
    assert main(["gen", "--generators", "routes"]) == 0
    written = _files(tmp_path / "gen")
    assert any(w.endswith("_router.py") for w in written)
    assert "Program.py" not in written


# --- g. templateSpec on a target ----------------------------------------------------------


def test_a_template_spec_on_a_target_writes_into_its_out_dir_and_verifies_clean(
    tmp_path: Path, monkeypatch, capsys,
) -> None:
    _config(
        tmp_path,
        f"metadata: {json.dumps(str(TEMPLATE_CORPUS / 'metadata'))}\n"
        "targets:\n  text:\n    outDir: out\n    generators: []\n"
        f"    templateSpec: {json.dumps(str(TEMPLATE_CORPUS / 'spec.json'))}\n",
    )
    monkeypatch.chdir(tmp_path)
    templates = ["--templates", str(TEMPLATE_CORPUS / "templates")]
    assert main(["gen", *templates]) == 0
    written = _files(tmp_path / "out")
    assert written, "the spec wrote nothing"
    assert not any(Path(w).name == "__init__.py" for w in written), written
    capsys.readouterr()
    assert main(["verify", "--codegen", "--templates-root", str(TEMPLATE_CORPUS / "templates")]) == 0


# --- h. verify --codegen covers the api reference -----------------------------------------


def test_verify_codegen_checks_api_docs_pages(tmp_path: Path, monkeypatch, capsys) -> None:
    _metadata(tmp_path)
    _config(tmp_path, "targets:\n  docs:\n    outDir: docs\n    generators: [api-docs]\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert main(["verify", "--codegen"]) == 0
    page = tmp_path / "docs" / "api" / "python" / "AGENT-API.md"
    page.write_text(page.read_text(encoding="utf-8") + "\nhand edit\n", encoding="utf-8")
    capsys.readouterr()
    assert main(["verify", "--codegen"]) == 1
    assert "drifted: api/python/AGENT-API.md" in capsys.readouterr().err


# --- i. a narrowed verify --codegen run never reports another entry's files as drift ------


def test_verify_generators_narrowed_run_is_in_sync_after_a_full_gen(
    tmp_path: Path, monkeypatch,
) -> None:
    """``--generators api-docs`` regenerates nothing into the `main` target's outDir — that
    is not drift, just an outDir this narrowed run never touched."""
    _metadata(tmp_path)
    _config(
        tmp_path,
        "targets:\n  main:\n    outDir: gen\n    generators: [entity, routes]\n"
        "  docs:\n    outDir: docs\n    generators: [api-docs]\n",
    )
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert main(["verify", "--codegen", "--generators", "api-docs"]) == 0


def test_verify_entities_narrowed_run_is_in_sync_after_a_full_gen(
    tmp_path: Path, monkeypatch,
) -> None:
    """``--entities Program`` regenerates only Program's file; Week's committed file, also
    written by the same target's same generator, is not drift either."""
    _metadata(tmp_path)
    _config(tmp_path, "targets:\n  main:\n    outDir: gen\n    generators: [entity]\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert "Week.py" in _files(tmp_path / "gen")
    assert main(["verify", "--codegen", "--entities", "Program"]) == 0


def test_verify_entities_narrowed_run_still_catches_a_real_edit(
    tmp_path: Path, monkeypatch, capsys,
) -> None:
    """Suppressing the false ``extra`` must not suppress real drift in what the narrowed run
    DID regenerate."""
    _metadata(tmp_path)
    _config(tmp_path, "targets:\n  main:\n    outDir: gen\n    generators: [entity]\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    program = tmp_path / "gen" / "Program.py"
    program.write_text(program.read_text(encoding="utf-8") + "\n# hand edit\n", encoding="utf-8")
    capsys.readouterr()
    assert main(["verify", "--codegen", "--entities", "Program"]) == 1
    assert "drifted: Program.py" in capsys.readouterr().err


def test_verify_entities_narrowed_run_checks_a_shared_aggregate_against_the_whole_list(
    tmp_path: Path, monkeypatch, capsys,
) -> None:
    """``enums.py`` holds every entity's shared enums, so ``--entities Shirt`` must compare it
    with what the whole list writes, not with a module built from Shirt alone."""
    meta = tmp_path / "metaobjects"
    meta.mkdir()
    (meta / "meta.shop.json").write_text(json.dumps({"metadata.root": {"package": "shop", "children": [
        {"field.enum": {"name": "Color", "abstract": True, "@values": ["RED", "BLUE"]}},
        {"field.enum": {"name": "Size", "abstract": True, "@values": ["S", "L"]}},
        {"object.entity": {"name": "Shirt", "children": [
            {"field.long": {"name": "id"}},
            {"field.enum": {"name": "color", "extends": "Color"}},
            {"source.rdb": {"@table": "shirts"}},
            {"identity.primary": {"name": "pk", "@fields": ["id"]}},
        ]}},
        {"object.entity": {"name": "Shoe", "children": [
            {"field.long": {"name": "id"}},
            {"field.enum": {"name": "size", "extends": "Size"}},
            {"source.rdb": {"@table": "shoes"}},
            {"identity.primary": {"name": "pk", "@fields": ["id"]}},
        ]}},
    ]}}), encoding="utf-8")
    _config(tmp_path, "targets:\n  main:\n    outDir: gen\n    generators: [entity]\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    enums = (tmp_path / "gen" / "enums.py").read_text(encoding="utf-8")
    assert "class Color" in enums and "class Size" in enums
    capsys.readouterr()
    assert main(["verify", "--codegen", "--entities", "Shirt"]) == 0, capsys.readouterr().err

    (tmp_path / "gen" / "enums.py").write_text(enums + "\n# hand edit\n", encoding="utf-8")
    assert main(["verify", "--codegen", "--entities", "Shirt"]) == 1
    assert "drifted: enums.py" in capsys.readouterr().err


@pytest.mark.parametrize("command", [["gen"], ["verify", "--codegen"]])
def test_an_entities_name_that_matches_no_object_is_refused(
    tmp_path: Path, monkeypatch, capsys, command: list[str],
) -> None:
    """A typo'd ``--entities`` would generate, and so check, nothing: a hand-edited file
    must not pass a narrowed verify because the name matched no object."""
    _metadata(tmp_path)
    _config(tmp_path, "targets:\n  main:\n    outDir: gen\n    generators: [entity]\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    program = tmp_path / "gen" / "Program.py"
    program.write_text(program.read_text(encoding="utf-8") + "\n# hand edit\n", encoding="utf-8")
    before = _files(tmp_path / "gen")
    capsys.readouterr()
    assert main([*command, "--entities", "Prgram"]) == 2
    assert "--entities names 'Prgram', which matches no object in the metadata." in capsys.readouterr().err
    assert _files(tmp_path / "gen") == before


@pytest.mark.parametrize("command", [["gen"], ["verify", "--codegen"]])
def test_a_blank_generators_selection_is_refused(
    tmp_path: Path, monkeypatch, capsys, command: list[str],
) -> None:
    """An unset shell variable gives ``--generators ""``: a narrowing to nothing, never the
    whole list."""
    _metadata(tmp_path)
    _config(tmp_path, "targets:\n  main:\n    outDir: gen\n    generators: [entity]\n")
    monkeypatch.chdir(tmp_path)
    assert main([*command, "--generators", ""]) == 2
    assert "--generators names no generator." in capsys.readouterr().err
    assert not (tmp_path / "gen").exists()


# --- j. a 1.0-shape target ----------------------------------------------------------------


@pytest.mark.parametrize("command", [["gen"], ["verify", "--codegen"]])
def test_a_target_with_no_generators_key_is_refused_with_the_migration_line(
    tmp_path: Path, monkeypatch, capsys, command: list[str],
) -> None:
    _metadata(tmp_path)
    _config(tmp_path, "targets:\n  api:\n    outDir: gen\n")
    monkeypatch.chdir(tmp_path)
    assert main(command) == 2
    name = " ".join(["metaobjects", *command])
    assert capsys.readouterr().err.strip() == (
        f"{name}: target(s) 'api' declare no `generators` key. In 1.1.0 a target runs only the "
        "generators it lists: list them, or write `generators: []` for a target that writes "
        'nothing. See https://github.com/metaobjectsdev/metaobjects/blob/v1.1.0/docs/features/migrations/docs-are-generators.md, section "Python".'
    )
    assert not (tmp_path / "gen").exists()


def test_a_comma_inside_one_generators_entry_is_refused(tmp_path: Path, monkeypatch, capsys) -> None:
    """``["entity, routes"]`` is one entry naming two generators; resolving it as one would
    run ``entity`` and drop ``routes`` without a word."""
    _metadata(tmp_path)
    _config(tmp_path, 'targets:\n  main:\n    outDir: gen\n    generators: ["entity, routes"]\n')
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) != 0
    assert "generators entry 'entity, routes' holds a comma" in capsys.readouterr().err
    assert not _files(tmp_path / "gen")


# --- a model with no objects still gets its api reference ---------------------------------


def test_api_docs_writes_the_reference_for_a_model_with_no_objects(
    tmp_path: Path, monkeypatch,
) -> None:
    # `metaobjects docs` wrote the index pages for any model; the declared entry must too,
    # even when there is no object for a per-entity generator to read.
    meta = tmp_path / "metaobjects"
    meta.mkdir()
    (meta / "meta.empty.json").write_text(
        json.dumps({"metadata.root": {"package": "acme::empty", "children": []}}),
        encoding="utf-8",
    )
    _config(tmp_path, "targets:\n  docs:\n    outDir: docs\n    generators: [api-docs]\n")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert _files(tmp_path / "docs") == {"api/python/README.md", "api/python/AGENT-API.md"}


# --- a conventional template-spec.json nothing declares is refused ------------------------


@pytest.mark.parametrize("argv, command", [
    (["gen"], "metaobjects gen"),
    (["verify", "--codegen"], "metaobjects verify --codegen"),
])
def test_a_conventional_template_spec_no_target_declares_is_refused(
    tmp_path: Path, monkeypatch, capsys, argv: list[str], command: str,
) -> None:
    from metaobjects.cli import legacy_template_spec_message

    _metadata(tmp_path)
    (tmp_path / "template-spec.json").write_text('{"generators": []}', encoding="utf-8")
    _config(tmp_path, "targets:\n  main:\n    outDir: gen\n    generators: [entity]\n")
    before = _files(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(argv) == 2
    assert capsys.readouterr().err.strip() == legacy_template_spec_message(command)
    assert _files(tmp_path) == before
