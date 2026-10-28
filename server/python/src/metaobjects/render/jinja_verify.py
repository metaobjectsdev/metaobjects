"""The Jinja half of the template drift check (ADR-0061).

Same contract as the Mustache :func:`~metaobjects.render.verify.verify`: every payload
reference a template makes must exist on the declared payload field tree, or it is
reported. It walks the PARSED jinja2 AST — never the text — and follows what Jinja code
actually does:

* ``{{ user.name }}`` / ``{{ user["name"] }}`` — a path into the payload, checked per segment
* ``{% for p in posts %}{{ p.title }}`` — ``posts`` is checked, then ``p.title`` against
  posts' element fields
* ``{% set x = … %}`` / macro params — locals, not payload; never reported
* ``{{ name | upper }}`` — the argument is checked, the filter is not
* ``{% if %}`` / ``{{ a if b else c }}`` — every operand is checked
* ``{% include "x" %}`` / import / extends — resolved through the provider, walked

A reference the check cannot settle without running the template — a dynamic key on an
object, a computed template name — is ``ERR_TEMPLATE_NOT_STATIC``: reported, never passed.

The TypeScript port (``packages/render/src/jinja/verify.ts``) walks the nunjucks AST to the
same rules; both are held to ``fixtures/jinja-verify-conformance/``. jinja2 is an optional
dependency (the ``jinja`` extra); it is imported only when a Jinja template is checked.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from .engine import JINJA_EXTENSIONS, TEMPLATE_ENGINE_JINJA, partial_engine_mismatch
from .verify import (
    ERR_PARTIAL_UNRESOLVED,
    ERR_TEMPLATE_ENGINE_UNSUPPORTED,
    ERR_TEMPLATE_NOT_STATIC,
    ERR_TEMPLATE_SYNTAX,
    ERR_VAR_NOT_ON_PAYLOAD,
    MAX_DEPTH,
    PayloadField,
    Provider,
    VerifyError,
    slot_and_tag_findings,
)

#: Names a template may use without the payload declaring them: the engines' own globals
#: and block helpers. Shared with the TypeScript port.
JINJA_GLOBALS = frozenset(
    {"range", "cycler", "joiner", "namespace", "dict", "lipsum", "super", "self"}
)

_ELEMENT_FILTERS = frozenset({"first", "last", "random"})
_SAME_SHAPE_FILTERS = frozenset(
    {"sort", "reverse", "list", "unique", "selectattr", "rejectattr", "default", "d"}
)
#: Filters with a positional argument that names an element attribute, and its index among
#: the arguments after the subject (``join(", ", "name")``, ``sort(false, false, "name")``).
#: The same positions in jinja2 and nunjucks; ``min``, ``max`` and ``unique`` are jinja2's.
_ATTRIBUTE_ARG_INDEX = {
    "selectattr": 0,
    "rejectattr": 0,
    "groupby": 0,
    "sum": 0,
    "join": 1,
    "min": 1,
    "max": 1,
    "unique": 1,
    "sort": 2,
}
_ATTRIBUTE_KWARG = "attribute"


def jinja2_module() -> Any:
    """Import jinja2, or explain how to get it. Jinja is an optional extra."""
    try:
        import jinja2
    except ImportError as e:  # pragma: no cover - exercised only without the extra
        raise ImportError(
            "a Jinja template needs jinja2: install metaobjects with the 'jinja' extra "
            "(pip install 'metaobjects[jinja]')"
        ) from e
    return jinja2


def ref_of_template_name(name: str) -> str:
    """The provider ref a Jinja template name addresses: a trailing ``.jinja`` / ``.j2`` /
    ``.jinja2`` is dropped, so ``"parts/footer.jinja"`` and ``"parts/footer"`` agree."""
    lower = name.lower()
    for ext in JINJA_EXTENSIONS:
        if lower.endswith(ext):
            return name[: -len(ext)]
    return name


def parse_jinja(text: str) -> Any:
    """Parse Jinja text into a jinja2 ``nodes.Template``. Raises ``TemplateSyntaxError``."""
    jinja2 = jinja2_module()
    return jinja2.Environment(keep_trailing_newline=True).parse(text)


@dataclass(frozen=True)
class _Typed:
    """A value whose shape the payload declares. ``path`` is the expression as written."""

    fields: list[PayloadField] | None
    is_array: bool
    path: str


_OPAQUE: Any = None  # a local, a literal or a computed value: nothing to check on it


@dataclass
class _Scope:
    frames: list[dict[str, Any]]
    root: list[PayloadField]
    seen: tuple[str, ...] = field(default=())


def _typed_of(f: PayloadField, path: str) -> _Typed:
    return _Typed(f.fields, f.is_array, path)


def _element_of(v: Any, path: str) -> Any:
    if not isinstance(v, _Typed):
        return _OPAQUE
    # An array iterates its elements; a non-array object its keys; a scalar its characters.
    return _Typed(v.fields if v.is_array else None, False, path)


def verify_jinja(
    template_text: str,
    fields: list[PayloadField],
    *,
    provider: Provider | None = None,
    required_slots: list[str] | None = None,
    required_tags: list[str] | None = None,
) -> list[VerifyError]:
    """Check a Jinja template against a payload field tree. Same options and codes as
    :func:`~metaobjects.render.verify.verify`; reached through ``verify(..., engine="jinja")``."""
    jinja2 = jinja2_module()
    nodes = jinja2.nodes
    errors: list[VerifyError] = []
    referenced_at_root: set[str] = set()
    static_texts: list[str] = [template_text]

    def report(code: str, path: str) -> None:
        errors.append(VerifyError(code, path))

    def lookup_name(name: str, scope: _Scope) -> Any:
        for frame in reversed(scope.frames):
            if name in frame:
                return frame[name] if frame[name] is not None else _LOCAL
        hit = next((f for f in scope.root if f.name == name), None)
        if hit is not None:
            if scope.root is fields:
                referenced_at_root.add(name)
            return _typed_of(hit, name)
        return _LOCAL if name in JINJA_GLOBALS else None

    def bind(scope: _Scope, name: str, value: Any) -> None:
        scope.frames[-1][name] = value

    def push_frame(scope: _Scope) -> _Scope:
        return replace(scope, frames=[*scope.frames, {}])

    # ---- member chains -------------------------------------------------------

    def chain_of(node: Any) -> tuple[Any, list[tuple[str, Any]]]:
        segments: list[tuple[str, Any]] = []
        cur = node
        while True:
            if isinstance(cur, nodes.Getattr):
                segments.insert(0, ("key", cur.attr))
                cur = cur.node
            elif isinstance(cur, nodes.Getitem) and not isinstance(cur.arg, nodes.Slice):
                arg = cur.arg
                if isinstance(arg, nodes.Const) and isinstance(arg.value, str):
                    segments.insert(0, ("key", arg.value))
                elif (
                    isinstance(arg, nodes.Const)
                    and isinstance(arg.value, int)
                    and not isinstance(arg.value, bool)
                ):
                    segments.insert(0, ("index", arg.value))
                else:
                    segments.insert(0, ("dynamic", arg))
                cur = cur.node
            else:
                return cur, segments

    def seg_text(kind: str, value: Any) -> str:
        if kind == "key":
            return f".{value}"
        if kind == "index":
            return f"[{value}]"
        return "[*]"

    def eval_chain(node: Any, scope: _Scope) -> Any:
        base, segments = chain_of(node)
        for kind, value in segments:
            if kind == "dynamic":
                eval_expr(value, scope)
        suffix = "".join(seg_text(k, v) for k, v in segments)
        if isinstance(base, nodes.Name):
            path = base.name
            hit = lookup_name(path, scope)
            if hit is None:
                report(ERR_VAR_NOT_ON_PAYLOAD, path + suffix)
                return _OPAQUE
            value_: Any = hit
        else:
            value_ = eval_expr(base, scope)
            path = value_.path if isinstance(value_, _Typed) else ""
        full_path = path + suffix
        for kind, seg in segments:
            if not isinstance(value_, _Typed):
                return _OPAQUE
            path += seg_text(kind, seg)
            if kind == "key":
                child = (
                    None
                    if value_.is_array
                    else next((f for f in value_.fields or [] if f.name == seg), None)
                )
                if child is None:
                    report(ERR_VAR_NOT_ON_PAYLOAD, full_path)
                    return _OPAQUE
                value_ = _typed_of(child, path)
            elif value_.is_array:
                value_ = _Typed(value_.fields, False, path)
            elif kind == "dynamic" and value_.fields is not None:
                report(ERR_TEMPLATE_NOT_STATIC, full_path)
                return _OPAQUE
            else:
                value_ = _Typed(value_.fields, False, path)
        return value_

    # ---- filters, tests, calls ---------------------------------------------

    def check_attribute_name(receiver: Any, attr_node: Any, scope: _Scope) -> None:
        if not isinstance(receiver, _Typed):
            eval_expr(attr_node, scope)
            return
        if not (isinstance(attr_node, nodes.Const) and isinstance(attr_node.value, str)):
            eval_expr(attr_node, scope)
            report(ERR_TEMPLATE_NOT_STATIC, f"{receiver.path}[*]")
            return
        attr = attr_node.value
        current = receiver.fields
        for seg in attr.split("."):
            hit = next((f for f in current or [] if f.name == seg), None)
            if hit is None:
                report(ERR_VAR_NOT_ON_PAYLOAD, f"{receiver.path}.{attr}")
                return
            current = hit.fields

    def eval_extra_args(node: Any, scope: _Scope) -> None:
        for extra in (getattr(node, "dyn_args", None), getattr(node, "dyn_kwargs", None)):
            if extra is not None:
                eval_expr(extra, scope)

    def eval_filter(node: Any, scope: _Scope, subject: Any) -> Any:
        receiver = _OPAQUE if subject is None else eval_expr(subject, scope)
        for i, a in enumerate(node.args):
            if i == _ATTRIBUTE_ARG_INDEX.get(node.name):
                check_attribute_name(receiver, a, scope)
            else:
                eval_expr(a, scope)
        for kw in node.kwargs:
            if kw.key == _ATTRIBUTE_KWARG:
                check_attribute_name(receiver, kw.value, scope)
            else:
                eval_expr(kw.value, scope)
        eval_extra_args(node, scope)
        if node.name in _ELEMENT_FILTERS:
            if isinstance(receiver, _Typed):
                return _element_of(receiver, f"{receiver.path}|{node.name}")
            return _OPAQUE
        if node.name in _SAME_SHAPE_FILTERS:
            return receiver
        return _OPAQUE

    def eval_call(node: Any, scope: _Scope) -> Any:
        callee = node.node
        if isinstance(callee, nodes.Getattr):
            # A method call: the receiver is checked; the method belongs to the value.
            eval_expr(callee.node, scope)
        elif isinstance(callee, nodes.Name):
            if lookup_name(callee.name, scope) is None:
                report(ERR_VAR_NOT_ON_PAYLOAD, callee.name)
        else:
            eval_expr(callee, scope)
        for a in node.args:
            eval_expr(a, scope)
        for kw in node.kwargs:
            eval_expr(kw.value, scope)
        eval_extra_args(node, scope)
        return _OPAQUE

    def walk_callable(args: list[Any], defaults: list[Any], body: list[Any], scope: _Scope) -> None:
        for d in defaults:
            eval_expr(d, scope)  # a default is evaluated where it is declared
        inner = push_frame(scope)
        for local in ("caller", "varargs", "kwargs"):
            bind(inner, local, _OPAQUE)
        for a in args:
            bind(inner, a.name, _OPAQUE)
        walk_all(body, inner)

    # ---- include / import / extends ----------------------------------------

    def follow_template(
        keyword: str, template_node: Any, scope: _Scope, into: Any, ignore_missing: bool = False
    ) -> None:
        if not (isinstance(template_node, nodes.Const) and isinstance(template_node.value, str)):
            eval_expr(template_node, scope)
            report(ERR_TEMPLATE_NOT_STATIC, keyword)
            return
        if provider is None:
            return
        ref = ref_of_template_name(template_node.value)
        if ref in scope.seen or len(scope.seen) >= MAX_DEPTH:
            return
        text = provider.resolve(ref)
        if text is None:
            if not ignore_missing:
                report(ERR_PARTIAL_UNRESOLVED, ref)
            return
        if partial_engine_mismatch(provider, ref, TEMPLATE_ENGINE_JINJA):
            report(ERR_TEMPLATE_ENGINE_UNSUPPORTED, ref)
            return
        static_texts.append(text)
        try:
            ast = parse_jinja(text)
        except jinja2.TemplateSyntaxError as e:
            report(ERR_TEMPLATE_SYNTAX, f"{ref}: {e.message}")
            return
        walk_all(ast.body, into(scope, ref))

    def bind_target(target: Any, value: Any, scope: _Scope) -> None:
        if isinstance(target, nodes.Name):
            bind(scope, target.name, value)
        elif isinstance(target, nodes.NSRef):
            if lookup_name(target.name, scope) is None:
                report(ERR_VAR_NOT_ON_PAYLOAD, target.name)
        else:
            for t in getattr(target, "items", []):
                bind_target(t, _OPAQUE, scope)

    # ---- expressions -------------------------------------------------------

    def eval_expr(node: Any, scope: _Scope) -> Any:
        if isinstance(node, (nodes.Name, nodes.Getattr)) or (
            isinstance(node, nodes.Getitem) and not isinstance(node.arg, nodes.Slice)
        ):
            value = eval_chain(node, scope)
            return None if value is _LOCAL else value
        if isinstance(node, nodes.Getitem):  # a slice keeps the receiver's shape
            receiver = eval_expr(node.node, scope)
            eval_expr(node.arg, scope)
            return receiver
        if isinstance(node, (nodes.Const, nodes.TemplateData)):
            return _OPAQUE
        if isinstance(node, nodes.Filter):
            return eval_filter(node, scope, node.node)
        if isinstance(node, nodes.Test):
            # `x is defined` / `x is divisibleby(3)`: the subject is checked, the test is not.
            eval_expr(node.node, scope)
            for a in node.args:
                eval_expr(a, scope)
            for kw in node.kwargs:
                eval_expr(kw.value, scope)
            eval_extra_args(node, scope)
            return _OPAQUE
        if isinstance(node, nodes.Call):
            return eval_call(node, scope)
        if isinstance(node, nodes.Pair):
            # A dict literal entry: a bare-name key is the key's own spelling, not a lookup.
            if not isinstance(node.key, nodes.Name):
                eval_expr(node.key, scope)
            eval_expr(node.value, scope)
            return _OPAQUE
        for child in node.iter_child_nodes():
            eval_expr(child, scope)
        return _OPAQUE

    # ---- statements --------------------------------------------------------

    def walk_all(body: list[Any], scope: _Scope) -> None:
        for n in body:
            walk(n, scope)

    def walk(node: Any, scope: _Scope) -> None:
        if isinstance(node, nodes.Output):
            for child in node.nodes:
                eval_expr(child, scope)
        elif isinstance(node, nodes.If):
            eval_expr(node.test, scope)
            # An `if` opens no scope: a `set` inside it is visible after it, as in Jinja.
            walk_all(node.body, scope)
            for elif_ in node.elif_:
                walk(elif_, scope)
            walk_all(node.else_, scope)
        elif isinstance(node, nodes.For):
            iterable = eval_expr(node.iter, scope)
            inner = push_frame(scope)
            bind(inner, "loop", _OPAQUE)
            if isinstance(node.target, nodes.Name):
                bind(inner, node.target.name, _element_of(iterable, node.target.name))
            else:
                bind_target(node.target, _OPAQUE, inner)
            if node.test is not None:
                eval_expr(node.test, inner)
            walk_all(node.body, inner)
            walk_all(node.else_, scope)
        elif isinstance(node, nodes.Assign):
            value = eval_expr(node.node, scope)
            if isinstance(node.target, nodes.Name):
                bind(
                    scope,
                    node.target.name,
                    replace(value, path=node.target.name) if isinstance(value, _Typed) else _OPAQUE,
                )
            else:
                bind_target(node.target, _OPAQUE, scope)
        elif isinstance(node, nodes.AssignBlock):
            walk_all(node.body, scope)
            if node.filter is not None:
                eval_filter(node.filter, scope, None)
            bind_target(node.target, _OPAQUE, scope)
        elif isinstance(node, nodes.Macro):
            bind(scope, node.name, _OPAQUE)
            walk_callable(node.args, node.defaults, node.body, scope)
        elif isinstance(node, nodes.CallBlock):
            eval_call(node.call, scope)
            walk_callable(node.args, node.defaults, node.body, scope)
        elif isinstance(node, nodes.FilterBlock):
            walk_all(node.body, scope)
            eval_filter(node.filter, scope, None)
        elif isinstance(node, nodes.Include):
            follow_template(
                "include",
                node.template,
                scope,
                lambda s, ref: replace(push_frame(s), seen=(*s.seen, ref)),
                node.ignore_missing,
            )
        elif isinstance(node, (nodes.Import, nodes.FromImport)):
            with_context = node.with_context
            follow_template(
                "import",
                node.template,
                scope,
                lambda s, ref: _Scope([{}], fields if with_context else [], (*s.seen, ref)),
            )
            if isinstance(node, nodes.Import):
                bind(scope, node.target, _OPAQUE)
            else:
                for n in node.names:
                    bind(scope, n[1] if isinstance(n, tuple) else n, _OPAQUE)
        elif isinstance(node, nodes.Extends):
            follow_template(
                "extends", node.template, scope, lambda s, ref: _Scope([{}], fields, (*s.seen, ref))
            )
        elif isinstance(node, nodes.Block):
            walk_all(node.body, scope)
        elif isinstance(node, nodes.With):
            inner = push_frame(scope)
            for target, value in zip(node.targets, node.values):
                v = eval_expr(value, scope)
                bind_target(target, v if isinstance(v, _Typed) else _OPAQUE, inner)
            walk_all(node.body, inner)
        elif isinstance(node, nodes.Scope):
            walk_all(node.body, push_frame(scope))
        elif isinstance(node, nodes.Stmt):
            for child in node.iter_child_nodes():
                if isinstance(child, nodes.Stmt):
                    walk(child, scope)
                else:
                    eval_expr(child, scope)
        else:
            eval_expr(node, scope)

    try:
        ast = parse_jinja(template_text)
    except jinja2.TemplateSyntaxError as e:
        return [VerifyError(ERR_TEMPLATE_SYNTAX, e.message or str(e))]
    walk_all(ast.body, _Scope([{}], fields))
    errors.extend(
        slot_and_tag_findings(referenced_at_root, static_texts, required_slots, required_tags)
    )
    return errors


class _LocalMarker:
    """A name the template binds itself (or an engine global): resolvable, shapeless."""


_LOCAL: Any = _LocalMarker()


def _spelling_of(node: Any, nodes: Any) -> str | None:
    """The static spelling of a name or member chain (``p.title``, ``posts[0]``,
    ``user[*]``), or ``None``."""
    if isinstance(node, nodes.Name):
        return str(node.name)
    if isinstance(node, nodes.Getattr):
        target = _spelling_of(node.node, nodes)
        return None if target is None else f"{target}.{node.attr}"
    if isinstance(node, nodes.Getitem) and not isinstance(node.arg, nodes.Slice):
        target = _spelling_of(node.node, nodes)
        if target is None:
            return None
        arg = node.arg
        if isinstance(arg, nodes.Const) and isinstance(arg.value, str):
            return f"{target}.{arg.value}"
        if isinstance(arg, nodes.Const) and isinstance(arg.value, int) and not isinstance(arg.value, bool):
            return f"{target}[{arg.value}]"
        return f"{target}[*]"
    return None


def jinja_reference_line(text: str, path: str) -> int | None:
    """The 1-based line ``path`` is first referenced on in Jinja ``text``, for a
    diagnostic's location: the first expression spelled exactly ``path``, else the first
    use of its head name. ``None`` when it does not parse or is not named here."""
    jinja2 = jinja2_module()
    nodes = jinja2.nodes
    head = path.split(".")[0].split("[")[0].split("|")[0]
    try:
        ast = parse_jinja(text)
    except jinja2.TemplateSyntaxError:
        return None
    by_head: int | None = None

    def visit(node: Any) -> int | None:
        nonlocal by_head
        spelled = _spelling_of(node, nodes)
        if spelled == path:
            return int(node.lineno)
        if by_head is None and isinstance(node, nodes.Name) and spelled == head:
            by_head = int(node.lineno)
        for child in node.iter_child_nodes():
            hit = visit(child)
            if hit is not None:
                return hit
        return None

    return visit(ast) or by_head


__all__ = [
    "JINJA_GLOBALS",
    "jinja2_module",
    "jinja_reference_line",
    "parse_jinja",
    "ref_of_template_name",
    "verify_jinja",
]
