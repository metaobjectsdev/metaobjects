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

The tokenizer models only plain interpolation, sections, inverted sections, and
partials (matching the C# port). It deliberately does NOT model Mustache
set-delimiter directives (``{{=<% %>=}}``); the TS engine parses with the real
``mustache`` library, so a fixture using set-delimiters would diverge across
ports. The corpus uses only plain tags — keep it that way.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

#: A ``{{var}}`` references a field the (contextual) payload does not declare.
ERR_VAR_NOT_ON_PAYLOAD = "ERR_VAR_NOT_ON_PAYLOAD"
#: A ``{{> ref}}`` partial does not resolve in the provider.
ERR_PARTIAL_UNRESOLVED = "ERR_PARTIAL_UNRESOLVED"
#: A declared @requiredSlots slot is never referenced by the template (warning).
ERR_REQUIRED_SLOT_UNUSED = "ERR_REQUIRED_SLOT_UNUSED"

_MAX_DEPTH = 32


@dataclass(frozen=True)
class PayloadField:
    """A plain field-tree node mirroring an ``object.value`` view-object's walk.

    ``fields`` present → a context-pushing field (object / array-of-object);
    ``fields is None`` → a scalar (string/number/boolean/scalar-array).
    """

    name: str
    fields: list[PayloadField] | None = None


@dataclass(frozen=True)
class VerifyError:
    """A single drift finding: a code + the offending var path / partial ref / slot."""

    code: str
    path: str


class Provider(Protocol):
    """Resolves a ``{{> group/source}}`` partial ref to its body text, or ``None``."""

    def resolve(self, ref: str) -> str | None: ...


class InMemoryProvider:
    """A :class:`Provider` backed by a dict of ref → body text."""

    def __init__(self, partials: dict[str, str] | None = None) -> None:
        self._partials = dict(partials or {})

    def resolve(self, ref: str) -> str | None:
        return self._partials.get(ref)


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
    tokens, _ = _parse_tokens(text, 0)
    return tokens


def _parse_tokens(text: str, pos: int) -> tuple[list[_Token], int]:
    """Parse tokens until EOF or a matching ``{{/close}}`` (which is consumed)."""
    tokens: list[_Token] = []
    while pos < len(text):
        open_idx = text.find("{{", pos)
        if open_idx < 0:
            break  # remainder is plain text
        triple = open_idx + 2 < len(text) and text[open_idx + 2] == "{"
        close_delim = "}}}" if triple else "}}"
        content_start = open_idx + (3 if triple else 2)
        close_idx = text.find(close_delim, content_start)
        if close_idx < 0:
            break  # malformed; stop
        content = text[content_start:close_idx].strip()
        pos = close_idx + len(close_delim)

        if triple:
            tokens.append(_Var(content))
            continue
        if not content:
            continue

        sigil = content[0]
        name = content[1:].strip() if len(content) > 1 else ""
        if sigil == "!":
            continue  # comment
        if sigil in ("#", "^"):
            children, pos = _parse_tokens(text, pos)
            tokens.append(_Section(name, sigil == "^", children))
        elif sigil == "/":
            return tokens, pos  # close (matched or mismatched) ends this level
        elif sigil == ">":
            tokens.append(_Partial(name))
        elif sigil == "&":
            tokens.append(_Var(name))
        else:
            tokens.append(_Var(content))  # {{x}}, {{x.y}}, {{.}}
    return tokens, pos


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


def verify(
    template_text: str,
    fields: list[PayloadField],
    *,
    provider: Provider | None = None,
    required_slots: list[str] | None = None,
) -> list[VerifyError]:
    """Walk a Mustache template's tokens against a payload field tree, returning a
    list of drift findings. Context-sensitive: a section ``{{#posts}}…{{/posts}}``
    over a container field checks its body against that field's element type.
    """
    errors: list[VerifyError] = []
    root = fields
    referenced_at_root: set[str] = set()

    def walk(
        tokens: list[_Token], stack: list[list[PayloadField]], seen: list[str]
    ) -> None:
        at_root = len(stack) == 1 and stack[0] is root
        for tok in tokens:
            if isinstance(tok, _Var):
                if tok.value == ".":
                    continue  # implicit iterator — always valid
                if at_root:
                    referenced_at_root.add(tok.value.split(".")[0])
                if _resolve(stack, tok.value) is None:
                    errors.append(VerifyError(ERR_VAR_NOT_ON_PAYLOAD, tok.value))
            elif isinstance(tok, _Section):
                if tok.value == ".":
                    walk(tok.children, stack, seen)
                    continue
                if at_root:
                    referenced_at_root.add(tok.value.split(".")[0])
                field = _resolve(stack, tok.value)
                if field is None:
                    # Unresolved section head is itself drift; skip the body (its
                    # context is unknowable, walking it would cascade false errors).
                    errors.append(VerifyError(ERR_VAR_NOT_ON_PAYLOAD, tok.value))
                    continue
                # `#` over a container pushes its element fields; `^` (and `#` over a
                # scalar, used as a conditional) keep the current context.
                if not tok.inverted and field.fields is not None:
                    walk(tok.children, [*stack, field.fields], seen)
                else:
                    walk(tok.children, stack, seen)
            else:  # _Partial
                if provider is None:
                    continue  # can't resolve without a provider
                if tok.value in seen or len(seen) >= _MAX_DEPTH:
                    continue  # cycle/depth guard
                body = provider.resolve(tok.value)
                if body is None:
                    errors.append(VerifyError(ERR_PARTIAL_UNRESOLVED, tok.value))
                    continue
                walk(_tokenize(body), stack, [*seen, tok.value])

    walk(_tokenize(template_text), [root], [])

    for slot in required_slots or []:
        if slot not in referenced_at_root:
            errors.append(VerifyError(ERR_REQUIRED_SLOT_UNUSED, slot))

    return errors
