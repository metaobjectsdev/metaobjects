"""Stack vocabulary for the agent-context assembler.

These constants are the cross-port contract — they must match the TypeScript
reference (``server/typescript/packages/sdk/src/agent-context/types.ts``) exactly:
the SERVER/CLIENT orderings determine dedupe order, and the skill list + its
order is load-bearing for byte-identical output.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Server languages, in canonical dedupe order.
SERVER_LANGS: tuple[str, ...] = ("typescript", "java", "kotlin", "csharp", "python")

#: Client frameworks, in canonical dedupe order.
CLIENT_FRAMEWORKS: tuple[str, ...] = ("react", "tanstack", "angular")

#: Always-present token: schema migrations are TS-owned for every port (ADR-0015).
MIGRATION_TOKEN = "migration"

#: The five skills, in the exact emit order (matches the TS reference).
SKILL_NAMES: tuple[str, ...] = (
    "metaobjects-authoring",
    "metaobjects-codegen",
    "metaobjects-runtime-ui",
    "metaobjects-prompts",
    "metaobjects-verify",
)


@dataclass(frozen=True)
class Stack:
    """The resolved tech-stack of a consumer project.

    - ``servers`` — deduped, in :data:`SERVER_LANGS` order.
    - ``clients`` — deduped, in :data:`CLIENT_FRAMEWORKS` order.
    - ``tokens`` — ``servers ∪ clients ∪ {"migration"}``, the install-selection
      set used to choose which reference fragments to emit.
    """

    servers: tuple[str, ...]
    clients: tuple[str, ...]
    tokens: frozenset[str]
