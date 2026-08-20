"""Response-format fragment codegen — one ``<name>_response_format.py`` per
responding ``template.prompt`` declaration.

FR-010 artifact 1 (Python port). For each ``template.prompt`` whose ``@responseRef``
resolves to a payload target, emits a module exposing
``render_<name>_format(overrides=None) -> str`` backed by the render engine's
:func:`~metaobjects.render.render_output_format` (the "produce your answer like this"
fragment).

ADR-0052/0053 — the gate is ``@responseRef`` PRESENCE, never a format value. The old
``@format ∈ {json,xml}`` gate read the syntax of the OUTBOUND body to decide whether to
instruct the model about the syntax of its REPLY, so a text-bodied prompt asking for a
JSON answer — the common case — got no fragment at all. Both reply formats now get one;
``@responseFormat`` only selects which.

The baked :class:`~metaobjects.render.OutputFormatSpec`'s ``root_name`` is the RESPONSE
record's class name, so the fragment and the ``extract_<name>()`` codegen agree on the
root element/object name. Mirrors the C# ``OutputPromptGenerator`` / Java
``SpringOutputPromptGenerator``.
"""
from __future__ import annotations

from collections.abc import Callable

from metaobjects.apidocs.naming import snake_case as _snake_case
from metaobjects.codegen import output_format_spec_emitter as ofs
from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.codegen.generators.find_inbound import (
    inbound_templates,
    response_shape,
)
from metaobjects.codegen.generators.payload_vo_generator import response_class_name
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_data import MetaData
from metaobjects.shared.separators import PACKAGE_SEP

_GENERATOR_NAME = "output-prompt-generator"


def _pkg_of(node: MetaData) -> str:
    """The effective package of a node — its ``resolution_key()`` minus the
    trailing ``::<name>`` ("" for a root-level node). Duplicated (not imported) to
    match the existing per-generator convention. Used to derive a template's
    referrer package for ``resolve_payload_vo`` (#228) — see that function's
    docstring for why this ancestor-walk-aware form is used instead of the
    loader's bare ``tpl.package or tpl.file_default_package or ""``."""
    key = node.resolution_key()
    i = key.rfind(PACKAGE_SEP)
    return "" if i == -1 else key[:i]


def _emit_format_spec(
    payload: MetaObject, template: MetaData, root_name: str
) -> str:
    """The baked ``OutputFormatSpec`` literal. Module-level back-compat shim; the
    override seam is :meth:`OutputPromptGenerator._emit_format_spec`."""
    return ofs.spec_literal(payload, template, root_name)


def render_output_prompt(
    template: MetaData,
    root: MetaData,
    *,
    generator: "OutputPromptGenerator | None" = None,
) -> str | None:
    """Render one response-format fragment module for a responding ``template.prompt``.

    When *generator* is supplied, its ``_emit_format_spec`` override is used to bake
    the ``OutputFormatSpec`` literal (the extension seam); when ``None`` the
    module-level default is used (byte-identical back-compat path).

    Returns ``None`` when the template declares no ``@responseRef`` or the ref can't
    be resolved to a payload target (defensive — the loader validation pass / the
    parser generator share this contract)."""
    # ADR-0052: the fragment describes the RESPONSE shape, so it binds @responseRef —
    # never @payloadRef, which types the request this prompt renders outbound.
    shape = response_shape(root, template, _pkg_of(template))
    if shape is None:
        return None
    payload = shape.vo

    template_name = template.name
    snake = _snake_case(template_name)
    render_fn = f"render_{snake}_format"
    # root_name == the RESPONSE record's class name so the fragment and extract() agree.
    root_name = response_class_name(template_name)
    emit_spec = generator._emit_format_spec if generator is not None else _emit_format_spec
    spec_literal = emit_spec(payload, template, root_name)

    fqn = (
        f"{payload.package}::{template_name}"
        if payload.package
        else template_name
    )

    lines: list[str] = [
        generated_header(template_name, fqn),
        "from __future__ import annotations\n",
        "from metaobjects.render import (",
        "    PROMPT_OVERRIDES_NONE,",
        "    FieldKind,",
        "    Format,",
        "    OutputFormatSpec,",
        "    PromptField,",
        "    PromptOverrides,",
        "    PromptStyle,",
        "    render_output_format,",
        ")",
        "",
        "",
        "# FR-010 artifact 1 — the baked response-format descriptor for this prompt.",
        f"_SPEC: OutputFormatSpec = {spec_literal}",
        "",
        "",
        f"def {render_fn}(overrides: PromptOverrides | None = None) -> str:",
        '    """The response-format instruction fragment ("produce your answer like this").',
        "",
        "    A comment-free guide / inline / example-only fragment teaching an LLM how to",
        "    shape its answer. Pass ``overrides`` to swap the style or override a field's",
        '    example / instruction at render time."""',
        "    return render_output_format(_SPEC, overrides or PROMPT_OVERRIDES_NONE)",
        "",
        "",
        f'__all__ = ["{render_fn}"]',
        "",
    ]
    return "\n".join(lines)


class OutputPromptGenerator:
    """Generator wrapping :func:`render_output_prompt`. Emits one file per responding
    ``template.prompt`` declared at root level (ADR-0052)."""

    name = _GENERATOR_NAME

    def __init__(self, *, filter: Callable[[MetaObject], bool] | None = None) -> None:
        # ``filter`` matches the cross-generator contract even though this generator
        # iterates templates (not entities).
        self.filter = filter

    def _emit_format_spec(
        self, payload: MetaObject, template: MetaData, root_name: str
    ) -> str:
        """EXTENSION SEAM — the baked ``OutputFormatSpec`` literal. Defaults to the
        module-level :func:`_emit_format_spec`; override to inject custom field
        examples / instructions / style into the prompt fragment descriptor."""
        return _emit_format_spec(payload, template, root_name)

    def _render_module(self, template: MetaData, root: MetaData) -> str | None:
        """EXTENSION SEAM — render the whole response-format module for one responding
        ``template.prompt``. Defaults to :func:`render_output_prompt` (passing this
        instance so the ``_emit_format_spec`` override is honored). Override to
        pre/post-process the emitted source or replace the render path."""
        return render_output_prompt(template, root, generator=self)

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        root = ctx.loaded_root
        if root is None:
            return []
        files: list[EmittedFile] = []
        # ADR-0052: the direction rule lives in FindInbound, never re-derived here.
        for tmpl in inbound_templates(root):
            content = self._render_module(tmpl, root)
            if content is None:
                # Not an error — an unresolvable @responseRef is simply skipped (no
                # fragment), matching the C# contract.
                continue
            files.append(
                EmittedFile(
                    path=f"{_snake_case(tmpl.name)}_response_format.py",
                    content=ruff_format(content),
                )
            )
        return files


def output_prompt_generator(
    *, filter: Callable[[MetaObject], bool] | None = None
) -> Generator:
    """Factory mirroring the C# ``OutputPromptGenerator`` / Java
    ``SpringOutputPromptGenerator``."""
    return OutputPromptGenerator(filter=filter)
