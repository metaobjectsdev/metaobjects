"""FR-023 Task 18 — the Python CLI's collection-aware `gen`/`verify --codegen`:
a dependency's objects are excluded from codegen selection by default
(DESIGN §11.1 item 2); `scope.include` naming the dependency's package opts it
in; a target's `entities:` (or `--entities`) naming ONLY an excluded import
refuses with exit 2; `verify --codegen` shares the same selection as `gen`.

Uses the plan's reference fixtures verbatim (`APP`, `LOCK_V1`, the pinned
`acme-common-v1.json` artifact) — see
`.superpowers/sdd/2026-09-11-fr-023-phase-1a/global-constraints.md`.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from metaobjects.cli import main

_CORPUS_ARTIFACT = (
    Path(__file__).resolve().parents[4]
    / "fixtures"
    / "dependency-conformance"
    / "artifacts"
    / "acme-common-v1.json"
)

_APP_JSON = (
    '{"metadata.root":{"package":"app","children":[{"object.entity":{"name":"Order",'
    '"children":[{"source.rdb":{"@table":"orders"}},{"field.long":{"name":"id"}},'
    '{"identity.primary":{"name":"pk","@fields":["id"]}}]}}]}}'
)

_LOCK_V1 = {
    "schema_version": 1,
    "dependencies": {
        "acme-common": {
            "version": "1.0.0",
            "metamodelVersion": "1.0",
            "resolvedFrom": {"path": "../acme-common/metaobjects"},
            "artifact": "acme-common.metaobjects.json",
            "integrity": "sha256-10fbf886e22faceca32c56e5e647c3ff1c82f503e638cba3bd3aa9390f7c409d",
            "packages": ["acme::common"],
            "nodes": [
                "acme::common::Address",
                "acme::common::Audited",
                "acme::common::Customer",
            ],
        }
    },
}


def _consumer(
    tmp_path: Path,
    *,
    scope_include: list[str] | None = None,
    target_entities: list[str] | None = None,
) -> Path:
    """A consumer project: APP + SNAP + CONFIG_REF + LOCK_V1, with one
    `metaobjects.config.yaml` target (`generators: [names]`)."""
    (tmp_path / "metaobjects").mkdir()
    (tmp_path / "metaobjects" / "meta.app.json").write_text(_APP_JSON)

    metaobjects_dir = tmp_path / ".metaobjects"
    deps_dir = metaobjects_dir / "deps" / "acme-common"
    deps_dir.mkdir(parents=True)
    shutil.copyfile(_CORPUS_ARTIFACT, deps_dir / "acme-common.metaobjects.json")

    config_json: dict[str, object] = {
        "schema_version": 1,
        "sources": [],
        "dependencies": [{"name": "acme-common", "path": "../acme-common/metaobjects"}],
    }
    if scope_include is not None:
        config_json["scope"] = {"include": scope_include}
    (metaobjects_dir / "config.json").write_text(json.dumps(config_json))
    (metaobjects_dir / "deps.lock.json").write_text(json.dumps(_LOCK_V1))

    entities_line = f"\n    entities: {json.dumps(target_entities)}" if target_entities else ""
    (tmp_path / "metaobjects.config.yaml").write_text(
        "metadata: metaobjects\n"
        "targets:\n"
        "  main:\n"
        "    outDir: gen\n"
        f"    generators: [names]{entities_line}\n"
    )
    return tmp_path / "metaobjects.config.yaml"


def test_gen_excludes_the_dependencys_entities_by_default(tmp_path: Path) -> None:
    cfg = _consumer(tmp_path)
    rc = main(["gen", "--config", str(cfg)])
    assert rc == 0
    assert (tmp_path / "gen" / "order_names.py").exists()
    assert not (tmp_path / "gen" / "customer_names.py").exists()


def test_gen_scope_include_naming_the_package_opts_it_in(tmp_path: Path) -> None:
    cfg = _consumer(tmp_path, scope_include=["acme::common::**"])
    rc = main(["gen", "--config", str(cfg)])
    assert rc == 0
    assert (tmp_path / "gen" / "order_names.py").exists()
    assert (tmp_path / "gen" / "customer_names.py").exists()


def test_gen_a_wildcard_scope_include_does_not_opt_the_package_in(tmp_path: Path) -> None:
    # `acme::**` REACHES the package's nodes without NAMING it literally
    # (`explicitly_includes`) — the default exclusion still applies.
    cfg = _consumer(tmp_path, scope_include=["acme::**"])
    rc = main(["gen", "--config", str(cfg)])
    assert rc == 0
    assert (tmp_path / "gen" / "order_names.py").exists()
    assert not (tmp_path / "gen" / "customer_names.py").exists()


def test_gen_target_naming_an_excluded_import_refuses_with_exit_2(
    tmp_path: Path, capsys
) -> None:
    cfg = _consumer(tmp_path, target_entities=["Customer"])
    rc = main(["gen", "--config", str(cfg)])
    assert rc == 2
    err = capsys.readouterr().err
    assert "'Customer'" in err
    assert "acme-common" in err
    assert "scope.include" in err
    assert not (tmp_path / "gen").exists()


def test_gen_target_naming_an_excluded_import_is_fine_once_scope_includes_it(
    tmp_path: Path,
) -> None:
    cfg = _consumer(tmp_path, scope_include=["acme::common::**"], target_entities=["Customer"])
    rc = main(["gen", "--config", str(cfg)])
    assert rc == 0
    assert (tmp_path / "gen" / "customer_names.py").exists()
    assert not (tmp_path / "gen" / "order_names.py").exists()


def test_verify_codegen_shares_the_selection_with_gen(tmp_path: Path) -> None:
    cfg = _consumer(tmp_path)
    assert main(["gen", "--config", str(cfg)]) == 0
    # Fresh gen, same selection → verify --codegen must see no drift, and must
    # NOT regenerate the excluded customer_names.py and report it "missing".
    assert main(["verify", "--codegen", "--config", str(cfg)]) == 0


def test_verify_codegen_shares_the_selection_after_scope_widens(tmp_path: Path) -> None:
    cfg = _consumer(tmp_path, scope_include=["acme::common::**"])
    assert main(["gen", "--config", str(cfg)]) == 0
    assert main(["verify", "--codegen", "--config", str(cfg)]) == 0


def test_gen_a_stale_snapshot_is_refused_before_generation(tmp_path: Path, capsys) -> None:
    """Step 2's fifth scenario: editing one byte of the committed snapshot must
    make `resolve_metadata_location` -> `build_collection` -> `verify_snapshot`
    raise `ERR_DEPENDENCY_SNAPSHOT_STALE` BEFORE anything is loaded or
    generated — never a partial/stale `gen/` directory."""
    cfg = _consumer(tmp_path)
    artifact = tmp_path / ".metaobjects" / "deps" / "acme-common" / "acme-common.metaobjects.json"
    data = bytearray(artifact.read_bytes())
    data[0] ^= 0xFF  # one bit-flipped byte -> the lock's pinned sha256 no longer matches
    artifact.write_bytes(bytes(data))

    rc = main(["gen", "--config", str(cfg)])
    assert rc != 0
    err = capsys.readouterr().err
    # `_resolve_metadata_location_or_print_error` prints `str(exc)` — a
    # ParseError's message, not its `.code` — so the STALE code itself is not
    # a substring; the message text IS the coded diagnostic here.
    assert "does not match the lock" in err
    assert "run `meta deps sync`" in err
    # The "before generation" half: no gen/ directory at all, not even a
    # partial one — the failure must happen in resolution, before run_gen ever
    # gets a root to generate from.
    assert not (tmp_path / "gen").exists()
