"""Cross-port agent-context conformance — the BYTE-IDENTITY gate.

For each ``fixtures/agent-context-conformance/<stack>/`` corpus case, assemble the
consumer files against the repo-root ``agent-context/`` content tree and assert the
output is byte-identical to the committed ``expected/<path>`` goldens — same set of
paths AND same bytes per file. The goldens are produced by the TypeScript reference
assembler; passing this proves the Python port reproduces it exactly.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.agent_context import assemble, make_stack


def _repo_root() -> Path:
    """Walk up to the dir holding both ``fixtures/`` and ``agent-context/``."""
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        if (parent / "fixtures" / "agent-context-conformance").is_dir() and (
            parent / "agent-context"
        ).is_dir():
            return parent
    raise RuntimeError(
        "could not locate the repo root (fixtures/agent-context-conformance + "
        f"agent-context) walking up from {here}"
    )


_ROOT = _repo_root()
_CORPUS = _ROOT / "fixtures" / "agent-context-conformance"
_CONTENT_ROOT = _ROOT / "agent-context"

_STACKS = sorted(p.name for p in _CORPUS.iterdir() if (p / "stack.json").is_file())


def _collect_expected(expected_dir: Path) -> dict[str, bytes]:
    """Map every file under ``expected/`` to its raw bytes, keyed by rel path."""
    return {
        str(p.relative_to(expected_dir)): p.read_bytes()
        for p in sorted(expected_dir.rglob("*"))
        if p.is_file()
    }


@pytest.mark.parametrize("stack_name", _STACKS)
def test_agent_context_byte_identical(stack_name: str) -> None:
    case_dir = _CORPUS / stack_name
    spec = json.loads((case_dir / "stack.json").read_text(encoding="utf-8"))
    stack = make_stack(spec.get("servers", []), spec.get("clients", []))

    produced = {f.path: f.contents.encode("utf-8") for f in assemble(_CONTENT_ROOT, stack)}
    expected = _collect_expected(case_dir / "expected")

    assert set(produced) == set(expected), (
        f"[{stack_name}] path set mismatch:\n"
        f"  only produced: {sorted(set(produced) - set(expected))}\n"
        f"  only expected: {sorted(set(expected) - set(produced))}"
    )

    for path in sorted(expected):
        assert produced[path] == expected[path], (
            f"[{stack_name}] byte mismatch at {path}:\n"
            f"  produced ({len(produced[path])}B): {produced[path]!r}\n"
            f"  expected ({len(expected[path])}B): {expected[path]!r}"
        )


def test_all_four_stacks_present() -> None:
    assert set(_STACKS) == {
        "ts-react-tanstack",
        "java-react",
        "java-kotlin-react-tanstack",
        "python",
    }
