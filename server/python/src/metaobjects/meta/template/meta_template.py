"""MetaTemplate — template.* metatype (FR-004).

Cross-port parity with Java's `MetaTemplate` / `PromptTemplate` / `OutputTemplate`
and C#'s `MetaObjects.Render` template tier.
"""
from __future__ import annotations

from collections.abc import Sequence

from ..meta_data import MetaData
from . import template_constants as tc


class MetaTemplate(MetaData):
    """Concrete container for `template.prompt` / `template.output`.

    Own-only accessors — read each attr off the node itself, never the super
    chain (the loader's effective-attr walk is for codegen, not validation).
    """

    def payload_ref(self) -> str | None:
        v = self.attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)
        return v if isinstance(v, str) and v else None

    def text_ref(self) -> str | None:
        v = self.attr(tc.TEMPLATE_ATTR_TEXT_REF)
        return v if isinstance(v, str) and v else None

    def format_(self) -> str:
        v = self.attr(tc.TEMPLATE_ATTR_FORMAT)
        return v if isinstance(v, str) and v else tc.TEMPLATE_FORMAT_DEFAULT

    def required_slots(self) -> Sequence[str] | None:
        v = self.attr(tc.TEMPLATE_ATTR_REQUIRED_SLOTS)
        if isinstance(v, str):
            return tuple(s.strip() for s in v.split(",") if s.strip())
        if isinstance(v, (list, tuple)):
            return tuple(str(x) for x in v)
        return None

    def is_prompt(self) -> bool:
        return self.sub_type == tc.TEMPLATE_SUBTYPE_PROMPT
