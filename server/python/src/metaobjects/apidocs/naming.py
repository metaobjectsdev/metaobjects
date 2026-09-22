"""The Python codegen NAMING SEAM — the single source of truth for every
generated identifier the api-docs builder documents.

This mirrors the Java ``SpringNaming`` / C# ``CSharpNaming`` pattern: the real
generators delegate their name computation here, and the
:class:`~metaobjects.apidocs.builder.PythonApiModelBuilder` enumerates symbols by
calling the SAME functions. So the documented name can never drift from the
emitted name — they are computed once, in one place.

Behaviour-preserving with ONE deliberate exception: :func:`route_path` no longer
reproduces the old inline ``name.lower() + "s"``, because that spelling diverged
from the other ports (see its docstring). Every other function reproduces exactly
what the corresponding generator used to compute inline (``_snake_case`` /
``<Name>Repository`` / ``<ENTITY>_FILTER_FIELDS`` / ``parse_<snake>`` /
``render_<snake>`` / ``render_<snake>_format`` / ``extract_<snake>`` …). A model's
class name — which, the generated package being flat, is also its module name — comes
from :mod:`metaobjects.codegen.value_objects`, the module the entity generator itself
asks (ADR-0056: a template's payload and response types ARE its value objects' models).
"""
from __future__ import annotations

from metaobjects.codegen import value_objects
from metaobjects.meta.meta_data import MetaData
from metaobjects.naming import to_snake_case

__all__ = [
    "snake_case",
    "pluralize",
    "model_class_name",
    "router_module_name",
    "repository_class_name",
    "filter_allowlist_module_name",
    "filter_fields_const",
    "filter_ops_const",
    "route_path",
    "pk_param",
    "model_import",
    "render_helper_fn",
    "output_prompt_fn",
    "output_parser_fn",
    "extractor_fn",
    "reverse_finder_fk_segment",
    "reverse_finder_fn",
    "reverse_finder_in_fn",
]


def snake_case(name: str) -> str:
    """``Author`` → ``author``; ``AuthorBrief`` → ``author_brief``.

    Trivial PascalCase → snake_case (no acronym handling) — the canonical form
    every sibling generator computes inline. Owning it here keeps the file name
    (``author_router.py``), the path-param (``/{author_id}``), and the documented
    names in lock-step."""
    out: list[str] = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


def _route_snake_case(name: str) -> str:
    """``PostCategory`` → ``post_category``; ``HTTPServer`` → ``http_server``.

    ACRONYM-AWARE, and deliberately NOT :func:`snake_case`. The trivial variant
    above inserts a separator before every capital, which is right for a module
    name but would emit ``h_t_t_p_server`` in a URL. Delegates to
    :func:`metaobjects.naming.to_snake_case` — the port's acronym-aware loop,
    documented there as byte-for-byte the other ports' rule (separate when the
    previous character is lower or a digit, or when it is upper and the NEXT one
    is lower, so a run of capitals stays together until the final one that
    begins a word)."""
    return to_snake_case(name)


def pluralize(name: str) -> str:
    """``post_category`` → ``post_categories``; ``address`` → ``addresses``.

    The cross-port pluralization contract, byte-identical in every port: a word
    ending ``s``/``x``/``z``/``ch``/``sh`` takes ``es``; a consonant followed by
    ``y`` becomes ``ies``; anything else takes ``s``. The cross-port
    byte-identity covers the already-lowercased word :func:`route_path` feeds
    in — suffix tests here run on a lowercased copy, unlike the JVM port's
    case-sensitive ones, so mixed-case input may diverge."""
    lowered = name.lower()
    if lowered.endswith(("s", "x", "z", "ch", "sh")):
        return name + "es"
    if len(name) >= 2 and lowered[-1] == "y" and lowered[-2] not in "aeiou":
        return name[:-1] + "ies"
    return name + "s"


def model_class_name(obj: MetaData) -> str:
    """The emitted Pydantic model class name — the object's own short name, or a value
    object's collision-qualified one (ADR-0044/0056)."""
    return value_objects.model_class_name(obj)


def model_import(obj: MetaData) -> str:
    """``from .<Name> import <Name>`` — the import of *obj*'s generated model (the entity
    generator writes ``<Name>.py``, so the module IS the class name)."""
    return value_objects.model_import(obj)


def router_module_name(obj_name: str) -> str:
    """``Author`` → ``author_router`` (the emitted FastAPI router module, no ``.py``)."""
    return f"{snake_case(obj_name)}_router"


def repository_class_name(obj_name: str) -> str:
    """``Author`` → ``AuthorRepository`` (the consumer-implemented repo ``Protocol``)."""
    return f"{obj_name}Repository"


def filter_allowlist_module_name(obj_name: str) -> str:
    """``Author`` → ``author_filter_allowlist`` (the emitted allowlist module)."""
    return f"{snake_case(obj_name)}_filter_allowlist"


def filter_fields_const(obj_name: str) -> str:
    """``Author`` → ``AUTHOR_FILTER_FIELDS`` (the filterable-field frozenset const)."""
    return f"{obj_name.upper()}_FILTER_FIELDS"


def filter_ops_const(obj_name: str) -> str:
    """``Author`` → ``AUTHOR_FILTER_OPS_BY_FIELD`` (the per-field op-vocabulary const)."""
    return f"{obj_name.upper()}_FILTER_OPS_BY_FIELD"


def route_path(obj_name: str) -> str:
    """The default REST collection segment — the ENTITY NAME ``snake_case``d and
    then pluralized (``Author`` → ``authors``, ``PostCategory`` →
    ``post_categories``). Never the physical ``@table``.

    One rule, identical in all five ports. It used to be ``name.lower() + "s"``
    here, which served ``PostCategory`` at ``/postcategorys``; see
    ``fixtures/api-contract-conformance/m2m/`` for the scenario that gates it."""
    return pluralize(_route_snake_case(obj_name))


def pk_param(obj_name: str) -> str:
    """``Author`` → ``author_id`` (the path-parameter name on item routes)."""
    return f"{snake_case(obj_name)}_id"


def render_helper_fn(template_name: str) -> str:
    """``OrderSummary`` → ``render_order_summary`` (the typed render helper fn)."""
    return f"render_{snake_case(template_name)}"


def output_prompt_fn(template_name: str) -> str:
    """``OrderSummary`` → ``render_order_summary_format`` (the output-format prompt fn)."""
    return f"render_{snake_case(template_name)}_format"


def output_parser_fn(template_name: str) -> str:
    """``OrderSummary`` → ``parse_order_summary`` (the strict output parser fn)."""
    return f"parse_{snake_case(template_name)}"


def extractor_fn(template_name: str) -> str:
    """``OrderSummary`` → ``extract_order_summary`` (the strict extractor fn)."""
    return f"extract_{snake_case(template_name)}"


# ---------------------------------------------------------------------------
# ADR-0038 — reverse-relationship navigation as explicit FK finders.
#
# For each FK an entity ``E`` holds (an ``identity.reference`` over an FK field
# referencing entity ``T``), ``E``'s repository surface gains a finder returning
# the ``E`` rows matching a given ``T`` id — so ``T`` navigates to its referencing
# ``E`` rows by calling the finder with a ``T`` id. Two variants: a single-value
# finder and a batched (anti-N+1) ``…_in`` finder. Both are plain, framework-free
# single queries (``WHERE <fk> = ?`` / ``WHERE <fk> IN (…)``) — NOT lazy ORM
# collections (ADR-0038: lazy collections are impossible framework-free and are
# the canonical N+1 anti-pattern).
#
# CANONICAL NAMING (the cross-port contract — idiomatic Python snake_case spelling
# of the cross-port shape ``find<EPlural>By<FkField>`` / ``…In``):
#
#   find_<e_plural>_by_<fk_segment>(value)     → SELECT … FROM E WHERE <fk> = ?
#   find_<e_plural>_by_<fk_segment>_in(values) → SELECT … FROM E WHERE <fk> IN (…)
#
# where:
#   - <e_plural>   is the source entity name pluralized then snake_cased
#     (``GameSession`` → ``game_sessions``).
#   - <fk_segment> is the FK FIELD name (NOT the relationship/navigation name and
#     NOT the raw column), snake_cased, with a single trailing ``_id`` dropped if
#     present. The FK field name is unique within an entity, so the finder name is
#     unique by construction — this dissolves the same-pair collision and removes
#     any need for a naming attribute.
#
# SAME-PAIR EXAMPLE (``GameSession`` has THREE FKs to ``Scene``):
#   FK field ``currentSceneId``               → find_game_sessions_by_current_scene
#   FK field ``lastOpeningNarrativeSceneId``  → find_game_sessions_by_last_opening_narrative_scene
#   FK field ``transitioningFromSceneId``     → find_game_sessions_by_transitioning_from_scene
# Three distinct finders — no collision.
# ---------------------------------------------------------------------------


def _pluralize(name: str) -> str:
    """Trivial cross-port pluralization (matches the TS ``pluralize`` /
    ``MetaSource._pluralize``), applied to a PascalCase entity name BEFORE
    snake-casing (``GameSession`` → ``GameSessions``).

    Delegates to :func:`pluralize` so this file states the cross-port inflector
    contract once, not twice; the empty-string guard stays here because it is
    this finder-naming helper's own contract, not ``pluralize``'s."""
    if not name:
        return name
    return pluralize(name)


def reverse_finder_fk_segment(fk_field_name: str) -> str:
    """Lower an FK field name to the ``<fk_segment>`` of a reverse finder name:
    snake_case the field, then drop a single trailing ``_id`` if present.
    E.g. ``currentSceneId`` → ``current_scene``, ``authorId`` → ``author``,
    ``scene`` → ``scene``."""
    snake = snake_case(fk_field_name)
    # Drop a single trailing "_id" (but not a bare "id" — that would yield "").
    if len(snake) > 3 and snake.endswith("_id"):
        return snake[:-3]
    return snake


def reverse_finder_fn(source_entity_name: str, fk_field_name: str) -> str:
    """Reverse single-value finder name: ``find_<e_plural>_by_<fk_segment>``."""
    e_plural = snake_case(_pluralize(source_entity_name))
    return f"find_{e_plural}_by_{reverse_finder_fk_segment(fk_field_name)}"


def reverse_finder_in_fn(source_entity_name: str, fk_field_name: str) -> str:
    """Reverse batched finder name: ``find_<e_plural>_by_<fk_segment>_in``."""
    return f"{reverse_finder_fn(source_entity_name, fk_field_name)}_in"
