"""The layout ratchet (ADR-0063): generator source never types layout; the writer does.

Three parts:
  1. the analyzer's own cases: layout it must catch, and writer-based code it must pass;
  2. the scope rule: which files are generator source, by rule, not by list;
  3. the ratchet over the real package: every file with hand-typed layout is on the
     allowlist with a reason, every allowlisted file still needs its entry, and the
     allowlist only shrinks.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from tests.codegen.layout_ratchet.analyze import analyze_source, is_generator_source

CODEGEN = Path(__file__).parents[2] / "src" / "metaobjects" / "codegen"
REPO = Path(__file__).parents[4]
ALLOWLIST_PATH = Path(__file__).parent / "layout_ratchet" / "allowlist.json"
ALLOWLIST_REL = ALLOWLIST_PATH.relative_to(REPO).as_posix()


def kinds(source: str) -> list[str]:
    return sorted(f.kind for f in analyze_source(source))


# ── 1. the analyzer ──────────────────────────────────────────────────────────────────

CAUGHT = [
    ("a newline escape in a string", 's = "a\\nb"', ["newline-literal"]),
    ("a carriage return", 's = "a\\r"', ["newline-literal"]),
    ("a line break inside a triple-quoted string", 's = """a\nb"""', ["newline-literal"]),
    ("a line break in an f-string part", 's = f"{a}\\n{b}"', ["newline-literal"]),
    ("a string that starts with four spaces", 'rows.append("    x = 1")', ["indent-literal"]),
    ("an f-string that starts with an indent", 'rows.append(f"    {name}: int")', ["indent-literal"]),
    ("a string that starts with a tab", 'rows.append("\\tx")', ["indent-literal"]),
    ("a join on a newline", 'out = "\\n".join(rows)', ["newline-join", "newline-literal"]),
    ("a join on a comma-newline", 'out = ",\\n".join(rows)', ["newline-join", "newline-literal"]),
    ("an indentation repeat", 'pad = "    " * depth', ["indent-literal", "indent-repeat"]),
    ("a single-space repeat", 'pad = " " * (depth * 2)', ["indent-repeat"]),
]


@pytest.mark.parametrize(("source", "expected"), [c[1:] for c in CAUGHT], ids=[c[0] for c in CAUGHT])
def test_the_analyzer_catches_hand_typed_layout(source: str, expected: list[str]) -> None:
    assert kinds(source) == sorted(expected)


def test_a_newline_hidden_behind_a_constant_is_caught_where_it_is_used() -> None:
    found = analyze_source('NL = "\\n"\nout = NL.join(lines)\n')
    assert [(f.kind, f.line) for f in found] == [("newline-literal", 1), ("newline-join", 2)]


def test_the_constant_may_be_built_from_other_constants() -> None:
    src = 'NL = "\\n"\nSEP = "," + NL\nSEP.join(rows)\n'
    assert [f.line for f in analyze_source(src) if f.kind == "newline-join"] == [3]


def test_an_indent_unit_hidden_behind_a_constant_is_caught_at_the_repeat() -> None:
    assert kinds('UNIT = " "\npad = UNIT * 4\n') == ["indent-repeat"]


def test_findings_carry_the_line_and_column_of_the_node() -> None:
    (f,) = analyze_source('a = 1\ns = "x\\n"\n')
    assert (f.line, f.column) == (2, 5)


PASSED = [
    ("a generator written on PyWriter", 'w = PyWriter()\nw.open("class A:")\nw.line("x = 1")\nw.dedent()\n'),
    ("a docstring", 'def f():\n    """Line one.\n\n    Line two."""\n'),
    ("a search pattern", 'parts = text.split("\\n")\nif s.startswith("    "): pass\n'),
    ("a comparison", 'if ch == "\\n": pass\nif "\\n" in s: pass\n'),
    ("a writer snippet", 'w.text("""\n    a = 1\n    b = 2\n""")\n'),
    ("a join on a comma", 'out = ", ".join(names)\n'),
    ("a space repeat that is not layout-typed", 'x = [0] * 4\ny = "ab" * 2\n'),
    ("a comment", "# a\\n b\n    # not code\nx = 1\n"),
]


@pytest.mark.parametrize("source", [p[1] for p in PASSED], ids=[p[0] for p in PASSED])
def test_the_analyzer_passes_code_that_leaves_layout_to_the_writer(source: str) -> None:
    assert analyze_source(source) == []


# ── 2. the scope rule ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("path", "scanned"),
    [
        ("generators/router_generator.py", True),
        ("runtime/api_docs_renderer.py", True),
        ("constants.py", True),
        ("writer/code_writer.py", False),
        ("writer/py_writer.py", False),
        ("__pycache__/x.py", False),
        ("metaobjects-config.schema.json", False),
        ("KNOWN_GAPS.md", False),
    ],
)
def test_scope_by_rule(path: str, scanned: bool) -> None:
    assert is_generator_source(Path(path)) is scanned


# ── 3. the ratchet over the real package ─────────────────────────────────────────────

ALLOWLIST = json.loads(ALLOWLIST_PATH.read_text(encoding="utf-8"))
ENTRIES = {**ALLOWLIST["unconverted"], **ALLOWLIST["exempt"]}

SCANNED = sorted(
    p.relative_to(CODEGEN).as_posix()
    for p in CODEGEN.rglob("*.py")
    if is_generator_source(p.relative_to(CODEGEN))
)
FINDINGS = {f: analyze_source((CODEGEN / f).read_text(encoding="utf-8"), f) for f in SCANNED}


def test_it_reads_the_generators() -> None:
    assert any(f.startswith("generators/") for f in SCANNED)
    assert any(f.startswith("runtime/") for f in SCANNED)


def test_no_generator_source_types_layout_unless_its_file_is_allowlisted() -> None:
    offenders = [
        "\n".join([f, *(f"  {x.line}:{x.column} {x.kind} {x.excerpt}" for x in found)])
        for f, found in FINDINGS.items()
        if found and f not in ENTRIES
    ]
    assert offenders == [], (
        "Write these lines through PyWriter (codegen/writer/) instead of typing line breaks "
        "or indentation. A file is never added to the allowlist: it only shrinks."
    )


def test_every_allowlisted_file_still_needs_its_entry() -> None:
    stale = [f for f in ENTRIES if not FINDINGS.get(f)]
    assert stale == [], "these files no longer type layout (or no longer exist): remove their entries"


def test_every_allowlisted_path_is_generator_source_that_exists() -> None:
    for f in ENTRIES:
        assert is_generator_source(Path(f)), f"{f} is not in the ratchet's scope"
        assert (CODEGEN / f).exists(), f"{f} does not exist"


def test_every_entry_carries_a_written_reason() -> None:
    for f, reason in ENTRIES.items():
        assert len(reason) > 40, f"{f} needs a reason"


def test_a_file_is_either_unconverted_or_exempt_never_both_and_each_list_is_sorted() -> None:
    assert [f for f in ALLOWLIST["unconverted"] if f in ALLOWLIST["exempt"]] == []
    for lst in (ALLOWLIST["unconverted"], ALLOWLIST["exempt"]):
        assert list(lst) == sorted(lst)


def growth(before: dict, now: dict) -> list[str]:
    """How ``now`` grew relative to ``before``: new entries, and unconverted files relabelled exempt."""
    had = set(before["unconverted"]) | set(before.get("exempt", {}))
    return [f"added {f}" for f in {**now["unconverted"], **now["exempt"]} if f not in had] + [
        f"relabelled {f} as exempt" for f in now["exempt"] if f in before["unconverted"]
    ]


def test_growth_is_an_added_entry_or_an_unconverted_file_relabelled_exempt() -> None:
    before = {"unconverted": {"a.py": "r", "b.py": "r"}, "exempt": {"c.py": "r"}}
    assert growth(before, {"unconverted": {"a.py": "r"}, "exempt": {}}) == []
    assert growth(before, {"unconverted": {"a.py": "r", "d.py": "r"}, "exempt": {"c.py": "r"}}) == ["added d.py"]
    assert growth(before, {"unconverted": {"a.py": "r"}, "exempt": {"b.py": "r", "c.py": "r"}}) == [
        "relabelled b.py as exempt"
    ]


def _git(*args: str) -> str | None:
    r = subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def _merge_base_allowlists() -> list[tuple[str, dict]] | None:
    """The allowlist as it stood at the merge base of HEAD with each integration branch;
    ``None`` when git or those refs are unavailable (an export or a shallow clone)."""
    refs = _git(
        "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/main", "refs/remotes/origin/release/"
    )
    if not refs:
        return None
    out: list[tuple[str, dict]] = []
    reachable = False
    for ref in refs.split():
        base = _git("merge-base", "HEAD", ref)
        if base is None:
            continue
        reachable = True
        text = _git("show", f"{base}:{ALLOWLIST_REL}")
        if text is not None:
            out.append((ref, json.loads(text)))
    return out if reachable else None


def test_the_allowlist_only_shrinks() -> None:
    bases = _merge_base_allowlists()
    if bases is None:
        pytest.skip("no integration branch to compare the allowlist with")
    for ref, lst in bases:
        assert growth(lst, ALLOWLIST) == [], (
            f"the allowlist grew since the merge base with {ref}; convert the file to the writer instead"
        )
