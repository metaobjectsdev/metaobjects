"""Render-helper codegen — one ``<template_name_snake>_render_helper.py`` per
renderable template declaration — ``template.output`` AND ``template.prompt``, since
both render an outbound body (ADR-0052) — (render-helper phase 2).

For each renderable template this emits a typed ``render_<name>(payload, provider)``
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

ADR-0056: the ``payload`` parameter is typed as the ``@payloadRef`` value object's own
model, imported from the module the ``entity`` generator emits (``<Name>.py``); this
generator declares no payload type. A plain ``dict`` still renders — the annotation is for
the caller, and the render engine reads a model and a mapping alike.

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
from metaobjects.codegen.value_objects import bound_payload_vo, model_class_name
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_VALUE
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.template import template_constants as tc
from metaobjects.render.engine import (
    TEMPLATE_ENGINE_JINJA,
    TEMPLATE_ENGINE_MUSTACHE,
    template_engine_of,
)
from metaobjects.render.filesystem_provider import FilesystemProvider
from metaobjects.render.verify import (
    ERR_REQUIRED_SLOT_UNUSED,
    ERR_VAR_NOT_ON_PAYLOAD,
    PayloadField,
    verify,
)
from metaobjects.naming_refs import ref_target
from metaobjects.shared.base_types import TYPE_FIELD, TYPE_TEMPLATE
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
                target = ref_target(f, fc.FIELD_ATTR_OBJECT_REF)
                if target is not None and target.sub_type == OBJECT_SUBTYPE_VALUE:
                    children = _derive_payload_field_tree(root, target, next_seen)
                    # ADR-0039 resolving read: an array of this VO (vs a single
                    # nested instance) gates `-last` availability in `verify`.
                    fields.append(
                        PayloadField(f.name, children, is_array=f.resolved_is_array())
                    )
                    continue
        fields.append(PayloadField(f.name, is_array=f.resolved_is_array()))
    return fields


def _field_tree_literal(fields: list[PayloadField]) -> str:
    """Emit a ``list[PayloadField]`` as a deterministic Python literal:
    ``[PayloadField("name"), PayloadField("nested", [PayloadField("x")])]``.

    The array flag is emitted only when true, so a helper with no array field
    stays byte-identical to before ``is_array`` existed."""
    parts: list[str] = []
    for f in fields:
        args = [_py_str(f.name)]
        if f.fields is not None:
            args.append(_field_tree_literal(f.fields))
        elif f.is_array:
            args.append("None")  # fill the positional `fields` slot before the kwarg
        kw = ", is_array=True" if f.is_array else ""
        parts.append(f"PayloadField({', '.join(args)}{kw})")
    return "[" + ", ".join(parts) + "]"


# ---------------------------------------------------------------------------
# Emission.
# ---------------------------------------------------------------------------


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
    """Generator wrapping the per-renderable-template render-helper emit. Construct with
    the on-disk template root the build-time drift gate resolves each referenced
    mustache against — required, without it the gate cannot run.

    EXTENSION SEAM (open-for-extension). Adopters subclass this and override one of
    the protected emit hooks to customize the emitted helper without forking:

    * ``_emit_document(header, template_name, snake, payload_ref, tmpl, fields,
      *, payload_class)`` — the ``document``-kind helper (single ``str`` return).
    * ``_emit_email(header, template_name, snake, payload_ref, tmpl, fields,
      *, payload_class)`` — the ``email``-kind helper (``EmailDocument`` return).
      ``payload_class`` is the value object's model class the ``payload`` parameter is
      typed as (ADR-0056).
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
        # BOTH renderable subtypes: ADR-0052 makes the template axis DIRECTION, and a
        # template.prompt renders an outbound body exactly as a template.output does —
        # only what comes back differs, and that inbound tier belongs to the parser and
        # output-prompt generators. Filtering TEMPLATE_SUBTYPE_OUTPUT here left a prompt
        # with no generated render helper on this port at all. A prompt carries no @kind,
        # so it takes the document branch and the email branch stays output-only.
        renderable = sorted(
            (
                # ADR-0039 sanctioned own: top-level scan on the loader ROOT (never extended, own == effective)
                c
                for c in root.own_children()
                if c.type == TYPE_TEMPLATE
                and c.sub_type
                in (tc.TEMPLATE_SUBTYPE_OUTPUT, tc.TEMPLATE_SUBTYPE_PROMPT)
            ),
            key=lambda c: c.name,
        )
        files: list[EmittedFile] = []
        for tmpl in renderable:
            payload_ref = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
            if not isinstance(payload_ref, str) or not payload_ref:
                ctx.warn(
                    f"{_GENERATOR_NAME}: template.{tmpl.sub_type} '{tmpl.name}' missing "
                    "@payloadRef — skipped."
                )
                continue
            vo = bound_payload_vo(tmpl, tc.TEMPLATE_ATTR_PAYLOAD_REF)
            if vo is None:
                ctx.warn(
                    f"{_GENERATOR_NAME}: template.{tmpl.sub_type} '{tmpl.name}' @payloadRef "
                    f"'{payload_ref}' does not resolve to an object.value or "
                    f"sourceless object.projection — skipped."
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
    ) -> str:
        """Run the build-time drift gate for one referenced template body. RAISES (fails
        codegen) when the ref is unresolvable OR ``verify`` reports a non-warning error.
        Warnings (``ERR_REQUIRED_SLOT_UNUSED``) are tolerated. Matches the cross-port
        message style exactly. Returns the engine the body is written for (ADR-0061)."""
        text = self._provider.resolve(reference)
        if text is None:
            raise ValueError(
                f'render-helper drift: template "{template_name}" ref "{reference}" '
                "— unresolved (provider returned no text)"
            )
        engine = template_engine_of(self._provider, reference)
        for e in verify(text, fields, provider=self._provider, engine=engine):
            if e.code == ERR_REQUIRED_SLOT_UNUSED:
                continue  # warning
            detail = (
                f"{{{{{e.path}}}}} not on payload VO" if e.code == ERR_VAR_NOT_ON_PAYLOAD else e.path
            )
            raise ValueError(
                f'render-helper drift: template "{template_name}" ref "{reference}" '
                f"— {e.code}: {detail}"
            )
        return engine

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
        payload_class = model_class_name(vo)

        if kind == tc.TEMPLATE_KIND_EMAIL:
            return self._emit_email(
                header, template_name, snake, payload_ref, tmpl, fields,
                payload_class=payload_class,
            )
        return self._emit_document(
            header, template_name, snake, payload_ref, tmpl, fields,
            payload_class=payload_class,
        )

    def _emit_document(
        self,
        header: str,
        template_name: str,
        snake: str,
        payload_ref: str,
        tmpl: MetaData,
        fields: list[PayloadField],
        *,
        payload_class: str,
    ) -> str:
        text_ref = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_TEXT_REF)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
        if not isinstance(text_ref, str) or not text_ref:
            raise ValueError(
                f'template.{tmpl.sub_type} "{template_name}" missing @textRef'
            )
        fmt = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_FORMAT)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
        fmt = fmt if isinstance(fmt, str) and fmt else tc.TEMPLATE_FORMAT_DEFAULT
        max_chars = _max_chars_of(tmpl)

        # BUILD-TIME drift gate (THE headline) — raises on drift.
        engine = self._gate_ref(template_name, text_ref, fields)

        request_lines = [
            "        RenderRequest(",
            "            payload=payload,",
            "            provider=provider,",
            f"            ref={_py_str(text_ref)},",
            f"            format={_py_str(fmt)},",
        ]
        if max_chars is not None:
            request_lines.append(f"            max_chars={max_chars},")
        request_lines.extend(_jinja_request_lines(engine, fields, "            "))
        request_lines.append("        )")

        lines = [
            header,
            "from __future__ import annotations",
            "",
            "from metaobjects.render.renderer import render, RenderRequest",
            *_jinja_imports(engine),
            "",
            f"from .{payload_class} import {payload_class}",
            "",
            "",
            f"def render_{snake}(payload: {payload_class}, provider) -> str:",
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
        *,
        payload_class: str,
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
        text_ref = text_body_ref if isinstance(text_body_ref, str) and text_body_ref else None
        has_text = text_ref is not None

        # BUILD-TIME drift gate — every email part-ref is resolved + verified.
        subject_engine = self._gate_ref(template_name, subject_ref, fields)
        html_engine = self._gate_ref(template_name, html_body_ref, fields)
        text_engine = (
            self._gate_ref(template_name, text_ref, fields) if text_ref is not None else TEMPLATE_ENGINE_MUSTACHE
        )
        pad = "                "
        text_body_expr = (
            "render(\n"
            "            RenderRequest(\n"
            "                payload=payload,\n"
            "                provider=provider,\n"
            f"                ref={_py_str(text_ref or '')},\n"
            '                format="text",\n'
            + "".join(f"{line}\n" for line in _jinja_request_lines(text_engine, fields, pad))
            + "            )\n"
            "        )"
            if has_text
            else "None"
        )
        any_jinja = TEMPLATE_ENGINE_JINJA in (subject_engine, html_engine, text_engine)

        lines = [
            header,
            "from __future__ import annotations",
            "",
            "from metaobjects.render.email_document import EmailDocument",
            "from metaobjects.render.renderer import render, RenderRequest",
            *_jinja_imports(TEMPLATE_ENGINE_JINJA if any_jinja else TEMPLATE_ENGINE_MUSTACHE),
            "",
            f"from .{payload_class} import {payload_class}",
            "",
            "",
            f"def render_{snake}(payload: {payload_class}, provider) -> EmailDocument:",
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
            *_jinja_request_lines(subject_engine, fields, pad),
            "            )",
            "        ),",
            "        html_body=render(",
            "            RenderRequest(",
            "                payload=payload,",
            "                provider=provider,",
            f"                ref={_py_str(html_body_ref)},",
            '                format="html",',
            *_jinja_request_lines(html_engine, fields, pad),
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


def _jinja_imports(engine: str) -> list[str]:
    """The import a helper needs when it renders a Jinja body (ADR-0061); none for Mustache,
    so a Mustache helper is byte-identical to what it was before Jinja existed."""
    if engine != TEMPLATE_ENGINE_JINJA:
        return []
    return ["from metaobjects.render.verify import PayloadField"]


def _jinja_request_lines(engine: str, fields: list[PayloadField], pad: str) -> list[str]:
    """For a Jinja body: name the engine (so a runtime provider that cannot tell, such as an
    in-memory one, still renders it as Jinja) and run the payload check again at render
    time against the field tree the build gate used."""
    if engine != TEMPLATE_ENGINE_JINJA:
        return []
    return [
        f"{pad}engine={_py_str(TEMPLATE_ENGINE_JINJA)},",
        f"{pad}verify={_field_tree_literal(fields)},",
    ]
