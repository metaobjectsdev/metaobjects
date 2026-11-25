"""``metaobjects agent-docs``: write the shipped agent files into a project, with no Node.

Mirrors ``meta agent-docs`` for the flags a Python project uses: the stack comes from
``--server``/``--client``, else the stack the last run recorded in the sidecar manifest,
else ``python``. A re-run writes nothing for a file that is already right, parks fresh
text at ``<path>.new`` beside a hand-edited file, deletes only orphans it wrote and nobody
touched, and rewrites the manifest only when its text changed.
"""

from __future__ import annotations

import json
from pathlib import Path

from metaobjects.config.neutral_config import chose_migrate_dialect

from .scaffold import (
    AGENT_CONTEXT_MANIFEST_PATH,
    Manifest,
    installed_metaobjects_version,
    plan_scaffold,
)
from .shipped import (
    ShippedContextError,
    canonical_stack,
    docs_ref_for_version,
    load_shipped,
    materialize,
)

#: Server language of a project that names none and has no earlier manifest.
DEFAULT_SERVER = "python"
ROOT_IMPORT_LINE = "@.metaobjects/AGENTS.md"
ROOT_IMPORT_BLOCK = (
    "Read `.metaobjects/AGENTS.md` before changing this project's metadata, generated code "
    f"or schema.\n{ROOT_IMPORT_LINE}\n"
)
_NEW_ROOT_BODY = f"# Project memory\n\n{ROOT_IMPORT_BLOCK}"


def _read(root: Path, rel: str) -> str | None:
    p = root / rel
    if not p.is_file():
        return None
    with p.open(encoding="utf-8", newline="") as fh:  # newline="": compare the bytes on disk
        return fh.read()


def _write(root: Path, rel: str, text: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(text.encode("utf-8"))


def _prior_manifest(root: Path) -> Manifest | None:
    text = _read(root, AGENT_CONTEXT_MANIFEST_PATH)
    if text is None:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        return None
    return Manifest.from_json(data) if isinstance(data, dict) else None


def _wire_root(root: Path, created: list[str], notes: list[str], refresh: bool) -> None:
    claude, agents = root / "CLAUDE.md", root / "AGENTS.md"
    if not claude.exists() and not agents.exists():
        for name in ("AGENTS.md", "CLAUDE.md"):
            _write(root, name, _NEW_ROOT_BODY)
            created.append(f"{name} (created with MetaObjects @import)")
        return
    if claude.exists() and not agents.exists():
        if not refresh:
            _write(root, "AGENTS.md", _NEW_ROOT_BODY)
            created.append("AGENTS.md (created with MetaObjects @import)")
        else:
            notes.append(
                "no root AGENTS.md: assistants other than Claude Code will not load "
                ".metaobjects/AGENTS.md; add a root AGENTS.md containing @.metaobjects/AGENTS.md"
            )
    for name in ("CLAUDE.md", "AGENTS.md"):
        if not (root / name).exists():
            continue
        body = _read(root, name) or ""
        if ROOT_IMPORT_LINE in body:
            continue
        _write(root, name, body.rstrip("\n") + "\n\n" + ROOT_IMPORT_BLOCK)
        notes.append(f"wired {ROOT_IMPORT_LINE} into {name} so the MetaObjects context loads")


def run_agent_docs(
    *,
    servers: list[str],
    clients: list[str],
    out: Path,
    wire_root: bool = True,
    version: str | None = None,
) -> tuple[list[str], list[str]]:
    """Write the stack's files under ``out``; return ``(created paths, notes)``.

    Raises :class:`ShippedContextError` for an unknown stack value or stack.
    """
    version = installed_metaobjects_version() if version is None else version
    servers, clients = canonical_stack(servers, clients)
    prior = _prior_manifest(out)
    if not servers and not clients:
        # No flags: reuse the recorded stack, so a refresh keeps it without repeating them.
        if prior is not None and (prior.servers or prior.clients):
            servers, clients = list(prior.servers), list(prior.clients)
        else:
            servers = [DEFAULT_SERVER]
    tree = load_shipped()
    shipped_skills = str(tree.manifest["skillsDir"])
    if prior is not None and prior.skills_dir not in (None, shipped_skills):
        # The shipped files install under the default skills directory only; writing them
        # there would prune the project's own copies and lose its choice.
        raise ShippedContextError(
            f"agent-context: this project keeps its skills under {prior.skills_dir!r} "
            f"(meta init --skills-dir); metaobjects agent-docs writes only {shipped_skills!r}. "
            f"Refresh with: npx meta agent-docs --skills-dir {prior.skills_dir}"
        )
    # Read from the project config on every run, as TypeScript does at init and refresh.
    migration = chose_migrate_dialect(out)
    assembled = materialize(tree, servers, clients, docs_ref_for_version(version), migration)
    decision = plan_scaffold(
        assembled=assembled,
        prior=prior,
        read_current=lambda p: _read(out, p),
        generated_by=version,
        servers=servers,
        clients=clients,
    )
    created: list[str] = []
    notes: list[str] = []
    for path, text in decision.writes:
        _write(out, path, text)
        created.append(path)
    for path, text in decision.conflicts:
        _write(out, path + ".new", text)
        created.append(path + ".new")
        notes.append(f"{path} appears hand-edited; refreshed version written to {path}.new")
    assert decision.manifest is not None
    manifest_text = json.dumps(decision.manifest.to_json(), indent=2, ensure_ascii=False) + "\n"
    if _read(out, AGENT_CONTEXT_MANIFEST_PATH) != manifest_text:
        _write(out, AGENT_CONTEXT_MANIFEST_PATH, manifest_text)
        created.append(AGENT_CONTEXT_MANIFEST_PATH)
    for orphan in decision.prunes:
        (out / orphan).unlink()
        # Drop a skill directory this just emptied, never the skills directory itself.
        parent = (out / orphan).parent
        skills = out / shipped_skills
        while parent != skills and parent != out and parent.is_dir() and not any(parent.iterdir()):
            parent.rmdir()
            parent = parent.parent
    for orphan in decision.removed:
        notes.append(
            f"{orphan} is no longer part of this stack but appears hand-edited, so it was "
            "kept; delete it yourself once you have salvaged anything you want from it."
        )
    if wire_root:
        _wire_root(out, created, notes, refresh=prior is not None)
    return created, notes


__all__ = ["DEFAULT_SERVER", "ShippedContextError", "run_agent_docs"]
