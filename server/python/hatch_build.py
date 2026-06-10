"""Build hook: vendor the repo-root ``agent-context/`` tree into the package.

metaobjects ships the shared agent-context content bundled inside the wheel at
``metaobjects/agent_context/_content/`` so the installed ``metaobjects agent-docs``
command can resolve it offline. The source of truth lives at the **repo root**
(``../../agent-context``), outside this Python package, so it must be copied in at
build time.

This replaces a ``[tool.hatch.build.targets.wheel.force-include]`` of
``../../agent-context``, which only worked when building the wheel directly from the
source tree and broke ``uv build`` (sdist → wheel), where the parent path is absent.

Resolution by build phase:
- Building from the source tree (sdist *or* wheel): ``../../agent-context`` exists →
  copy it into ``src/metaobjects/agent_context/_content``. ``[tool.hatch.build]
  artifacts`` then forces that (gitignored) tree into the produced artifact.
- Building the wheel **from an sdist**: ``../../agent-context`` is absent, but the
  content is already vendored inside the sdist → skip the copy and keep it.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict) -> None:
        root = Path(self.root)
        dest = root / "src" / "metaobjects" / "agent_context" / "_content"
        source = (root / ".." / ".." / "agent-context").resolve()
        if source.is_dir():
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(source, dest)
        # else: building the wheel from an sdist — the content is already vendored
        # inside it (see [tool.hatch.build] artifacts); leave it in place.
