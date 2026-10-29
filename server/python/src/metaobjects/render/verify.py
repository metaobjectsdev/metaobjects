"""Template-side drift check (FR-004 Plan #3) — the Python port of ``verify``.

``verify`` parses a Mustache template's TEXT and cross-checks every variable,
section, and partial against the declared field tree of the template's payload
view-object — catching "a renamed field silently broke a prompt". Zero-dependency
by design: it takes a plain :class:`PayloadField` tree (no loader import) and a
small purpose-built Mustache *tag* tokenizer (it needs tag structure, not
rendering/whitespace).

Ported from ``typescript/packages/render/src/verify.ts`` and
``csharp/MetaObjects.Render/Verify.cs``; the three share the
``fixtures/verify-conformance/`` corpus that proves they agree.

Tags come from :mod:`metaobjects.render.mustache_tags`, which follows the Mustache
spec (a comment ends at the first closing delimiter, ``{{=<% %>=}}`` changes the
delimiters, a close must name its open) and is shared with the renderer's partial
expansion, so verify and render cannot disagree about where a tag is.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from .engine import TEMPLATE_ENGINE_JINJA, TEMPLATE_ENGINE_MUSTACHE, partial_engine_mismatch
from .mustache_tags import (
    KIND_AMP,
    KIND_CLOSE,
    KIND_INVERTED,
    KIND_NAME,
    KIND_PARTIAL,
    KIND_SECTION,
    KIND_TRIPLE,
    MustacheSyntaxError,
    scan,
    without_comments,
)
from .payload_accessors import is_boolean_accessor, is_positional_accessor

#: A ``{{var}}`` references a field the (contextual) payload does not declare.
ERR_VAR_NOT_ON_PAYLOAD = "ERR_VAR_NOT_ON_PAYLOAD"
#: A ``{{> ref}}`` partial (or a Jinja ``include`` / ``import`` / ``extends``) does not
#: resolve in the provider.
ERR_PARTIAL_UNRESOLVED = "ERR_PARTIAL_UNRESOLVED"
#: A declared @requiredSlots slot is never referenced by the template (warning).
ERR_REQUIRED_SLOT_UNUSED = "ERR_REQUIRED_SLOT_UNUSED"
#: A declared @requiredTags output tag is absent from the template text.
ERR_OUTPUT_TAG_MISSING = "ERR_OUTPUT_TAG_MISSING"
#: Jinja: a payload reference the check cannot resolve without running the template — a
#: dynamic key on an object (``user[key]``), a computed ``attribute=`` argument, or a
#: template name that is an expression (``{% include name %}``). Reported, never passed.
ERR_TEMPLATE_NOT_STATIC = "ERR_TEMPLATE_NOT_STATIC"
#: The template text does not parse. Jinja: path = the parser's message. Mustache: an
#: unbalanced section, path = the section's name.
ERR_TEMPLATE_SYNTAX = "ERR_TEMPLATE_SYNTAX"
#: A body is written for an engine this port does not run (Java, Kotlin and C# run
#: Mustache only, so a ``.jinja`` template there is refused with this code).
ERR_TEMPLATE_ENGINE_UNSUPPORTED = "ERR_TEMPLATE_ENGINE_UNSUPPORTED"

#: How deep partial / include / import / extends resolution recurses before it stops.
#: Shared by the Mustache and Jinja walks, and by both renderers.
MAX_DEPTH = 32
#: An opening tag is ``<tag`` immediately followed by ``>`` or XML whitespace, so
#: attributes are allowed (``<answer foo="1">``) but a longer name is not over-matched
#: (``<answers>`` does not satisfy ``answer``).
_TAG_OPEN_DELIMS = frozenset((">", " ", "\t", "\n", "\r"))


@dataclass(frozen=True)
class PayloadField:
    """A plain field-tree node mirroring an ``object.value`` view-object's walk.

    ``fields`` present → a context-pushing field (object / array-of-object);
    ``fields is None`` → a scalar (string/number/boolean/scalar-array).

    ``is_array`` is the field's EFFECTIVE ``isArray`` (resolving read, when built
    from real metadata) — distinct from ``fields is not None``: an array of
    SCALARS has ``is_array=True`` and ``fields=None``; a single nested object has
    ``is_array=False`` and ``fields`` present. The combination of the two decides
    whether ``-last`` is available inside a ``{{#x}}`` section over this field
    (see the walk in :func:`verify`).
    """

    name: str
    fields: list[PayloadField] | None = None
    is_array: bool = False


@dataclass(frozen=True)
class VerifyError:
    """A single drift finding: a code + the offending var path / partial ref / slot."""

    code: str
    path: str


class Provider(Protocol):
    """Resolves a ``{{> group/source}}`` partial ref to its body text, or ``None``.

    A provider MAY also define ``engine_of(ref) -> str | None`` — the engine the ref's
    text is written for (a filesystem provider knows from the file extension it found).
    Without it, a body is Mustache unless the caller passes ``engine`` (ADR-0061).
    """

    def resolve(self, ref: str) -> str | None: ...


class InMemoryProvider:
    """A :class:`Provider` backed by a dict of ref → body text.

    ``engine`` (optional) is the engine every body in this provider is written for.
    """

    def __init__(self, partials: dict[str, str] | None = None, engine: str | None = None) -> None:
        self._partials = dict(partials or {})
        self._engine = engine

    def resolve(self, ref: str) -> str | None:
        return self._partials.get(ref)

    def engine_of(self, ref: str) -> str | None:
        return self._engine if ref in self._partials else None


# --- Mustache tag token model (rendering-agnostic; only tag structure) ---


@dataclass(frozen=True)
class _Var:
    value: str


@dataclass(frozen=True)
class _Section:
    value: str
    inverted: bool
    children: list[_Token]


@dataclass(frozen=True)
class _Partial:
    value: str


_Token = _Var | _Section | _Partial


def _tokenize(text: str) -> list[_Token]:
    """The tag tree of ``text``, built from the shared scanner (:mod:`mustache_tags`).

    Raises :class:`MustacheSyntaxError` on an unbalanced section."""
    root: list[_Token] = []
    open_levels: list[list[_Token]] = [root]
    for tag in scan(text):
        level = open_levels[-1]
        if tag.kind in (KIND_SECTION, KIND_INVERTED):
            section = _Section(tag.value, tag.kind == KIND_INVERTED, [])
            level.append(section)
            open_levels.append(section.children)
        elif tag.kind == KIND_CLOSE:
            open_levels.pop()  # the scanner already matched it to its open
        elif tag.kind == KIND_PARTIAL:
            level.append(_Partial(tag.value))
        elif tag.kind in (KIND_NAME, KIND_TRIPLE, KIND_AMP):
            level.append(_Var(tag.value))  # {{x}}, {{x.y}}, {{.}}, {{{x}}}, {{&x}}
        # comments and delimiter changes carry no reference
    return root


def _static_text(text: str) -> str:
    """``text`` minus its comments, for the output-tag scan."""
    return without_comments(text, scan(text))


def _find(fields: list[PayloadField], name: str) -> PayloadField | None:
    return next((f for f in fields if f.name == name), None)


def _resolve(stack: list[list[PayloadField]], path: str) -> PayloadField | None:
    """Resolve a (possibly dotted) path the way Mustache does: the FIRST segment is
    looked up through the context stack (innermost → outermost); each remaining
    segment descends into the resolved field's ``fields``.
    """
    segs = path.split(".")
    current: PayloadField | None = None
    for level in reversed(stack):
        hit = _find(level, segs[0])
        if hit is not None:
            current = hit
            break
    for seg in segs[1:]:
        if current is None:
            break
        current = _find(current.fields, seg) if current.fields is not None else None
    return current


def _has_open_tag(text: str, tag: str) -> bool:
    """Whether ``text`` contains an opening form of ``tag`` (see ``_TAG_OPEN_DELIMS``)."""
    needle = f"<{tag}"
    i = text.find(needle)
    while i != -1:
        after = i + len(needle)
        if after < len(text) and text[after] in _TAG_OPEN_DELIMS:
            return True
        i = text.find(needle, i + 1)
    return False


def _has_close_tag(text: str, tag: str) -> bool:
    """A closing tag is the exact literal ``</tag>``. A self-closing ``<tag/>`` has no
    such form, so it never satisfies a required tag — these wrap content a parser reads.
    """
    return f"</{tag}>" in text


def verify(
    template_text: str,
    fields: list[PayloadField],
    *,
    provider: Provider | None = None,
    required_slots: list[str] | None = None,
    required_tags: list[str] | None = None,
    engine: str | None = None,
) -> list[VerifyError]:
    """Check a template's references against a payload field tree, returning a list of
    drift findings. Mustache by default; ``engine="jinja"`` walks the jinja2 AST instead
    (:mod:`metaobjects.render.jinja_verify`) and reports the same codes.

    Mustache is context-sensitive: a section ``{{#posts}}…{{/posts}}`` over a container
    field checks its body against that field's element type.
    """
    if engine == TEMPLATE_ENGINE_JINJA:
        from .jinja_verify import verify_jinja

        return verify_jinja(
            template_text, fields, provider=provider,
            required_slots=required_slots, required_tags=required_tags,
        )
    errors: list[VerifyError] = []
    root = fields
    referenced_at_root: set[str] = set()
    # The static text the output-tag check scans: the body plus every
    # provider-resolved partial body, collected during the single walk below
    # (no second resolution pass).
    static_texts: list[str] = [template_text]

    def walk(
        tokens: list[_Token],
        stack: list[list[PayloadField]],
        seen: list[str],
        in_element: bool = False,
    ) -> None:
        at_root = len(stack) == 1 and stack[0] is root
        for tok in tokens:
            if isinstance(tok, _Var):
                if tok.value == ".":
                    continue  # implicit iterator — always valid
                if at_root:
                    referenced_at_root.add(tok.value.split(".")[0])
                if (
                    _resolve(stack, tok.value) is None
                    and not is_boolean_accessor(stack, tok.value)
                    and not is_positional_accessor(in_element, tok.value)
                ):
                    errors.append(VerifyError(ERR_VAR_NOT_ON_PAYLOAD, tok.value))
            elif isinstance(tok, _Section):
                if tok.value == ".":
                    walk(tok.children, stack, seen, in_element)
                    continue
                if at_root:
                    referenced_at_root.add(tok.value.split(".")[0])
                field = _resolve(stack, tok.value)
                if field is None:
                    # A positional `-last` gate is a BOOLEAN on the current element:
                    # it pushes nothing, so the body walks in the SAME scope.
                    if is_positional_accessor(in_element, tok.value):
                        walk(tok.children, stack, seen, in_element)
                        continue
                    # A derived `has<Field>` gate is a BOOLEAN over the current context:
                    # it resolves nothing and pushes nothing, so walk the body in the SAME
                    # scope — what `{{#hasAbilities}}{{#abilities}}…` depends on.
                    if is_boolean_accessor(stack, tok.value):
                        walk(tok.children, stack, seen, in_element)
                        continue
                    # Unresolved section head is itself drift; skip the body (its
                    # context is unknowable, walking it would cascade false errors).
                    errors.append(VerifyError(ERR_VAR_NOT_ON_PAYLOAD, tok.value))
                    continue
                # `^` (inverted) never pushes and never changes whether `-last` is
                # available — it always inherits the enclosing flag unchanged.
                if tok.inverted:
                    walk(tok.children, stack, seen, in_element)
                    continue
                # `#`: an ARRAY section sets the flag explicitly — true only when
                # its elements are objects (there is an element shape to carry
                # `-last` on); an array of scalars rules `-last` OUT here, even
                # when an outer object array enclosed this section. A non-array
                # section (object or scalar conditional) changes nothing of its
                # own — it inherits whatever the enclosing context already had.
                next_in_element = field.fields is not None if field.is_array else in_element
                if field.fields is not None:
                    walk(tok.children, [*stack, field.fields], seen, next_in_element)
                else:
                    walk(tok.children, stack, seen, next_in_element)
            else:  # _Partial
                if provider is None:
                    continue  # can't resolve without a provider
                if tok.value in seen or len(seen) >= MAX_DEPTH:
                    continue  # cycle/depth guard
                body = provider.resolve(tok.value)
                if body is None:
                    errors.append(VerifyError(ERR_PARTIAL_UNRESOLVED, tok.value))
                    continue
                if partial_engine_mismatch(provider, tok.value, TEMPLATE_ENGINE_MUSTACHE):
                    errors.append(VerifyError(ERR_TEMPLATE_ENGINE_UNSUPPORTED, tok.value))
                    continue
                try:
                    partial_tokens = _tokenize(body)
                except MustacheSyntaxError as e:
                    errors.append(VerifyError(ERR_TEMPLATE_SYNTAX, e.section))
                    continue
                static_texts.append(_static_text(body))
                walk(partial_tokens, stack, [*seen, tok.value], in_element)

    try:
        body_tokens = _tokenize(template_text)
    except MustacheSyntaxError as e:
        return [VerifyError(ERR_TEMPLATE_SYNTAX, e.section)]
    static_texts[0] = _static_text(template_text)
    walk(body_tokens, [root], [])

    errors.extend(slot_and_tag_findings(referenced_at_root, static_texts, required_slots, required_tags))
    return errors


def slot_and_tag_findings(
    referenced_at_root: set[str],
    static_texts: list[str],
    required_slots: list[str] | None,
    required_tags: list[str] | None,
) -> list[VerifyError]:
    """The checks that run after either engine's walk: every required slot must have been
    referenced at the payload root, and every required tag must appear (open and close) in
    the body plus its resolved partials."""
    errors: list[VerifyError] = []
    for slot in required_slots or []:
        if slot not in referenced_at_root:
            errors.append(VerifyError(ERR_REQUIRED_SLOT_UNUSED, slot))
    if required_tags:
        # Scan body + resolved partials as one joined string: the open and close
        # forms are located independently, so a tag may legitimately straddle the
        # boundary. The "\n" separator only blocks a spurious tag spliced together
        # from two fragments (a real tag is always contiguous within one body).
        haystack = "\n".join(static_texts)
        for tag in required_tags:
            if not _has_open_tag(haystack, tag) or not _has_close_tag(haystack, tag):
                errors.append(VerifyError(ERR_OUTPUT_TAG_MISSING, tag))
    return errors
