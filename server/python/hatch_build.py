"""Build hook — no-op.

The ``agent-context/`` content tree vendoring into ``_content/`` has been removed:
agent-context scaffolding is now owned by the Node ``meta agent-docs`` CLI. This
file is kept as a no-op to avoid breaking any build tooling that references it.
"""

from __future__ import annotations

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict) -> None:
        pass  # Nothing to vendor — scaffolding moved to the Node meta CLI.
