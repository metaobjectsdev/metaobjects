"""`--templates` must actually reach the `render-helper` generator.

Before 1.0.5 it did not. ``GeneratorEntry.factory`` took no arguments and
``_render_helper_default`` hardcoded ``template_root="templates"``, so the CLI's
``--templates`` flag — which the help text has always advertised — reached the
template-spec pass and nothing else. Selecting ``render-helper`` resolved template refs
from a directory the user had never named, and in a project whose templates live
anywhere else (this repo's own estate keeps them in ``prompts/``) it resolved them from
a directory that does not exist.

That made the generator effectively unreachable from the CLI: the only way to give it a
real root was the factory-array config path, which the ``metaobjects`` console script
does not expose. It was registered, listed by ``--list``, selectable by name, and could
not be pointed at your templates.

The test that would have caught it has to run the generator against a root the test
CHOSE, and fail when it reads some other one — asserting only that `gen` exits 0 would
have passed throughout, because a missing template surfaces as a drift-gate error only
once the generator looks.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from metaobjects.cli import main

FIXTURE = (
    Path(__file__).parents[4]
    / "fixtures"
    / "persistence-conformance"
    / "canonical"
    / "meta.fitness.json"
)

# The fixture's one template: `template.prompt coachNote`, `@textRef: fitness/coach-note`.
TEXT_REF = "fitness/coach-note"


def _project(tmp_path: Path, templates_dirname: str) -> tuple[str, str, Path]:
    """A project whose template body lives under *templates_dirname*, not "templates"."""
    meta = tmp_path / "meta"
    meta.mkdir()
    (meta / "meta.fitness.json").write_text(FIXTURE.read_text())

    root = tmp_path / templates_dirname / "fitness"
    root.mkdir(parents=True)
    # The body's slots must match the payload VO (`ProgramBrief`: title, weekCount,
    # weekLabels), or the build-time drift gate refuses it for a reason other than the
    # one under test — ERR_VAR_NOT_ON_PAYLOAD rather than an unresolved ref.
    (root / "coach-note.mustache").write_text("Program: {{title}}\n")

    return str(meta), str(tmp_path / templates_dirname), tmp_path / "out"


def test_render_helper_resolves_templates_under_the_dir_that_was_passed(
    tmp_path: Path,
) -> None:
    meta_dir, templates_dir, out = _project(tmp_path, "prompts")
    rc = main([
        "gen", meta_dir, "--out", str(out),
        "--generators", "entity,render-helper",
        "--templates", templates_dir,
    ])
    assert rc == 0, "gen failed with the template root it was given"
    helpers = list(out.rglob("*render*.py"))
    assert helpers, f"render-helper emitted nothing into {out}"


def test_a_template_root_without_the_body_fails_rather_than_silently_emitting(
    tmp_path: Path, capsys: pytest.CaptureFixture[str],
) -> None:
    """The control: the assertion above must be able to fail.

    Point `--templates` at an empty directory and the run must NOT succeed. Without
    this, a `render-helper` that quietly emitted nothing — or that read some other
    directory — would pass the test above just as well.
    """
    meta_dir, _templates_dir, out = _project(tmp_path, "prompts")
    empty = tmp_path / "no-templates"
    empty.mkdir()
    rc = main([
        "gen", meta_dir, "--out", str(out),
        "--generators", "entity,render-helper",
        "--templates", str(empty),
    ])
    assert rc != 0, (
        "gen succeeded with a template root holding no body — the drift gate did not "
        f"look, so the flag is not reaching the generator. stdout: {capsys.readouterr().out}"
    )


def test_the_old_hardcoded_default_is_not_what_gets_read(tmp_path: Path) -> None:
    """Name the specific regression: a `templates/` dir must not win over the flag.

    Scaffold BOTH `templates/` (holding a body that would satisfy the gate) and the
    real root passed on the flag (holding a body too). Then delete the flagged one's
    body: if the run still passes, the generator read `templates/` — the hardcoded
    default — and the flag is decorative again.
    """
    meta_dir, flagged, out = _project(tmp_path, "prompts")
    decoy = tmp_path / "templates" / "fitness"
    decoy.mkdir(parents=True)
    (decoy / "coach-note.mustache").write_text("Program: {{title}}\n")

    (Path(flagged) / "fitness" / "coach-note.mustache").unlink()

    rc = main([
        "gen", meta_dir, "--out", str(out),
        "--generators", "entity,render-helper",
        "--templates", flagged,
    ])
    assert rc != 0, "the run read templates/ instead of the --templates dir"


# --- the DEFAULT, when no --templates is passed ---------------------------------

def test_the_default_prefers_prompts_when_it_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`prompts/` wins over `templates/` — the Node CLI's name, which this port now shares.

    Both directories exist and only `prompts/` holds a usable body, so a run that
    succeeds proves the default looked there. Before 1.0.5 this port hardcoded
    `templates`, so a project following the Node CLI's layout had a `gen` looking
    somewhere its bodies were not.
    """
    meta_dir, prompts, out = _project(tmp_path, "prompts")
    decoy = tmp_path / "templates" / "fitness"
    decoy.mkdir(parents=True)
    (decoy / "coach-note.mustache").write_text("Program: {{nope}}\n")  # would FAIL the gate

    monkeypatch.chdir(tmp_path)
    rc = main([
        "gen", meta_dir, "--out", str(out),
        "--generators", "entity,render-helper",
    ])
    assert rc == 0, "the default did not resolve prompts/ (or read templates/ instead)"


def test_the_default_still_falls_back_to_templates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A project with only `templates/` behaves exactly as it did — no flip, a fallback.

    This is the half that makes the change safe to ship in a PATCH: nothing moves for
    an existing project, because `prompts/` has to EXIST before it wins.
    """
    meta_dir, _templates, out = _project(tmp_path, "templates")
    assert not (tmp_path / "prompts").exists()

    monkeypatch.chdir(tmp_path)
    rc = main([
        "gen", meta_dir, "--out", str(out),
        "--generators", "entity,render-helper",
    ])
    assert rc == 0, "the fallback to templates/ broke a project that had only that"


def test_an_explicit_flag_still_wins_over_both(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The default is a default: naming a root explicitly overrides the probe."""
    meta_dir, _prompts, out = _project(tmp_path, "prompts")
    elsewhere = tmp_path / "bodies" / "fitness"
    elsewhere.mkdir(parents=True)
    (elsewhere / "coach-note.mustache").write_text("Program: {{title}}\n")
    # Break `prompts/` so a run that succeeds can only have read `bodies/`.
    (tmp_path / "prompts" / "fitness" / "coach-note.mustache").unlink()

    monkeypatch.chdir(tmp_path)
    rc = main([
        "gen", meta_dir, "--out", str(out),
        "--generators", "entity,render-helper",
        "--templates", str(tmp_path / "bodies"),
    ])
    assert rc == 0, "an explicit --templates lost to the prompts/ probe"


# --- gen and verify --codegen must agree about the root -------------------------

def test_verify_codegen_regenerates_render_helper_against_the_same_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`verify --codegen` must find the committed helpers clean, not stale.

    This is the failure the one-resolver rule exists to prevent, and it is worth a test
    because it is invisible to any assertion about `gen` alone: `gen` writes a helper
    from `prompts/`, `verify --codegen` regenerates from somewhere else, the two differ,
    and verify reports drift on a tree `gen` had just produced — with a remedy that
    loops, since re-running `gen` cannot fix a disagreement about where the bodies are.
    """
    meta_dir, prompts, out = _project(tmp_path, "prompts")
    monkeypatch.chdir(tmp_path)

    assert main([
        "gen", meta_dir, "--out", str(out),
        "--generators", "entity,render-helper", "--templates", prompts,
    ]) == 0
    # Not vacuous: there has to BE a committed helper for verify to call stale.
    assert list(out.rglob("*render*.py")), "gen emitted no render helper to check"

    # `verify` spells the directory --prompts (F101); --templates is its gate subverb.
    assert main([
        "verify", "--codegen", meta_dir, "--out", str(out),
        "--generators", "entity,render-helper", "--prompts", prompts,
    ]) == 0, "verify --codegen called the freshly generated helpers stale"


def test_verify_codegen_agrees_with_gen_on_the_DEFAULT_root_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The same agreement when NEITHER command is given a root.

    A default on one command and not the other is the same disagreement wearing a
    different hat, so the defaulted path needs its own assertion — passing `--templates`
    on both would prove only that an explicit flag is honoured twice.
    """
    meta_dir, _prompts, out = _project(tmp_path, "prompts")
    monkeypatch.chdir(tmp_path)

    assert main(["gen", meta_dir, "--out", str(out),
                 "--generators", "entity,render-helper"]) == 0
    assert list(out.rglob("*render*.py")), "gen emitted no render helper to check"
    assert main(["verify", "--codegen", meta_dir, "--out", str(out),
                 "--generators", "entity,render-helper"]) == 0, (
        "gen and verify --codegen resolved different default roots")
