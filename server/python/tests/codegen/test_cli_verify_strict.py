"""Issue #96 — `metaobjects verify` is strict-by-default (ADR-0023 cross-port).

Under strict load an authored own ``@attr`` that no provider declares is an
``ERR_UNKNOWN_ATTR``. Java's Maven verify goal already forces strict; this brings
the Python (and TS) CLI verify in line: verify FAILS on an undeclared attr unless
``--lax`` is passed. ``gen`` keeps loading lax (only verify defaults strict).
"""

from __future__ import annotations

from pathlib import Path

from metaobjects.cli import main

# Shared cross-port fixture (also asserted by the TS CLI verify-strict test):
# a registered field.string carrying one undeclared own @attr.
_FIXTURE = (
    Path(__file__).parents[4]
    / "fixtures"
    / "verify-strict-conformance"
    / "unregistered-attr"
    / "input"
    / "meta.users.json"
)
_MADE_UP = _FIXTURE.read_text()

_CLEAN = """\
{
  "metadata.root": {
    "package": "acme::users",
    "children": [
      {
        "object.entity": {
          "name": "Account",
          "children": [
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "email", "@description": "the email" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ]
        }
      }
    ]
  }
}
"""


def _meta_dir(tmp_path: Path, body: str) -> str:
    d = tmp_path / "meta"
    d.mkdir()
    (d / "meta.json").write_text(body)
    return str(d)


# --- verify --codegen ------------------------------------------------------


def test_verify_codegen_fails_on_undeclared_attr_by_default(
    tmp_path: Path, capsys
) -> None:
    meta_dir = _meta_dir(tmp_path, _MADE_UP)
    out = tmp_path / "out"
    rc = main(["verify", "--codegen", meta_dir, "--out", str(out)])
    assert rc != 0
    err = capsys.readouterr().err
    assert "ERR_UNKNOWN_ATTR" in err
    # Actionable hint: register a provider / attr.properties bag / --lax.
    assert "--lax" in err
    assert "attr.properties" in err


def test_verify_codegen_passes_with_lax(tmp_path: Path) -> None:
    meta_dir = _meta_dir(tmp_path, _MADE_UP)
    out = tmp_path / "out"
    # Lax load tolerates the undeclared attr; gen-to-temp + diff (vs --out) is
    # the codegen drift result, NOT a load failure. First gen (already lax),
    # then verify --lax against the committed output.
    assert main(["gen", meta_dir, "--out", str(out)]) == 0
    assert main(["verify", "--lax", "--codegen", meta_dir, "--out", str(out)]) == 0


# --- verify --templates ----------------------------------------------------

_TEMPLATE_META = """\
{
  "metadata.root": {
    "package": "acme::ai",
    "children": [
      {
        "object.value": {
          "name": "Welcome",
          "children": [
            { "field.string": { "name": "name", "@madeUpAttr": "nope" } }
          ]
        }
      },
      {
        "template.output": {
          "name": "WelcomePage",
          "@kind": "document",
          "@payloadRef": "Welcome",
          "@textRef": "pages/welcome",
          "@format": "html"
        }
      }
    ]
  }
}
"""


def test_verify_templates_fails_on_undeclared_attr_by_default(
    tmp_path: Path, capsys
) -> None:
    meta_dir = _meta_dir(tmp_path, _TEMPLATE_META)
    troot = tmp_path / "templates"
    (troot / "pages").mkdir(parents=True)
    (troot / "pages" / "welcome.mustache").write_text("Hello {{name}}")
    rc = main(["verify", "--templates", meta_dir, "--templates-root", str(troot)])
    assert rc != 0
    err = capsys.readouterr().err
    assert "ERR_UNKNOWN_ATTR" in err


# --- gen stays lax (only verify defaults strict) ---------------------------


def test_gen_stays_lax_by_default(tmp_path: Path) -> None:
    meta_dir = _meta_dir(tmp_path, _MADE_UP)
    out = tmp_path / "out"
    # gen tolerates the undeclared attr (no strict default for gen).
    assert main(["gen", meta_dir, "--out", str(out)]) == 0


def test_verify_clean_metadata_passes_under_strict(tmp_path: Path) -> None:
    meta_dir = _meta_dir(tmp_path, _CLEAN)
    out = tmp_path / "out"
    assert main(["gen", meta_dir, "--out", str(out)]) == 0
    assert main(["verify", "--codegen", meta_dir, "--out", str(out)]) == 0
