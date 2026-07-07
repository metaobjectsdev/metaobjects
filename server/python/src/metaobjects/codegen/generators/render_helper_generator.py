"""Render-helper codegen — one ``<template_name_snake>_render_helper.py`` per
``template.output`` declaration (render-helper phase 2).

For each ``template.output`` this emits a typed ``render_<name>(payload, provider)``
function that WRAPS the existing :func:`metaobjects.render.renderer.render` engine,
and enforces the mustache↔payload-VO drift check (the existing
:func:`metaobjects.render.verify.verify`) at BUILD time.

Two shapes keyed off ``@kind``:

* ``document`` (default) → renders ``@textRef`` in ``@format`` → one ``str``.
* ``email`` → renders ``@subjectRef`` (text) + ``@htmlBodyRef`` (html)
  (+ optional ``@textBodyRef``, text) → an
  :class:`metaobjects.render.email_document.EmailDocument`.

THE HEADLINE is the BUILD-TIME drift gate. BEFORE emitting, every referenced
mustache (document: ``@textRef``; email: subject + html (+ optional text)) is
resolved through a :class:`~metaobjects.render.filesystem_provider.FilesystemProvider`
rooted at the ``template_root`` ctor arg and run through ``verify``. If a referenced
text is unresolvable OR carries any NON-warning error (anything other than
``ERR_REQUIRED_SLOT_UNUSED`` — a ``{{field}}`` not on the payload VO produces
``ERR_VAR_NOT_ON_PAYLOAD``), the generator RAISES (fails codegen), naming the
template, the ref, the error code, and the offending field. This is what makes the
build fail when a mustache references a field the payload VO doesn't declare.

Reuse, not reimplementation: ``render`` (the emitted runtime call), ``verify`` (the
build-time gate), ``FilesystemProvider`` (build-time ref resolution), and
``EmailDocument`` (email return type). The payload field tree is walked from the VO
the same way the other generators walk it — a nested ``field.object``'s ``@objectRef``
is resolved FQN-exact when fully-qualified (ADR-0041) else by short name (cross-port
render-helper consensus: TS ``refMatchesObject`` / Java+Kotlin ``resolveNestedObjectRef``
/ C# ``ResolveNestedObjectRef``), only recursing into ``object.value`` targets, cycle-guarded.

Python divergence vs TS / Java / C#: Python's ``RenderRequest`` has NO ``verify``
field — the Python render engine does not run a runtime drift pass — so the emitted
helper does NOT pass a runtime ``verify`` field-tree. The BUILD-TIME gate that runs
here is the only, and a complete, drift guarantee: codegen cannot succeed unless
every referenced mustache verifies clean against the payload VO. The field-tree walk
is still performed (it is what ``verify`` checks against); it is simply not baked into
the emitted call. The emitted helper shape is otherwise identical to the other ports.

Drift message style matches the other ports exactly:
``render-helper drift: template "<N>" ref "<r>" — <CODE>: {{<f>}} not on payload VO``
"""
from __future__ import annotations

from collections.abc import Callable

from metaobjects.apidocs.naming import snake_case as _snake_case
from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_VALUE
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.template import template_constants as tc
from metaobjects.render.filesystem_provider import FilesystemProvider
from metaobjects.render.verify import (
    ERR_REQUIRED_SLOT_UNUSED,
    PayloadField,
    verify,
)
from metaobjects.shared.base_types import TYPE_FIELD, TYPE_OBJECT, TYPE_TEMPLATE
from metaobjects.shared.separators import PACKAGE_SEP

_GENERATOR_NAME = "render-helper-generator"


def _py_str(s: str) -> str:
    """A double-quoted Python string literal with the minimal escaping the refs/formats
    need (refs are ``group/source`` slugs; formats are closed-enum words)."""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


# ---------------------------------------------------------------------------
# Payload field-tree walk — nested @objectRef resolved FQN-exact (ADR-0041).
# Object-ref fields recurse into their target object.value (SUBTYPE_VALUE only);
# a `seen` set guards reference cycles.
# ---------------------------------------------------------------------------


def _resolve_nested_object_ref(root: MetaData, reference: str) -> MetaObject | None:
    """Resolve a ``field.object``'s ``@objectRef`` to its target ``object.value``.

    ADR-0041: a FULLY-QUALIFIED ref (contains ``::``) resolves EXACTLY on the
    package-qualified name (``resolution_key()``/``fqn()``) — never a bare-tail
    fallback that would bind a same-named ``object.value`` in the WRONG package on a
    cross-package short-name collision. A bare ref still matches by short name
    (first-wins). Mirrors the Java/Kotlin ``resolveNestedObjectRef`` + TS
    ``refMatchesObject``."""
    if not reference:
        return None
    fqn = PACKAGE_SEP in reference
    ref_short = reference.rsplit(PACKAGE_SEP, 1)[-1]
    # ADR-0039 sanctioned own: top-level scan on the loader ROOT (never extended, own == effective)
    for child in root.own_children():
        if child.type != TYPE_OBJECT or not isinstance(child, MetaObject):
            continue
        if child.sub_type != OBJECT_SUBTYPE_VALUE:
            continue
        if fqn:
            if child.resolution_key() == reference or child.fqn() == reference:
                return child
        elif child.name.rsplit(PACKAGE_SEP, 1)[-1] == ref_short:
            return child
    return None


def _derive_payload_field_tree(
    root: MetaData, vo: MetaObject, seen: frozenset[str]
) -> list[PayloadField]:
    """Walk *vo*'s fields into a :class:`PayloadField` tree. A ``field.object`` with a
    resolvable ``@objectRef`` to an ``object.value`` becomes a context-pushing node whose
    children are the target VO's tree (recursed, cycle-guarded). Every other field is a
    leaf."""
    if vo is None or vo.resolution_key() in seen:
        return []
    next_seen = seen | {vo.resolution_key()}
    fields: list[PayloadField] = []
    for f in vo.children():
        if f.type != TYPE_FIELD or not isinstance(f, MetaField):
            continue
        if f.sub_type == fc.FIELD_SUBTYPE_OBJECT:
            ref = f.attrs().get(fc.FIELD_ATTR_OBJECT_REF)
            if isinstance(ref, str) and ref:
                target = _resolve_nested_object_ref(root, ref)
                if target is not None and target.sub_type == OBJECT_SUBTYPE_VALUE:
                    children = _derive_payload_field_tree(root, target, next_seen)
                    fields.append(PayloadField(f.name, children))
                    continue
        fields.append(PayloadField(f.name))
    return fields


def _field_tree_literal(fields: list[PayloadField]) -> str:
    """Emit a ``list[PayloadField]`` as a deterministic Python literal:
    ``[PayloadField("name"), PayloadField("nested", [PayloadField("x")])]``."""
    parts: list[str] = []
    for f in fields:
        if f.fields is not None:
            parts.append(f"PayloadField({_py_str(f.name)}, {_field_tree_literal(f.fields)})")
        else:
            parts.append(f"PayloadField({_py_str(f.name)})")
    return "[" + ", ".join(parts) + "]"


# ---------------------------------------------------------------------------
# Resolution + emission.
# ---------------------------------------------------------------------------


def _resolve_payload_vo(root: MetaData, payload_ref: str) -> MetaObject | None:
    """``@payloadRef`` must resolve to an ``object.value`` (same contract as the
    parser/prompt generators). Matches a value-object child by short name OR by the
    last segment of a fully-qualified ``a::b::Name`` ref (FR-026 expands refs to FQN,
    while the child node still carries the short ``name``)."""
    ref_short = payload_ref.rsplit("::", 1)[-1]
    # ADR-0039 sanctioned own: top-level scan on the loader ROOT (never extended, own == effective)
    for child in root.own_children():
        if child.type != TYPE_OBJECT or not isinstance(child, MetaObject):
            continue
        if child.sub_type == OBJECT_SUBTYPE_VALUE and child.name in (payload_ref, ref_short):
            return child
    return None


def _max_chars_of(tmpl: MetaData) -> int | None:
    """Resolve ``@maxChars`` (own attr) as an int, or ``None`` when absent/non-numeric."""
    v = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_MAX_CHARS)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, str):
        try:
            return int(v)
        except ValueError:
            return None
    return None


class RenderHelperGenerator:
    """Generator wrapping the per-``template.output`` render-helper emit. Construct with
    the on-disk template root the build-time drift gate resolves each referenced
    mustache against — required, without it the gate cannot run.

    EXTENSION SEAM (open-for-extension). Adopters subclass this and override one of
    the protected emit hooks to customize the emitted helper without forking:

    * ``_emit_document(header, template_name, snake, payload_ref, tmpl, fields)`` —
      the ``document``-kind helper (single ``str`` return).
    * ``_emit_email(header, template_name, snake, payload_ref, tmpl, fields)`` — the
      ``email``-kind helper (``EmailDocument`` return).
    * ``_emit_helper(tmpl, vo, payload_ref, root)`` — the per-template dispatch
      (runs the build-time drift gate, then routes to document/email).

    The build-time drift gate (``_gate_ref``) is also overridable, but tightening it
    is the safer direction than loosening it. The factory ``render_helper_generator()``
    returns a default instance, so the default suite stays byte-identical."""

    name = _GENERATOR_NAME

    def __init__(
        self,
        template_root: str,
        *,
        filter: Callable[[MetaObject], bool] | None = None,
    ) -> None:
        if not template_root:
            raise ValueError(
                "RenderHelperGenerator requires a template_root (the on-disk template "
                "dir) for the build-time drift gate"
            )
        # The ``filter`` arg matches the cross-generator contract even though this
        # generator iterates templates (not entities).
        self.filter = filter
        self._provider = FilesystemProvider(template_root)

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        root = ctx.loaded_root
        if root is None:
            return []
        outputs = sorted(
            (
                # ADR-0039 sanctioned own: top-level scan on the loader ROOT (never extended, own == effective)
                c
                for c in root.own_children()
                if c.type == TYPE_TEMPLATE
                and c.sub_type == tc.TEMPLATE_SUBTYPE_OUTPUT
            ),
            key=lambda c: c.name,
        )
        files: list[EmittedFile] = []
        for tmpl in outputs:
            payload_ref = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
            if not isinstance(payload_ref, str) or not payload_ref:
                ctx.warn(
                    f"{_GENERATOR_NAME}: template.output '{tmpl.name}' missing "
                    "@payloadRef — skipped."
                )
                continue
            vo = _resolve_payload_vo(root, payload_ref)
            if vo is None:
                ctx.warn(
                    f"{_GENERATOR_NAME}: template.output '{tmpl.name}' @payloadRef "
                    f"'{payload_ref}' does not resolve to an object.value — skipped."
                )
                continue
            # _emit_helper runs the build-time drift gate first and RAISES (fails
            # codegen) on a mustache↔VO drift — intentionally NOT caught.
            content = self._emit_helper(tmpl, vo, payload_ref, root)
            files.append(
                EmittedFile(
                    path=f"{_snake_case(tmpl.name)}_render_helper.py",
                    content=ruff_format(content),
                )
            )
        return files

    # -- build-time drift gate -------------------------------------------------

    def _gate_ref(
        self, template_name: str, reference: str, fields: list[PayloadField]
    ) -> None:
        """Run the build-time drift gate for one referenced mustache. RAISES (fails
        codegen) when the ref is unresolvable OR ``verify`` reports a non-warning error.
        Warnings (``ERR_REQUIRED_SLOT_UNUSED``) are tolerated. Matches the cross-port
        message style exactly."""
        text = self._provider.resolve(reference)
        if text is None:
            raise ValueError(
                f'render-helper drift: template "{template_name}" ref "{reference}" '
                "— unresolved (provider returned no text)"
            )
        for e in verify(text, fields, provider=self._provider):
            if e.code == ERR_REQUIRED_SLOT_UNUSED:
                continue  # warning
            raise ValueError(
                f'render-helper drift: template "{template_name}" ref "{reference}" '
                f"— {e.code}: {{{{{e.path}}}}} not on payload VO"
            )

    # -- emission --------------------------------------------------------------

    def _emit_helper(
        self,
        tmpl: MetaData,
        vo: MetaObject,
        payload_ref: str,
        root: MetaData,
    ) -> str:
        template_name = tmpl.name
        snake = _snake_case(template_name)
        fields = _derive_payload_field_tree(root, vo, frozenset())
        kind = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_KIND)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
        kind = (kind if isinstance(kind, str) else tc.TEMPLATE_KIND_DEFAULT).lower()

        fqn = (
            f"{vo.package}{PACKAGE_SEP}{template_name}"
            if getattr(vo, "package", None)
            else template_name
        )
        header = generated_header(template_name, fqn)

        if kind == tc.TEMPLATE_KIND_EMAIL:
            return self._emit_email(header, template_name, snake, payload_ref, tmpl, fields)
        return self._emit_document(header, template_name, snake, payload_ref, tmpl, fields)

    def _emit_document(
        self,
        header: str,
        template_name: str,
        snake: str,
        payload_ref: str,
        tmpl: MetaData,
        fields: list[PayloadField],
    ) -> str:
        text_ref = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_TEXT_REF)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
        if not isinstance(text_ref, str) or not text_ref:
            raise ValueError(
                f'template.output "{template_name}" (document) missing @textRef'
            )
        fmt = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_FORMAT)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
        fmt = fmt if isinstance(fmt, str) and fmt else tc.TEMPLATE_FORMAT_DEFAULT
        max_chars = _max_chars_of(tmpl)

        # BUILD-TIME drift gate (THE headline) — raises on drift.
        self._gate_ref(template_name, text_ref, fields)

        request_lines = [
            "        RenderRequest(",
            "            payload=payload,",
            "            provider=provider,",
            f"            ref={_py_str(text_ref)},",
            f"            format={_py_str(fmt)},",
        ]
        if max_chars is not None:
            request_lines.append(f"            max_chars={max_chars},")
        request_lines.append("        )")

        lines = [
            header,
            "from __future__ import annotations",
            "",
            "from metaobjects.render.renderer import render, RenderRequest",
            "",
            "",
            f"def render_{snake}(payload, provider) -> str:",
            f'    """Render the ``{template_name}`` document from a typed '
            f"``{payload_ref}`` payload.",
            "",
            "    Wraps the render engine; the mustache↔payload-VO drift check ran at",
            '    BUILD time (codegen fails on drift)."""',
            "    return render(",
            *request_lines,
            "    )",
            "",
            "",
            f'__all__ = ["render_{snake}"]',
            "",
        ]
        return "\n".join(lines)

    def _emit_email(
        self,
        header: str,
        template_name: str,
        snake: str,
        payload_ref: str,
        tmpl: MetaData,
        fields: list[PayloadField],
    ) -> str:
        subject_ref = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_SUBJECT_REF)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
        html_body_ref = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_HTML_BODY_REF)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
        text_body_ref = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_TEXT_BODY_REF)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
        if not isinstance(subject_ref, str) or not subject_ref:
            raise ValueError(
                f'template.output "{template_name}" (email) missing @subjectRef'
            )
        if not isinstance(html_body_ref, str) or not html_body_ref:
            raise ValueError(
                f'template.output "{template_name}" (email) missing @htmlBodyRef'
            )
        has_text = isinstance(text_body_ref, str) and bool(text_body_ref)

        # BUILD-TIME drift gate — every email part-ref is resolved + verified.
        self._gate_ref(template_name, subject_ref, fields)
        self._gate_ref(template_name, html_body_ref, fields)
        if has_text:
            self._gate_ref(template_name, text_body_ref, fields)

        text_body_expr = (
            "render(\n"
            "            RenderRequest(\n"
            "                payload=payload,\n"
            "                provider=provider,\n"
            f"                ref={_py_str(text_body_ref)},\n"
            '                format="text",\n'
            "            )\n"
            "        )"
            if has_text
            else "None"
        )

        lines = [
            header,
            "from __future__ import annotations",
            "",
            "from metaobjects.render.email_document import EmailDocument",
            "from metaobjects.render.renderer import render, RenderRequest",
            "",
            "",
            f"def render_{snake}(payload, provider) -> EmailDocument:",
            f'    """Render the ``{template_name}`` email (subject + html body'
            f'{" + text body" if has_text else ""}) from a typed ``{payload_ref}`` payload.',
            "",
            "    Wraps the render engine; the mustache↔payload-VO drift check ran at",
            '    BUILD time (codegen fails on drift)."""',
            "    return EmailDocument(",
            "        subject=render(",
            "            RenderRequest(",
            "                payload=payload,",
            "                provider=provider,",
            f"                ref={_py_str(subject_ref)},",
            '                format="text",',
            "            )",
            "        ),",
            "        html_body=render(",
            "            RenderRequest(",
            "                payload=payload,",
            "                provider=provider,",
            f"                ref={_py_str(html_body_ref)},",
            '                format="html",',
            "            )",
            "        ),",
            f"        text_body={text_body_expr},",
            "    )",
            "",
            "",
            f'__all__ = ["render_{snake}"]',
            "",
        ]
        return "\n".join(lines)


def render_helper_generator(
    *,
    template_root: str,
    filter: Callable[[MetaObject], bool] | None = None,
) -> Generator:
    """Factory mirroring the TS ``renderHelper()`` / C# ``RenderHelperGenerator`` /
    Java ``SpringRenderHelperGenerator`` constructors."""
    return RenderHelperGenerator(template_root, filter=filter)
