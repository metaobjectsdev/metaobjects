"""ui_web_provider — the web presentation view-attr MetaDataTypeProvider
(cross-port ``metaobjects-ui-web``).

Registers the attrs the embedded ``spec/metamodel/ui-web.json`` ``extends``
directives declare: ``view.textarea @rows`` and the ``view.image`` control's
``@aspectRatio`` / ``@maxEdge`` / ``@store`` / ``@accept`` / ``@maxBytes``. They are
cross-port vocabulary only TypeScript implements so far: Python registers them so a
shared model loads strictly here, and acts on none of them. Mirrors the TS
``uiWebProvider``, the C# ``UiWebMetaDataProvider`` and Java's
``UiWebTypesMetaDataProvider``.
"""
from __future__ import annotations

from ....provider import Provider
from ....registry import TypeRegistry
from ...provider_extends import register_extends

#: The embedded shared provider-definition file this provider sources its attrs from.
_UI_WEB_DEFINITION_FILE = "ui-web.json"


def _register(registry: TypeRegistry) -> None:
    # Exact subtypes only (view.textarea / view.image): no wildcard to expand.
    register_extends(registry, _UI_WEB_DEFINITION_FILE)


def _make_ui_web_provider() -> Provider:
    p = Provider("metaobjects-ui-web", dependencies=("metaobjects-core-types",))
    p.on_register(_register)
    return p


ui_web_provider = _make_ui_web_provider()
