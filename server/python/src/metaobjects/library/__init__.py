"""MetaObjects-shipped standard metadata packages.

Adopters opt in through the loader's ``libraries=["ai"]`` option and then
``extends: "metaobjects::ai::LlmCallBase"`` on their own entity.
"""

from .library_sources import known_packages, library_sources

__all__ = ["known_packages", "library_sources"]
