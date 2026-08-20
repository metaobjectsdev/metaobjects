"""The ADR-0052 direction rule, in ONE place (Python port).

A template subtype's axis is DIRECTION: ``template.output`` renders outbound (a document or
an email) and generates no parser; the inbound half — the response shape, the FR-010
response-format fragment, and the parser-on-receipt — belongs to a ``template.prompt`` that
declares ``@responseRef``.

Every inbound generator calls through here rather than re-deriving "which templates have a
response". Call sites each deciding for themselves is exactly how the pre-ADR-0052 tier
drifted: the parser applied NO format filter to the parser FILE while gating its tolerant
extract on ``@format``, and the fragment emitter applied a different ``@format`` gate — the
format of the OUTBOUND body, which is not the format of the reply.

Mirrors ``codegen-ts/src/templates/find-inbound.ts``, C#'s ``FindInbound.cs``, Java's
``FindInbound.java`` and Kotlin's ``FindInbound.kt``.
"""

from __future__ import annotations

from dataclasses import dataclass

from metaobjects.codegen.generators.payload_vo_generator import resolve_payload_vo
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.template import template_constants as tc
from metaobjects.shared.base_types import TYPE_TEMPLATE


@dataclass(frozen=True)
class InboundShape:
    """What an inbound generator needs about one responding prompt.

    ``vo``     — the resolved response value-object; the shape a reply is parsed INTO.
    ``ref``    — the ``@responseRef`` string as authored (bare or fully-qualified).
    ``format`` — the syntax of the REPLY (ADR-0053), never the template's ``@format``,
                 which is the syntax of the rendered prompt BODY. The two genuinely differ.
    """

    vo: MetaData
    ref: str
    format: str


def response_ref_of(template: MetaData) -> str | None:
    """The authored ``@responseRef`` of a responding prompt, or ``None``.

    ADR-0039: read RESOLVING — a template may inherit ``@responseRef`` through ``extends``,
    and shipped fixtures rely on exactly that.
    """
    if template.type != TYPE_TEMPLATE or template.sub_type != tc.TEMPLATE_SUBTYPE_PROMPT:
        return None
    ref = template.get_meta_attr(tc.TEMPLATE_ATTR_RESPONSE_REF)
    if not isinstance(ref, str) or not ref:
        return None
    return ref


def inbound_templates(root: MetaData) -> list[MetaData]:
    """Every ``template.prompt`` that declares a response shape, ordered by name.

    The gate is ``@responseRef`` PRESENCE, not a format value: declaring a response shape IS
    the request for a parser. Gating on ``@format`` was what let a ``text`` template get a
    strict parser but no tolerant extract, and — because ``@format`` defaults to ``text`` —
    would silently emit nothing at all after the re-homing.
    """
    return sorted(
        (c for c in root.children() if response_ref_of(c) is not None),
        key=lambda t: t.name,
    )


def response_shape(root: MetaData, template: MetaData, referrer_pkg: str) -> InboundShape | None:
    """Resolve a prompt's response value-object and reply syntax, or ``None``.

    ``None`` when the template declares no ``@responseRef`` or the ref does not resolve —
    callers skip rather than raise, matching the pre-ADR-0052 contract for an unresolvable
    payload ref.

    Resolution goes through ``resolve_payload_vo``, the SAME target rule ``@payloadRef``
    obeys, so a parser can never bind a record the payload tier refused to emit. (C# used the
    any-object resolver here and shipped exactly that defect: a ``@responseRef`` naming an
    ``object.entity`` produced a parser returning a type nobody declared.)
    """
    ref = response_ref_of(template)
    if ref is None:
        return None
    vo = resolve_payload_vo(root, ref, referrer_pkg)
    if vo is None:
        return None
    return InboundShape(vo=vo, ref=ref, format=response_format_of(template))


def response_format_of(template: MetaData) -> str:
    """The declared reply syntax, defaulted per ADR-0053.

    The default is ``json`` because that reproduces the trace helper's pre-ADR-0053 fallback
    exactly (anything that was not ``"xml"`` was treated as JSON), which is what makes the
    attribute's introduction behaviour-preserving rather than a new policy.
    """
    raw = template.get_meta_attr(tc.TEMPLATE_ATTR_RESPONSE_FORMAT)
    if isinstance(raw, str) and raw.lower() == tc.RESPONSE_FORMAT_XML:
        return tc.RESPONSE_FORMAT_XML
    return tc.RESPONSE_FORMAT_DEFAULT


def is_xml(response_format: str) -> bool:
    """True iff the reply is XML.

    The strict tier is JSON-ONLY by construction — not because no XML reader exists (the
    render package ships a forgiving one) but because strict all-or-nothing semantics layered
    over a REPAIRING parser is incoherent: it would raise or accept based on how much repair
    happened. So an XML reply gets the tolerant extract and nothing strict.
    """
    return response_format.lower() == tc.RESPONSE_FORMAT_XML
