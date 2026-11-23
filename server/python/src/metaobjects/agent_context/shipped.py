"""The shipped agent files, copied out of the tree embedded in this package.

``shipped/`` is a committed copy of the repo-root ``agent-context-shipped/`` tree, which
TypeScript builds (``agent-context-shipped/README.md`` is the contract). Everything here is
the three steps that README gives a port: find the stack, pin the guide links to the
release tag, write each file at its path. No Node is involved.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from importlib import resources
from importlib.resources.abc import Traversable

#: The manifest shape this port understands.
SHIPPED_SCHEMA = 1
#: Canonical order of server languages and clients inside a stack id.
SERVER_LANGS = ("typescript", "java", "kotlin", "csharp", "python", "rust")
CLIENT_FRAMEWORKS = ("react", "tanstack", "angular")
#: The ref a prerelease or an unresolvable version keeps.
DOCS_DEFAULT_REF = "main"

_SERVER_ALIASES = {
    "node": "typescript", "nodejs": "typescript", "ts": "typescript",
    "c#": "csharp", "dotnet": "csharp", "py": "python", "rs": "rust",
}
_CLIENT_ALIASES = {"reactjs": "react", "react-query": "tanstack"}
_RELEASE_VERSION = re.compile(r"^\d+\.\d+\.\d+$")


class ShippedContextError(Exception):
    """The shipped tree cannot serve the request (unknown stack, unknown schema, bad flag)."""


@dataclass(frozen=True)
class ShippedTree:
    manifest: dict[str, object]
    root: Traversable

    def stack_entry(self, stack_id: str) -> dict[str, object] | None:
        for entry in self.manifest["stacks"]:  # type: ignore[attr-defined]
            if entry["id"] == stack_id:
                return entry  # type: ignore[no-any-return]
        return None

    def stack_ids(self) -> list[str]:
        return [str(e["id"]) for e in self.manifest["stacks"]]  # type: ignore[attr-defined]


def load_shipped() -> ShippedTree:
    """Read the embedded tree's manifest; refuse a schema this port does not know."""
    root = resources.files("metaobjects.agent_context") / "shipped"
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != SHIPPED_SCHEMA:
        raise ShippedContextError(
            f"agent-context: unknown shipped manifest schema {manifest.get('schema')!r} "
            f"(this metaobjects understands {SHIPPED_SCHEMA}); upgrade metaobjects"
        )
    return ShippedTree(manifest=manifest, root=root)


def docs_ref_for_version(version: str) -> str:
    """``v<version>`` for a release, ``main`` for a prerelease, ``0.0.0`` or non-version text."""
    v = version.strip()
    return f"v{v}" if _RELEASE_VERSION.match(v) and v != "0.0.0" else DOCS_DEFAULT_REF


def _canonical(raw: str, valid: Iterable[str], aliases: dict[str, str]) -> str | None:
    v = raw.strip().lower()
    return v if v in tuple(valid) else aliases.get(v)


def canonical_stack(servers: list[str], clients: list[str]) -> tuple[list[str], list[str]]:
    """Canonicalize ``--server``/``--client`` values; refuse one that names nothing known."""
    bad: list[str] = []
    out_servers: list[str] = []
    out_clients: list[str] = []
    for s in servers:
        c = _canonical(s, SERVER_LANGS, _SERVER_ALIASES)
        if c is None:
            bad.append(f"--server {s} (known: {', '.join(SERVER_LANGS)})")
        else:
            out_servers.append(c)
    for s in clients:
        c = _canonical(s, CLIENT_FRAMEWORKS, _CLIENT_ALIASES)
        if c is None:
            bad.append(f"--client {s} (known: {', '.join(CLIENT_FRAMEWORKS)})")
        else:
            out_clients.append(c)
    if bad:
        raise ShippedContextError("unknown stack value: " + "; ".join(bad))
    return out_servers, out_clients


def shipped_stack_id(servers: list[str], clients: list[str]) -> str:
    """Server languages then clients, each in canonical order, joined by ``-``."""
    return "-".join(
        [s for s in SERVER_LANGS if s in servers] + [c for c in CLIENT_FRAMEWORKS if c in clients]
    )


def materialize(
    tree: ShippedTree, servers: list[str], clients: list[str], docs_ref: str
) -> dict[str, str]:
    """The stack's files, ``{path: contents}``, with every guide link pinned to ``docs_ref``."""
    stack_id = shipped_stack_id(servers, clients)
    entry = tree.stack_entry(stack_id)
    if entry is None:
        raise ShippedContextError(
            f'no shipped agent files for the stack "{stack_id}" '
            f"(shipped: {', '.join(tree.stack_ids())})"
        )
    prefix = str(tree.manifest["docsLinkPrefix"])
    src = f"{prefix}{tree.manifest['docsRef']}/"
    dst = f"{prefix}{docs_ref}/"
    out: dict[str, str] = {}
    for f in entry["files"]:  # type: ignore[attr-defined]
        text = (tree.root / "files" / f["file"]).read_text(encoding="utf-8")
        out[f["path"]] = text.replace(src, dst)
    return out
