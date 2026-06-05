"""The pure agent-context assembler.

Port of ``server/typescript/packages/sdk/src/agent-context/assemble.ts``. Given
the content tree and a resolved :class:`Stack`, produce the ``(path, contents)``
files the consumer project receives — byte-identical to the TS reference.

BYTE-IDENTITY: every file but the two always-on documents is a verbatim copy.
We read with ``Path.read_bytes().decode("utf-8")`` (NOT ``open(... )`` text mode)
so Python never translates newlines, and emit ``str`` whose UTF-8 encoding is the
original bytes. The only computed content is the two template substitutions.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from .types import (
    CLIENT_FRAMEWORKS,
    MIGRATION_TOKEN,
    SERVER_LANGS,
    SKILL_NAMES,
    Stack,
)

#: ``{{key}}`` template-variable pattern (word chars only, matching the TS regex).
_TEMPLATE_VAR = re.compile(r"\{\{(\w+)\}\}")


@dataclass(frozen=True)
class AssembledFile:
    """A file the assembler emits, ``path`` relative to the consumer project root."""

    path: str
    contents: str


def make_stack(servers: list[str], clients: list[str]) -> Stack:
    """Build a :class:`Stack`: dedupe + canonical-order the inputs, derive tokens.

    Unknown entries are dropped (the canonical orderings are the allow-list); the
    resulting orderings are exactly :data:`SERVER_LANGS` / :data:`CLIENT_FRAMEWORKS`
    filtered to the requested set, matching the TS ``makeStack``.
    """
    s = tuple(x for x in SERVER_LANGS if x in servers)
    c = tuple(x for x in CLIENT_FRAMEWORKS if x in clients)
    tokens = frozenset({*s, *c, MIGRATION_TOKEN})
    return Stack(servers=s, clients=c, tokens=tokens)


def _read_text(path: Path) -> str:
    """Read a file as UTF-8 with NO newline translation (byte-faithful)."""
    return path.read_bytes().decode("utf-8")


def _read_server_meta(content_root: Path, server: str) -> dict[str, str] | None:
    """Load ``servers/<server>.meta.json``, or ``None`` if absent."""
    p = content_root / "servers" / f"{server}.meta.json"
    if not p.exists():
        return None
    return json.loads(_read_text(p))


def _stack_line(content_root: Path, stack: Stack) -> tuple[str, str]:
    """Compute ``(stackLine, codegenCommand)`` for the always-on template.

    ``codegenCommand`` is the FIRST server's ``codegenCommand`` (or ``"meta gen"``
    if there is no primary server, or its meta file is absent).
    """
    primary = stack.servers[0] if stack.servers else None
    meta = _read_server_meta(content_root, primary) if primary else None
    server_part = ", ".join(stack.servers) + " server" if stack.servers else "no server"
    client_part = ", ".join(stack.clients) + " client" if stack.clients else "no client"
    line = f"Stack: {server_part}, {client_part}; migrations are TS."
    codegen_command = meta["codegenCommand"] if meta else "meta gen"
    return line, codegen_command


def _apply_template(tpl: str, variables: dict[str, str]) -> str:
    """Replace every ``{{key}}``; raise on an unknown key (matches TS)."""

    def repl(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in variables:
            raise ValueError(f"agent-context: unknown template variable {{{{{key}}}}}")
        return variables[key]

    return _TEMPLATE_VAR.sub(repl, tpl)


def assemble(content_root: Path, stack: Stack) -> list[AssembledFile]:
    """Assemble the consumer files for a resolved stack. Pure given the content tree.

    Output is sorted by path ascending — the stable order the conformance gate and
    the TS reference both produce.
    """
    out: list[AssembledFile] = []

    # 1. Always-on (AGENTS.md + CLAUDE.md, identical contents).
    tpl = _read_text(content_root / "templates" / "always-on.md.mustache")
    line, codegen_command = _stack_line(content_root, stack)
    always_on = _apply_template(
        tpl, {"stackLine": line, "codegenCommand": codegen_command}
    )
    out.append(AssembledFile(".metaobjects/AGENTS.md", always_on))
    out.append(AssembledFile(".metaobjects/CLAUDE.md", always_on))

    # 2. Skills: body + only the references whose token is in the stack.
    for skill in SKILL_NAMES:
        skill_dir = content_root / "skills" / skill
        body = _read_text(skill_dir / "SKILL.md")
        out.append(AssembledFile(f".claude/skills/{skill}/SKILL.md", body))

        ref_dir = skill_dir / "references"
        if ref_dir.is_dir():
            tokens = sorted(
                p.stem
                for p in ref_dir.iterdir()
                if p.is_file() and p.suffix == ".md" and p.stem in stack.tokens
            )
            for token in tokens:
                out.append(
                    AssembledFile(
                        f".claude/skills/{skill}/references/{token}.md",
                        _read_text(ref_dir / f"{token}.md"),
                    )
                )

    # Stable order: by path.
    out.sort(key=lambda f: f.path)
    return out
