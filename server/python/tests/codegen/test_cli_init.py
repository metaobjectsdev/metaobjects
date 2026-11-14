"""`metaobjects init` scaffolds a config and a metadata directory, and never overwrites."""
from __future__ import annotations

import json
from pathlib import Path

from metaobjects.api_settings import ApiPagination
from metaobjects.cli import main
from metaobjects.config.neutral_config import read_neutral_config


def test_init_writes_a_config_with_no_docs_generator_and_a_loadable_model(
    tmp_path: Path, capsys
) -> None:
    assert main(["init", "--root", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert "wrote metaobjects.config.yaml" in out and "wrote metaobjects/meta.app.yaml" in out
    assert "api-docs" not in (tmp_path / "metaobjects.config.yaml").read_text()
    assert main(["gen", "--strict", "--config", str(tmp_path / "metaobjects.config.yaml")]) == 0


def test_init_with_docs_wires_api_docs_and_gen_runs(tmp_path: Path) -> None:
    assert main(["init", "--with-docs", "--root", str(tmp_path)]) == 0
    cfg = tmp_path / "metaobjects.config.yaml"
    assert "generators: [api-docs]" in cfg.read_text()
    assert main(["gen", "--config", str(cfg)]) == 0
    assert (tmp_path / "docs" / "api" / "python" / "README.md").is_file()


def test_init_never_overwrites_and_reports_what_it_kept(tmp_path: Path, capsys) -> None:
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text("mine: true\n")
    assert main(["init", "--root", str(tmp_path)]) == 0
    assert cfg.read_text() == "mine: true\n"
    out = capsys.readouterr().out
    assert "kept metaobjects.config.yaml" in out
    assert (tmp_path / "metaobjects" / "meta.app.yaml").is_file()


def test_api_prefix_in_the_config_reaches_routers_and_docs(tmp_path: Path) -> None:
    assert main(["init", "--with-docs", "--root", str(tmp_path)]) == 0
    (tmp_path / "metaobjects" / "meta.app.yaml").write_text(
        "metadata:\n  package: app\n  children:\n"
        "    - object.entity:\n        name: Author\n        children:\n"
        "          - source.rdb: { table: authors }\n"
        "          - field.long: { name: id }\n"
        "          - identity.primary: { name: pk, fields: [id] }\n"
    )
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(cfg.read_text().replace(
        "generators: []", "generators: [entity, filter-allowlist, routes]") + "apiPrefix: /v1\n")
    assert main(["gen", "--config", str(cfg)]) == 0
    assert 'APIRouter(prefix="/v1/authors"' in (tmp_path / "generated" / "app" / "author_router.py").read_text()
    assert "/v1/authors" in (tmp_path / "docs" / "api" / "python" / "app" / "Author.md").read_text()
    assert main(["verify", "--codegen", "--config", str(cfg)]) == 0


def test_api_prefix_must_be_empty_or_a_path(tmp_path: Path, capsys) -> None:
    assert main(["init", "--root", str(tmp_path)]) == 0
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(cfg.read_text() + "apiPrefix: v1\n")
    assert main(["gen", "--config", str(cfg)]) != 0
    assert "apiPrefix" in capsys.readouterr().err


def test_api_prefix_with_a_quote_or_backslash_is_refused(tmp_path: Path, capsys) -> None:
    # The prefix is written into the generated router's source, so it may only hold path characters.
    assert main(["init", "--root", str(tmp_path)]) == 0
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(cfg.read_text() + "apiPrefix: '/v1\"x'\n")
    assert main(["gen", "--config", str(cfg)]) != 0
    assert "apiPrefix" in capsys.readouterr().err


def test_init_writes_the_new_project_api_block_that_typescript_meta_init_writes(
    tmp_path: Path, capsys
) -> None:
    # Oracle: TypeScript `meta init` writes `migrate: {foreignKeyIndexes: true}`,
    # `verify: {handEdits: "fail"}` and `api: {pagination: {defaultLimit: 50, maxLimit: 1000},
    # unknownFields: "reject"}` into .metaobjects/config.json for a new project.
    assert main(["init", "--root", str(tmp_path)]) == 0
    assert "wrote .metaobjects/config.json" in capsys.readouterr().out
    neutral = read_neutral_config(tmp_path)
    assert neutral is not None
    assert neutral.api.pagination == ApiPagination(default_limit=50, max_limit=1000)
    raw = json.loads((tmp_path / ".metaobjects" / "config.json").read_text())
    assert raw["api"]["unknownFields"] == "reject"
    assert raw["migrate"] == {"foreignKeyIndexes": True}
    assert raw["verify"] == {"handEdits": "fail"}
    # The page size reaches a generated router.
    (tmp_path / "metaobjects" / "meta.app.yaml").write_text(
        "metadata:\n  package: app\n  children:\n"
        "    - object.entity:\n        name: Author\n        children:\n"
        "          - source.rdb: { table: authors }\n"
        "          - field.long: { name: id }\n"
        "          - identity.primary: { name: pk, fields: [id] }\n"
    )
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(cfg.read_text().replace(
        "generators: []", "generators: [entity, filter-allowlist, routes]"))
    assert main(["gen", "--config", str(cfg)]) == 0
    assert "limit_too_large" in (tmp_path / "generated" / "app" / "author_router.py").read_text()


def test_init_leaves_an_existing_neutral_config_alone(tmp_path: Path, capsys) -> None:
    neutral = tmp_path / ".metaobjects" / "config.json"
    neutral.parent.mkdir()
    neutral.write_text('{"schema_version": 1}\n')
    assert main(["init", "--root", str(tmp_path)]) == 0
    assert neutral.read_text() == '{"schema_version": 1}\n'
    assert "kept .metaobjects/config.json" in capsys.readouterr().out
