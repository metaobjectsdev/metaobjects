"""What ``metaobjects verify --templates`` checks about a prompt's REPLY (``@responseRef``).

Mirrors the TypeScript ``response-verify.ts``. The loader already refuses a ``@responseRef``
that names nothing (``ERR_INVALID_TEMPLATE``), so this gate checks what loading cannot:

* the reply type has a field tree a parser can read (``ERR_RESPONSE_UNRESOLVED``, an error:
  a reply with no fields parses into nothing);
* for an ``@responseFormat: xml`` prompt, every ``@requiredTags`` tag - which the body is
  already held to (``ERR_OUTPUT_TAG_MISSING``) - names the reply type or one of its fields
  (``ERR_RESPONSE_TAG_UNDECLARED``, a warning). The body teaches the model those tags and the
  extractor reads the reply type's fields; this is the link between them.

Pinned cross-port by ``fixtures/response-verify-conformance/``.
"""
from __future__ import annotations

from dataclasses import dataclass

from metaobjects.codegen.generators.render_helper_generator import _derive_payload_field_tree
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.template import template_constants as tc
from metaobjects.naming_refs import ref_target
from metaobjects.shared.base_types import TYPE_TEMPLATE
from metaobjects.shared.separators import PACKAGE_SEP
from metaobjects.render.verify import PayloadField

#: A responding prompt's ``@responseRef`` names no loaded value shape with fields.
ERR_RESPONSE_UNRESOLVED = "ERR_RESPONSE_UNRESOLVED"
#: An xml prompt's ``@requiredTags`` tag names neither the reply type nor a reply field (warning).
ERR_RESPONSE_TAG_UNDECLARED = "ERR_RESPONSE_TAG_UNDECLARED"

SEVERITY_ERROR = "error"
SEVERITY_WARNING = "warning"



@dataclass(frozen=True)
class ResponseFinding:
    code: str
    #: The ``@responseRef`` value, or the offending tag.
    path: str
    severity: str


def _field_names(tree: list[PayloadField], out: set[str]) -> set[str]:
    for f in tree:
        out.add(f.name)
        children = getattr(f, "fields", None)
        if children:
            _field_names(list(children), out)
    return out


def _short_name(name: str) -> str:
    i = name.rfind(PACKAGE_SEP)
    return name if i == -1 else name[i + len(PACKAGE_SEP):]


def response_findings(root: MetaData, tmpl: MetaData) -> list[ResponseFinding]:
    """The reply findings for one template. Empty for anything that is not a
    ``template.prompt`` carrying ``@responseRef`` - a prompt that does not elicit a typed
    reply has nothing here."""
    if tmpl.type != TYPE_TEMPLATE or tmpl.sub_type != tc.TEMPLATE_SUBTYPE_PROMPT:
        return []
    # ADR-0039: resolving reads - a prompt may inherit @responseRef / @responseFormat / @requiredTags.
    response_ref = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_RESPONSE_REF)
    if not isinstance(response_ref, str):
        return []

    reply = ref_target(tmpl, tc.TEMPLATE_ATTR_RESPONSE_REF)
    tree = _derive_payload_field_tree(root, reply, frozenset()) if isinstance(reply, MetaObject) else []
    if reply is None or not tree:
        return [ResponseFinding(ERR_RESPONSE_UNRESOLVED, response_ref, SEVERITY_ERROR)]

    fmt = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_RESPONSE_FORMAT)
    if not isinstance(fmt, str) or fmt.lower() != tc.RESPONSE_FORMAT_XML:
        return []
    tags = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_REQUIRED_TAGS)
    if not isinstance(tags, (list, tuple)):
        return []
    known = _field_names(tree, {_short_name(reply.name)})
    return [
        ResponseFinding(ERR_RESPONSE_TAG_UNDECLARED, t, SEVERITY_WARNING)
        for t in tags
        if isinstance(t, str) and t not in known
    ]
