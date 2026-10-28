"""`metaobjects init` scaffolds a config and a metadata directory, and never overwrites."""
from __future__ import annotations

from pathlib import Path

from metaobjects.cli import main


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
    assert 'APIRouter(prefix="/v1/authors"' in (tmp_path / "generated" / "author_router.py").read_text()
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
