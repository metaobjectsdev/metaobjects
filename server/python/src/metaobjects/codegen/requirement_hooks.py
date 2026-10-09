"""The renderer hook's types for the ``requirement-tests`` generator.

They live in the PACKAGE, beside the identity function, and not in the generator module: an
application that ejects the generator (``metaobjects eject requirement-tests``) copies that
module whole, and a project renderer that imports :class:`RenderedTest` must be handed back to
the owned copy as the SAME class, or the copy's ``isinstance`` check would refuse the renderer
that works against the packaged generator (contract Table L: the hook types stay in the package).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from metaobjects.codegen.requirement_walk import RequirementTestIdentity


@dataclass(frozen=True)
class RequirementTestArgs:
    """What a renderer is handed for one test: the identity plus the prose and the targets."""

    identity: RequirementTestIdentity
    statement: str
    counterexample: str
    #: ``(ref, "<type>.<subType>")`` for the targets this test stands for, ref as authored.
    #: Under the ``concern`` grain: every resolved target of that concern, in authored order,
    #: so one reference authored twice appears twice. Under the ``member`` grain: the one
    #: target of the reference this test is for (a reference authored twice is one test and
    #: keeps its first claim). A requirement that resolves nothing passes ``()``.
    targets: tuple[tuple[str, str], ...]
    disposition: str | None
    tracked_by: tuple[str, ...]


@dataclass(frozen=True)
class RenderedTest:
    """One rendered test: the import statements it needs and its source, no trailing blank lines."""

    #: Complete import statements (``"import json"``), merged into the file's imports.
    imports: tuple[str, ...]
    source: str


#: A renderer replaces the text of one test, or returns ``None`` to keep the default.
RequirementTestRenderer = Callable[[RequirementTestArgs], "RenderedTest | None"]
