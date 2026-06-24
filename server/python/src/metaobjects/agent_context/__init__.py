"""Agent-context staleness nudge — manifest reader for gen/verify.

The assembly path has moved to the Node ``meta agent-docs`` CLI. This package
now only exposes the staleness-nudge symbols (``agent_context_staleness``,
``Manifest``, ``AGENT_CONTEXT_MANIFEST_PATH``, ``installed_metaobjects_version``)
used by ``gen``/``verify`` to detect when the copied-in agent context predates
the installed MetaObjects version.
"""

from __future__ import annotations

from .scaffold import (
    AGENT_CONTEXT_MANIFEST_PATH,
    Manifest,
    agent_context_staleness,
    installed_metaobjects_version,
)

__all__ = [
    "AGENT_CONTEXT_MANIFEST_PATH",
    "Manifest",
    "agent_context_staleness",
    "installed_metaobjects_version",
]
