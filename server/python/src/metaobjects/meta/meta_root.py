"""MetaRoot — the metadata.root node."""
from __future__ import annotations

from ..naming import NamingRules
from ..wire import WireFormat
from .meta_data import MetaData


class MetaRoot(MetaData):
    def __init__(self, type_: str, sub_type: str, name: str) -> None:
        super().__init__(type_, sub_type, name)
        # ADR-0058 — the ONE project physical-naming setting, read by every resolver
        # via `naming_rules_of()`. Defaults to `NamingRules()` (both `snake_case`) for
        # a root nobody has attached project config to (a hand-built tree, a bare
        # `MetaDataLoader.from_directory()` call with no project). A project-aware
        # load (the CLI's collection ladder, `naming.attach_naming`) overwrites this
        # after loading — never during construction, since the loader seeds an empty
        # root before any file is read.
        self.naming: NamingRules = NamingRules()
        # ADR-0019 Amendment 2 — the project `wire` setting (output form of the generated
        # REST surface), attached by the same project-aware loads as `naming`; read with
        # `wire_of()`. `native` for both keys until a load attaches the project's own.
        self.wire: WireFormat = WireFormat()
