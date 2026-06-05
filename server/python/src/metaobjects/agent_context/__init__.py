"""Agent-context assembler — scaffold the slim MetaObjects Claude Code context.

Reproduces the TypeScript reference assembler (``server/typescript/packages/sdk/
src/agent-context/``) BYTE-FOR-BYTE: given the repo-root ``agent-context/``
content tree and a resolved :class:`Stack`, emit the consumer files
(``.metaobjects/AGENTS.md`` + ``CLAUDE.md`` and the five ``metaobjects-*`` Claude
Code skills, carrying only the reference fragments for the project's stack).

The assembly is pure given the content tree — the only computed content is the
two always-on template substitutions; every other file is a verbatim UTF-8 copy.
"""

from __future__ import annotations

from .assemble import (
    AssembledFile,
    assemble,
    make_stack,
)
from .content_root import resolve_agent_context_root
from .scaffold import (
    AGENT_CONTEXT_MANIFEST_PATH,
    Manifest,
    ScaffoldDecision,
    hash_contents,
    plan_scaffold,
)
from .types import (
    CLIENT_FRAMEWORKS,
    MIGRATION_TOKEN,
    SERVER_LANGS,
    SKILL_NAMES,
    Stack,
)

__all__ = [
    "AGENT_CONTEXT_MANIFEST_PATH",
    "AssembledFile",
    "CLIENT_FRAMEWORKS",
    "MIGRATION_TOKEN",
    "Manifest",
    "SERVER_LANGS",
    "SKILL_NAMES",
    "ScaffoldDecision",
    "Stack",
    "assemble",
    "hash_contents",
    "make_stack",
    "plan_scaffold",
    "resolve_agent_context_root",
]
