"""ADR-0063 — the project settings the business-rules vocabulary reads, from the ``rules`` and
``verify`` blocks of ``.metaobjects/config.json``. Every port reads the same keys with the same
defaults. A key that is absent takes its default, which is always the behaviour a project had
before the setting existed: no project declared an operation or a transition before 1.3.0, so
every default here is the safe one. Mirrors TS ``metadata/src/rules-settings.ts``; the reader
lives in ``metaobjects.config.neutral_config`` beside ``naming`` and ``wire``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .meta.meta_data import MetaData

#: ``rules.permissions.names``: how strongly ``verify`` asks for an explicit ``@permission``.
#: ``derive`` (default) says nothing, ``advise`` warns, ``require`` fails the build.
RULES_PERMISSION_NAMES = ("derive", "advise", "require")

#: ``rules.lifecycle.create``: whether a create may start a row in any state (``any``) or only
#: in the initial one (``initial``, default). Read by the enforcing shells.
RULES_LIFECYCLE_CREATE = ("initial", "any")

#: ``rules.lifecycle.commands``: which transitions derive a command of their own.
#: ``unclaimed`` (default): those no declared command lists in ``@transitions``.
RULES_LIFECYCLE_COMMANDS = ("unclaimed", "all", "none")

#: ``verify.lifecycle.unreachable``: the severity of an unreachable state, and of a transition
#: that starts only from unreachable states.
VERIFY_LIFECYCLE_UNREACHABLE = ("warn", "error", "off")


@dataclass(frozen=True)
class RulesSettings:
    """The resolved settings, every absent key at its default. Trusted input: validation
    happens where the raw JSON is parsed (``metaobjects.config.neutral_config``)."""

    permission_names: str = "derive"
    lifecycle_create: str = "initial"
    lifecycle_commands: str = "unclaimed"
    lifecycle_unreachable: str = "warn"


DEFAULT_RULES_SETTINGS = RulesSettings()


def rules_settings_of(node: "MetaData") -> RulesSettings:
    """The :class:`RulesSettings` in force for *node*: the loaded root's, or the defaults for a
    root nobody attached project config to."""
    cur = node
    while cur.parent is not None:
        cur = cur.parent
    settings = getattr(cur, "rules_settings", None)
    return settings if isinstance(settings, RulesSettings) else DEFAULT_RULES_SETTINGS
