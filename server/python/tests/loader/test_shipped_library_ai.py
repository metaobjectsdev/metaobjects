"""The shipped ``ai`` library package resolves through the loader's ``libraries`` opt-in.

Mirrors the TS ``embedded-library.test.ts`` staleness pin and adds the in-port proof
that ``extends: metaobjects::ai::LlmCallBase`` actually resolves — which is the whole
point of shipping the package, and the thing that was unreachable on this port while
the trace-helper generator that consumes it was already registered.

Also pins ADR-0024 FIX #1: the recorder's row keys must equal ``LlmCallBase``'s
effective fields. A recorder writing a column the base does not declare fails at
persist with "Unknown field", and the two drifting apart is invisible until then.
"""
from __future__ import annotations

import importlib
import sys
import textwrap
from pathlib import Path

import pytest

from metaobjects import LoadResult, MetaDataLoader, load_directory
from metaobjects.errors import ErrorCode
from metaobjects.library import library_sources
from metaobjects.library.embedded_library import EMBEDDED_LIBRARY
from metaobjects.runtime import LlmCallInput
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT

ADOPTER_YAML = textwrap.dedent(
    """\
    metadata:
      package: app::trace
      children:
        - object.entity:
            name: AdopterCall
            extends: metaobjects::ai::LlmCallBase
            children:
              - source.rdb:       { table: adopter_call, role: primary }
              - identity.primary: { name: id, fields: ["spanId"] }
    """
)


def _repo_root() -> Path | None:
    for candidate in Path(__file__).resolve().parents:
        if (candidate / "library").is_dir() and (candidate / "server").is_dir():
            return candidate
    return None


@pytest.fixture
def adopter_dir(tmp_path: Path) -> Path:
    (tmp_path / "meta.app.yaml").write_text(ADOPTER_YAML, encoding="utf-8")
    return tmp_path


def _entity(result: LoadResult, name: str) -> MetaObject | None:
    """Find a top-level object (entity/value) by name in the loaded root.

    Every node reached in this test's fixtures is a package-level object.entity /
    object.value declaration, so root's own children (no recursion needed) is
    the whole search space — same idiom as ``_find_author_entity`` in
    ``tests/integration/generated_router_app.py``.
    """
    for child in result.root.children():
        if child.type == TYPE_OBJECT and isinstance(child, MetaObject) and child.name == name:
            return child
    return None


class TestTheEmbeddedModuleTracksTheCanonicalYaml:
    """The generated module is the only copy a wheel ships, so a stale one means an
    installed package silently disagrees with the repo."""

    def test_every_canonical_file_is_embedded_byte_identically(self) -> None:
        root = _repo_root()
        if root is None:
            pytest.skip("no repo-root library/ (installed layout) — nothing to compare")

        on_disk = {
            path.relative_to(root / "library").with_suffix("").as_posix(): path.read_text(
                encoding="utf-8"
            )
            for path in sorted((root / "library").rglob("*.yaml"))
        }

        assert on_disk, "repo-root library/ has no YAML — the generator would emit nothing"
        assert set(on_disk) == set(EMBEDDED_LIBRARY), (
            "embedded library is stale — run scripts/generate_embedded_library.py"
        )
        for ref, text in on_disk.items():
            assert EMBEDDED_LIBRARY[ref] == text, f"embedded ref {ref!r} differs from the canonical file"


class TestTheAiLibraryIsOptIn:
    def test_without_the_opt_in_the_base_is_unresolvable(self, adopter_dir: Path) -> None:
        """The failure this feature exists to remove — and proof the opt-in is doing
        the work rather than the base leaking in by some other path."""
        result = load_directory(adopter_dir)

        assert ErrorCode.ERR_UNRESOLVED_SUPER in [e.code for e in result.errors]

    def test_with_the_opt_in_the_adopter_inherits_the_base(self, adopter_dir: Path) -> None:
        result = load_directory(adopter_dir, libraries=["ai"])

        assert not result.errors
        entity = _entity(result, "AdopterCall")
        assert entity is not None
        assert entity.super_data is not None
        assert entity.super_data.name == "LlmCallBase"
        assert len(entity.fields()) == 18

    def test_an_unknown_package_contributes_nothing_rather_than_raising(self) -> None:
        """A consumer asking for a package this version does not ship should still be
        able to load its own metadata."""
        assert library_sources(["no-such-package"]) == []


class TestRecorderAndBaseAgree:
    """ADR-0024 FIX #1 — one canonical base whose fields are exactly the row keys."""

    def test_row_keys_equal_the_base_fields(self, adopter_dir: Path) -> None:
        from metaobjects.runtime.llm_recorder import LlmCallInput, build_llm_call_row

        result = load_directory(adopter_dir, libraries=["ai"])
        base = _entity(result, "LlmCallBase")
        assert base is not None

        row_keys = set(
            build_llm_call_row(
                LlmCallInput(
                    span_id="s",
                    trace_id="t",
                    call_type="chat",
                    started_at="2026-01-01T00:00:00Z",
                    llm_request={"prompt": "hi"},
                    llm_response_text="ok",
                    status="ok",
                    error_detail=None,
                )
            ).keys()
        )
        base_fields = {f.name for f in base.fields()}

        assert row_keys - base_fields == set(), "recorder writes a column the base does not declare"
        assert base_fields - row_keys == set(), "base declares a column the recorder never writes"


class TestSourcesResolveOnDiskFirst:
    def test_a_checkout_serves_the_canonical_file_not_the_embed(self) -> None:
        """So editing the canonical YAML takes effect without regenerating."""
        if _repo_root() is None:
            pytest.skip("no repo-root library/ (installed layout)")

        sources = library_sources(["ai"])

        assert len(sources) == len(EMBEDDED_LIBRARY)
        assert all("library:" not in s.id for s in sources), "expected on-disk FileSource in a checkout"


def test_the_loader_prepends_library_sources(adopter_dir: Path) -> None:
    """A base must merge before the metadata that inherits from it."""
    loader = MetaDataLoader()
    sources = library_sources(["ai"])

    assert sources, "the ai package must contribute at least one source"
    assert not loader.load(sources).errors


TRACE_ADOPTER_YAML = textwrap.dedent(
    """\
    metadata:
      package: app::trace
      children:
        - object.value:
            name: GreetingResponse
            children:
              - field.string: { name: greeting }
        - object.entity:
            name: GreetingCall
            extends: metaobjects::ai::LlmCallBase
            children:
              - source.rdb:       { table: greeting_call, role: primary }
              - identity.primary: { name: id, fields: ["spanId"] }
              # Typed columns are AUTHORED, never derived (ADR-0024 amendment).
              # The generated helper writes BOTH unconditionally, so an adopter
              # that declares neither gets code that raises on its first write.
              - field.object:
                  name: voRequest
                  objectRef: GreetingResponse
                  storage: jsonb
              - field.object:
                  name: voResponse
                  objectRef: GreetingResponse
                  storage: jsonb
              - template.prompt:
                  name: GreetingPrompt
                  payloadRef: GreetingResponse
                  responseRef: GreetingResponse
                  textRef: greeting/ask
                  format: json
    """
)


def test_the_trace_helper_generator_fires_off_the_SHIPPED_base(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The acceptance test for this port: the documented path, end to end.

    ADR-0024 recorded that the trace-helper tests "pass only because they bypass the
    shipped base with bespoke entities" — and on this port they still do: the codegen
    suite hand-builds its own abstract ``LlmCallBase``. So a generator that works
    against a fixture proved nothing about the path an adopter actually follows, which
    is how a generator came to ship on a port that could not load its input at all.

    This drives the generator from the REAL library metadata instead.
    """
    from metaobjects.codegen.config import GenConfig
    from metaobjects.codegen.generator import GenContext
    from metaobjects.codegen.generators.trace_helper_generator import TraceHelperGenerator

    (tmp_path / "meta.app.yaml").write_text(TRACE_ADOPTER_YAML, encoding="utf-8")
    result = load_directory(tmp_path, libraries=["ai"])
    assert not result.errors, [f"{e.code}: {e.message}" for e in result.errors]

    files = TraceHelperGenerator().generate(
        GenContext(
            entities=[],
            loaded_root=result.root,
            matches=lambda _e: True,
            config=GenConfig(out_dir=str(tmp_path / "out")),
            warn=lambda _m: None,
        )
    )

    emitted = {Path(f.path).name: f.content for f in files}
    assert "record_greeting_call.py" in emitted, f"expected a helper, got {list(emitted)}"

    # RUN the helper rather than grepping its source. An earlier version of this
    # test asserted the strings "voRequest"/"voResponse" appeared in the emitted
    # code, which passed against a fixture declaring neither column — so it
    # blessed a helper that raises on its first write. Substring assertions are
    # exactly the bypass ADR-0024 warns about; this executes the path instead.
    pkg_dir = tmp_path / "_trace_pkg"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").touch()
    for f in files:
        (pkg_dir / Path(f.path).name).write_text(f.content, encoding="utf-8")

    monkeypatch.syspath_prepend(str(tmp_path))
    for name in [k for k in sys.modules if k == "_trace_pkg" or k.startswith("_trace_pkg.")]:
        del sys.modules[name]
    module = importlib.import_module("_trace_pkg.record_greeting_call")

    captured: list[dict[str, object]] = []

    class CapturingRecorder:
        def record(self, row: dict[str, object]) -> None:
            captured.append(row)

    outcome = module.record_greeting_call(
        CapturingRecorder(),
        LlmCallInput(
            span_id="11111111-1111-4111-8111-111111111111",
            trace_id="22222222-2222-4222-8222-222222222222",
            call_type="greeting",
            started_at="2023-11-14T17:13:20+00:00",
            llm_request={"prompt": "say hi"},
            llm_response_text='{"greeting": "hello"}',
            status="ok",
            error_detail=None,
        ),
    )

    assert outcome.status == "ok", outcome.error_detail
    assert len(captured) == 1, "the helper must persist exactly once"
    row = captured[0]

    # The typed columns are the whole point of the feature — and every key the
    # helper writes must be a field the entity declares, or ObjectManager raises
    # "no field '<name>' in metadata" on insert.
    assert row["voResponse"] == {"greeting": "hello"}
    assert row["voRequest"] == {"prompt": "say hi"}

    entity = _entity(result, "GreetingCall")
    assert entity is not None
    declared = {f.name for f in entity.fields()}
    assert set(row) <= declared, f"helper writes undeclared columns: {set(row) - declared}"


class TestTheCliCanLoadTheLibrary:
    """The adopter path is `metaobjects gen`, not a Python import.

    `libraries` first landed only on `MetaDataLoader.from_directory`, so the CLI —
    which is where the registered `trace-helper` generator is actually reachable —
    still could not load the metadata that generator exists to consume. The
    in-process acceptance test could not see that, because it never went through
    the CLI's load path.
    """

    def _config(self, tmp_path: Path, libraries_line: str) -> Path:
        (tmp_path / "metadata").mkdir()
        (tmp_path / "metadata" / "meta.app.yaml").write_text(ADOPTER_YAML, encoding="utf-8")
        config = tmp_path / "metaobjects.config.yaml"
        config.write_text(
            "metadata: metadata\n"
            f"{libraries_line}"
            "targets:\n"
            "  main:\n"
            "    outDir: out\n",
            encoding="utf-8",
        )
        return config

    def test_the_cli_load_path_resolves_the_shipped_base(self, tmp_path: Path) -> None:
        from metaobjects.cli import _load_root
        from metaobjects.codegen.project_config import load_project_config

        config = load_project_config(self._config(tmp_path, 'libraries: ["ai"]\n'))
        root, errors = _load_root(config.metadata_dir(), libraries=config.libraries)

        assert errors == []
        assert root is not None

    def test_without_the_config_key_the_cli_still_fails(self, tmp_path: Path) -> None:
        """Pins that the opt-in is what fixes it — not something else in the CLI."""
        from metaobjects.cli import _load_root
        from metaobjects.codegen.project_config import load_project_config

        config = load_project_config(self._config(tmp_path, ""))
        root, errors = _load_root(config.metadata_dir(), libraries=config.libraries)

        assert root is None
        assert any("ERR_UNRESOLVED_SUPER" in e for e in errors)

    def test_a_typo_in_the_config_fails_loudly(self, tmp_path: Path) -> None:
        """A silent skip would resurface as ERR_UNRESOLVED_SUPER against the
        adopter's own metadata — the wrong place to go looking."""
        from metaobjects.codegen.project_config import ConfigError, load_project_config

        with pytest.raises(ConfigError, match="unknown package"):
            load_project_config(self._config(tmp_path, 'libraries: ["ai-trace"]\n'))
