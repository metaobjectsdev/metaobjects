"""Subverb tests for `metaobjects verify` (ADR-0021 D2 fan-out).

`verify` unifies to explicit subverbs across ports:

  verify --codegen   regenerate-to-temp + diff vs committed --out (Python's
                     historical default; back-compat).
  verify --templates template/prompt {{field}} ↔ payload-VO drift (the render
                     verify() gate), resolving each template.* node's refs via a
                     filesystem provider rooted at --templates-root.
  verify --db        REJECTED in the Python port (exit 2): schema verify is the
                     migrate engine (ADR-0015), not this CLI.

A bare `verify` keeps the historical default = codegen (back-compat) and prints
a one-line note advertising the explicit subverbs. Combining flags runs each and
aggregates the exit code (non-zero if ANY drift).
"""

from __future__ import annotations

from pathlib import Path

from metaobjects.cli import main

FITNESS = (
    Path(__file__).parents[4]
    / "fixtures"
    / "persistence-conformance"
    / "canonical"
    / "meta.fitness.json"
)


def _meta_dir(tmp_path: Path) -> str:
    d = tmp_path / "meta"
    d.mkdir()
    (d / "meta.fitness.json").write_text(FITNESS.read_text())
    return str(d)


# ---------------------------------------------------------------------------
# Template fixture: a `template.output` (WelcomePage) over a payload VO
# (Welcome { name }) + a `pages/welcome.mustache`. The clean template references
# only {{name}}; the drift variant references {{missing}} (not on the VO).
# ---------------------------------------------------------------------------

_META_CLEAN = """\
{
  "metadata.root": {
    "package": "acme::ai",
    "children": [
      {
        "object.value": {
          "name": "Welcome",
          "children": [
            { "field.string": { "name": "name", "@required": true } }
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


def _templates_dir(tmp_path: Path, body: str) -> str:
    """Write a templates root with pages/welcome.mustache = ``body``."""
    root = tmp_path / "templates"
    (root / "pages").mkdir(parents=True)
    (root / "pages" / "welcome.mustache").write_text(body)
    return str(root)


# An email `template.output` (@kind=email) carries subject + html body part-refs
# (NO @textRef). Each part's mustache must be drift-checked against the payload VO,
# parity with a document output and template.prompt (#193).
_META_EMAIL = """\
{
  "metadata.root": {
    "package": "acme::ai",
    "children": [
      {
        "object.value": {
          "name": "Welcome",
          "children": [
            { "field.string": { "name": "name", "@required": true } }
          ]
        }
      },
      {
        "template.output": {
          "name": "WelcomeEmail",
          "@kind": "email",
          "@payloadRef": "Welcome",
          "@subjectRef": "emails/subject",
          "@htmlBodyRef": "emails/html"
        }
      }
    ]
  }
}
"""


def _email_templates_dir(tmp_path: Path, subject: str, html: str) -> str:
    """Write a templates root with the email subject + html body parts."""
    root = tmp_path / "email_templates"
    (root / "emails").mkdir(parents=True)
    (root / "emails" / "subject.mustache").write_text(subject)
    (root / "emails" / "html.mustache").write_text(html)
    return str(root)


def _meta_dir_with(tmp_path: Path, meta_json: str) -> str:
    d = tmp_path / "tmeta"
    d.mkdir()
    (d / "meta.json").write_text(meta_json)
    return str(d)


# --- 1. --codegen = the historical codegen-drift behavior -------------------


def test_codegen_in_sync_returns_zero(tmp_path: Path) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    assert main(["gen", meta_dir, "--out", str(out)]) == 0
    assert main(["verify", "--codegen", meta_dir, "--out", str(out)]) == 0


def test_codegen_detects_drift(tmp_path: Path) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    assert main(["gen", meta_dir, "--out", str(out)]) == 0
    target = out / "Program.py"
    target.write_text(target.read_text() + "\n# hand-edited drift\n")
    assert main(["verify", "--codegen", meta_dir, "--out", str(out)]) != 0


# --- 2. --templates = render-verify drift -----------------------------------


def test_templates_clean_returns_zero(tmp_path: Path) -> None:
    meta_dir = _meta_dir_with(tmp_path, _META_CLEAN)
    troot = _templates_dir(tmp_path, "Hello {{name}}")
    rc = main(["verify", "--templates", meta_dir, "--templates-root", troot])
    assert rc == 0


def test_templates_field_not_on_payload_is_drift(tmp_path: Path, capsys) -> None:
    meta_dir = _meta_dir_with(tmp_path, _META_CLEAN)
    troot = _templates_dir(tmp_path, "Hello {{missing}}")
    rc = main(["verify", "--templates", meta_dir, "--templates-root", troot])
    assert rc != 0
    err = capsys.readouterr().err
    # Names the offending field + the template.
    assert "missing" in err
    assert "WelcomePage" in err


def test_templates_unresolvable_ref_is_drift(tmp_path: Path) -> None:
    meta_dir = _meta_dir_with(tmp_path, _META_CLEAN)
    # Empty templates root → pages/welcome.mustache does not exist.
    troot = tmp_path / "empty_templates"
    troot.mkdir()
    rc = main(["verify", "--templates", meta_dir, "--templates-root", str(troot)])
    assert rc != 0


def test_templates_email_clean_returns_zero(tmp_path: Path) -> None:
    # An @kind=email output whose subject + html parts reference only payload
    # fields is clean (#193 — email parts drift-checked like a document body).
    meta_dir = _meta_dir_with(tmp_path, _META_EMAIL)
    troot = _email_templates_dir(tmp_path, "Hello {{name}}", "<p>Hi {{name}}</p>")
    rc = main(["verify", "--templates", meta_dir, "--templates-root", troot])
    assert rc == 0


def test_templates_email_body_drift_is_caught(tmp_path: Path, capsys) -> None:
    # A {{missing}} in the email HTML body part must be reported (#193): the
    # per-port bug was skipping @kind=email templates entirely.
    meta_dir = _meta_dir_with(tmp_path, _META_EMAIL)
    troot = _email_templates_dir(tmp_path, "Hello {{name}}", "<p>Hi {{missing}}</p>")
    rc = main(["verify", "--templates", meta_dir, "--templates-root", troot])
    assert rc != 0
    err = capsys.readouterr().err
    assert "missing" in err
    assert "WelcomeEmail" in err


# --- #230: template.prompt @requiredTags / @requiredSlots enforcement (parity w/ TS/Java/C#) ---

_META_PROMPT_TAGS = """\
{
  "metadata.root": {
    "package": "acme::ai",
    "children": [
      {
        "object.value": {
          "name": "Welcome",
          "children": [
            { "field.string": { "name": "name", "@required": true } }
          ]
        }
      },
      {
        "template.prompt": {
          "name": "TaggedPrompt",
          "@payloadRef": "Welcome",
          "@textRef": "pages/welcome",
          "@requiredTags": ["answer"]
        }
      }
    ]
  }
}
"""


def test_templates_prompt_required_tag_missing_is_drift(tmp_path: Path, capsys) -> None:
    # #230: a template.prompt @requiredTags whose rendered body omits the <answer> tag must FAIL
    # verify. Python previously passed required_slots/required_tags to render_verify NOWHERE, so it
    # enforced neither — a divergence from TS/Java/C#.
    meta_dir = _meta_dir_with(tmp_path, _META_PROMPT_TAGS)
    troot = _templates_dir(tmp_path, "Hello {{name}}")  # no <answer>…</answer> tag
    rc = main(["verify", "--templates", meta_dir, "--templates-root", troot])
    assert rc != 0
    err = capsys.readouterr().err
    assert "ERR_OUTPUT_TAG_MISSING" in err
    assert "answer" in err


def test_templates_prompt_required_tag_present_passes(tmp_path: Path) -> None:
    meta_dir = _meta_dir_with(tmp_path, _META_PROMPT_TAGS)
    troot = _templates_dir(tmp_path, "Hello {{name}} <answer>{{name}}</answer>")
    rc = main(["verify", "--templates", meta_dir, "--templates-root", troot])
    assert rc == 0


# --- 3. bare verify = codegen (back-compat) + the subverb note --------------


def test_bare_verify_is_codegen_backcompat(tmp_path: Path, capsys) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    assert main(["gen", meta_dir, "--out", str(out)]) == 0
    rc = main(["verify", meta_dir, "--out", str(out)])
    assert rc == 0
    note = capsys.readouterr().err + capsys.readouterr().out
    # A one-line note advertising the explicit subverbs is printed.
    assert "--codegen" in note or "--templates" in note


def test_bare_verify_detects_codegen_drift(tmp_path: Path) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    assert main(["gen", meta_dir, "--out", str(out)]) == 0
    (out / "Program.py").unlink()
    assert main(["verify", meta_dir, "--out", str(out)]) != 0


# --- 4. --db is rejected in the Python port (exit 2) ------------------------


def test_db_is_rejected_exit_2(tmp_path: Path, capsys) -> None:
    meta_dir = _meta_dir(tmp_path)
    rc = main(["verify", "--db", "postgres://x", meta_dir])
    assert rc == 2
    err = capsys.readouterr().err
    assert "not supported" in err.lower()
    assert "migrate" in err.lower()


# --- 5. invalid flag → exit 2 -----------------------------------------------


def test_invalid_flag_exit_2() -> None:
    import pytest

    with pytest.raises(SystemExit) as exc:
        main(["verify", "--bogus", "x"])
    assert exc.value.code == 2


# --- aggregation: combining --codegen + --templates -------------------------


def test_combined_codegen_and_templates_aggregates_exit(tmp_path: Path) -> None:
    meta_dir = _meta_dir_with(tmp_path, _META_CLEAN)
    out = tmp_path / "out"
    assert main(["gen", meta_dir, "--out", str(out)]) == 0
    troot = _templates_dir(tmp_path, "Hello {{missing}}")
    # codegen clean, templates drift → aggregate non-zero.
    rc = main(
        [
            "verify",
            "--codegen",
            "--templates",
            meta_dir,
            "--out",
            str(out),
            "--templates-root",
            troot,
        ]
    )
    assert rc != 0
