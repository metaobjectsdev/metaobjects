"""The ``shared-model`` generator through ``metaobjects gen`` (D6): its options, where its files
and its version come from, and how a publish it must refuse fails the run. The bytes it writes
are pinned by ``tests/conformance/test_shared_model_conformance.py``."""
from __future__ import annotations

import hashlib
import json
import textwrap
from pathlib import Path

import pytest

from metaobjects.cli import main
from metaobjects.codegen.generator_registry import GeneratorOption

_SOURCE = Path(__file__).resolve().parents[4] / "fixtures" / "shared-model-conformance" / "source"


def _project(root: Path, options: str, *, extra_files: bool = True, pyproject: str | None = None) -> Path:
    meta = root / "metaobjects"
    meta.mkdir(parents=True)
    for name in ("meta.base.json", "meta.customer.json"):
        (meta / name).write_text((_SOURCE / name).read_text(), encoding="utf-8")
    if extra_files:
        (meta / "meta.ledger.json").write_text((_SOURCE / "meta.ledger.json").read_text(), encoding="utf-8")
    if pyproject is not None:
        (root / "pyproject.toml").write_text(pyproject, encoding="utf-8")
    (root / "metaobjects.config.yaml").write_text(
        "targets:\n  publish:\n    outDir: published\n    generators:\n"
        "      - name: shared-model\n        options:\n" + textwrap.indent(options, "          "),
        encoding="utf-8",
    )
    return root / "published"


def _gen(root: Path) -> int:
    return main(["gen", "--config", str(root / "metaobjects.config.yaml")])


def test_a_list_option_is_a_list_of_non_empty_strings() -> None:
    option = GeneratorOption("include", "stringList", description="d")
    assert option.coerce(["a::**", "b"]) == (("a::**", "b"), None)
    assert option.coerce("a::**")[1] is not None
    assert option.coerce(["a", ""])[1] is not None
    assert option.coerce(["a", 3])[1] is not None


def test_it_writes_the_artifact_and_the_manifest_pinned_by_the_artifact(tmp_path: Path) -> None:
    out = _project(
        tmp_path,
        "name: acme-common\ninclude: [acme::common::Address, acme::common::Audited]\nversion: 2.1.0\n",
    )
    assert _gen(tmp_path) == 0
    artifact = (out / "acme-common.metaobjects.json").read_bytes()
    manifest = json.loads((out / "metaobjects.pkg.json").read_text())
    assert manifest["name"] == "acme-common" and manifest["version"] == "2.1.0"
    assert manifest["artifact"] == "acme-common.metaobjects.json"
    assert manifest["integrity"] == "sha256-" + hashlib.sha256(artifact).hexdigest()
    assert manifest["nodes"] == ["acme::common::Address", "acme::common::Audited"]


def test_the_version_defaults_to_the_projects_pyproject(tmp_path: Path) -> None:
    out = _project(
        tmp_path, "name: acme-common\ninclude: [acme::common::Address]\n",
        pyproject='[project]\nname = "x"\nversion = "3.4.5"\n',
    )
    assert _gen(tmp_path) == 0
    assert json.loads((out / "metaobjects.pkg.json").read_text())["version"] == "3.4.5"


def test_no_version_anywhere_fails_the_run(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = _project(tmp_path, "name: acme-common\ninclude: [acme::common::Address]\n")
    assert _gen(tmp_path) == 1
    assert "no version available" in capsys.readouterr().err
    assert not out.exists()


def test_files_narrows_which_source_files_contribute(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # The ledger file declares requirement.* and the Customers object; with `files` limited to
    # the base file, a name only the other file holds selects nothing.
    _project(
        tmp_path,
        "name: acme-common\ninclude: [acme::common::Customer]\nversion: 1.0.0\n"
        "files: [metaobjects/meta.base.json]\n",
    )
    assert _gen(tmp_path) == 1
    assert "selected no nodes" in capsys.readouterr().err


def test_a_selection_that_is_not_closed_fails_naming_the_pair(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _project(tmp_path, "name: acme-common\ninclude: [acme::common::Secret]\nversion: 1.0.0\n")
    assert _gen(tmp_path) == 1
    assert "acme::common::Secret -> acme::common::Address" in capsys.readouterr().err


def test_name_and_include_are_required(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _project(tmp_path, "version: 1.0.0\n")
    assert _gen(tmp_path) == 1
    err = capsys.readouterr().err
    assert "needs the option 'name'" in err and "needs the option 'include'" in err


def test_an_unknown_option_is_refused(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _project(tmp_path, "name: a\ninclude: [acme::common::Address]\nversion: 1.0.0\nincludes: [x]\n")
    assert _gen(tmp_path) == 1
    err = capsys.readouterr().err
    assert "takes no option 'includes'" in err and "include" in err


def test_a_changed_pyproject_version_is_a_changed_input(tmp_path: Path) -> None:
    """ADR-0064: the file the version comes from is a declared extra input, so bumping it
    regenerates instead of skipping the run."""
    out = _project(
        tmp_path, "name: acme-common\ninclude: [acme::common::Address]\n",
        pyproject='[project]\nname = "x"\nversion = "1.0.0"\n',
    )
    assert _gen(tmp_path) == 0
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "x"\nversion = "1.0.1"\n', encoding="utf-8")
    assert _gen(tmp_path) == 0
    assert json.loads((out / "metaobjects.pkg.json").read_text())["version"] == "1.0.1"
