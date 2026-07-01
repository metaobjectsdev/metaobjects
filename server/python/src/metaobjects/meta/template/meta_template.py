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

    ADR-0039 SANCTIONED OWN — template attrs are read own-only (``attr()``),
    matching BOTH reference ports: TS reads template attrs via ``ownAttr`` and the
    Java ``MetaTemplate`` uses ``getMetaAttr(name, /*includeParentData=*/false)``.
    Template refs (@payloadRef/@textRef/@responseRef/@format/@requiredSlots) are
    per-node declarations, not properties inherited across a template ``extends``
    chain, so the own read is the intended cross-port behavior (not an effective
    read of a possibly-inherited value).
    """

    def payload_ref(self) -> str | None:
        v = self.attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)  # ADR-0039: sanctioned own (template attr, cross-port own)
        return v if isinstance(v, str) and v else None

    def text_ref(self) -> str | None:
        v = self.attr(tc.TEMPLATE_ATTR_TEXT_REF)  # ADR-0039: sanctioned own (template attr, cross-port own)
        return v if isinstance(v, str) and v else None

    def response_ref(self) -> str | None:
        v = self.attr(tc.TEMPLATE_ATTR_RESPONSE_REF)  # ADR-0039: sanctioned own (template attr, cross-port own)
        return v if isinstance(v, str) and v else None

    def format_(self) -> str:
        v = self.attr(tc.TEMPLATE_ATTR_FORMAT)  # ADR-0039: sanctioned own (template attr, cross-port own)
        return v if isinstance(v, str) and v else tc.TEMPLATE_FORMAT_DEFAULT

    def required_slots(self) -> Sequence[str] | None:
        v = self.attr(tc.TEMPLATE_ATTR_REQUIRED_SLOTS)  # ADR-0039: sanctioned own (template attr, cross-port own)
        if isinstance(v, str):
            return tuple(s.strip() for s in v.split(",") if s.strip())
        if isinstance(v, (list, tuple)):
            return tuple(str(x) for x in v)
        return None

    def is_prompt(self) -> bool:
        return self.sub_type == tc.TEMPLATE_SUBTYPE_PROMPT
