"""Write the generator list a CLI test runs, and the argv that runs it.

Since 1.1.0 (ADR-0034 Amendment 9) ``metaobjects gen`` and ``verify --codegen`` run the list in
``metaobjects.config.yaml`` and nothing else: the 1.0 form ``gen <metadata_dir> --out <dir>
--generators a,b`` is refused. Most CLI tests are about something else — the write path, the
manifest, drift, providers — and were written in that 1.0 form. :func:`as_config` turns such an
argv into the config it stood for (one target, ``main``, with that ``outDir`` and those
``generators``) plus the argv that runs it, so each test keeps its own assertions.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import yaml  # type: ignore[import-untyped]  # PyYAML ships no type stubs

#: The file :func:`as_config` writes. Hidden and never auto-discovered: it is passed by
#: ``--config``, so a test that also writes a ``metaobjects.config.yaml`` is not disturbed.
CONFIG_NAME = ".flag-form.config.yaml"

#: The flags that take a value, so their value is not mistaken for the positional.
_VALUE_FLAGS = {
    "--out", "--generators", "--template-spec", "--templates", "--templates-root",
    "--column-naming", "--baseline", "--entities", "--provider", "--package", "--config",
    "--target", "--db", "--prompts",
}


def write_config(
    config_dir: Path,
    out_dir: str | Path,
    generators: list[str],
    *,
    metadata: str | Path | None = None,
    template_spec: str | Path | None = None,
    extra: dict[str, object] | None = None,
    name: str = "metaobjects.config.yaml",
) -> Path:
    """Write a one-target (``main``) config into *config_dir* and return its path."""
    target: dict[str, object] = {"outDir": str(out_dir), "generators": list(generators)}
    if template_spec is not None:
        target["templateSpec"] = str(template_spec)
    raw: dict[str, object] = {}
    if metadata is not None:
        raw["metadata"] = str(metadata)
    raw.update(extra or {})
    raw["targets"] = {"main": target}
    config_dir.mkdir(parents=True, exist_ok=True)
    path = config_dir / name
    path.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    return path


def as_config(argv: list[str], *, extra: dict[str, object] | None = None) -> list[str]:
    """The 1.1.0 equivalent of a 1.0 flag-form ``gen`` / ``verify`` argv.

    ``<metadata_dir>`` becomes the config's ``metadata``, ``--out`` the target's ``outDir``,
    ``--generators`` its ``generators`` and ``--template-spec`` its ``templateSpec`` (a
    ``template-spec.json`` beside the metadata directory, which 1.0 discovered, is declared the
    same way). Every other flag is passed through. The config is written beside ``--out`` (in the
working directory when there is no ``<metadata_dir>``); for
    ``verify`` the positional stays, since the other gates still read it.
    """
    command, rest = argv[0], argv[1:]
    positional: str | None = None
    out: str | None = None
    generators: list[str] = []
    spec: str | None = None
    passed: list[str] = []
    i = 0
    while i < len(rest):
        arg = rest[i]
        flag, eq, inline = arg.partition("=")
        value: str | None = inline if eq else None
        takes_value = flag in _VALUE_FLAGS and not (command == "verify" and flag == "--templates")
        if takes_value and not eq:
            value = rest[i + 1] if i + 1 < len(rest) else None
            i += 1
        i += 1
        if flag == "--out":
            out = value
        elif flag == "--generators":
            generators = [g.strip() for g in (value or "").split(",") if g.strip()]
        elif flag == "--template-spec":
            spec = value
        elif flag.startswith("-"):
            passed.append(arg) if eq or value is None else passed.extend([flag, value])
        elif positional is None:
            positional = arg
        else:
            passed.append(arg)
    if out is None:
        raise ValueError(f"as_config needs --out: {argv}")
    if spec is None and positional is not None:
        discovered = Path(positional).resolve().parent / "template-spec.json"
        if discovered.is_file():
            spec = str(discovered)
    # With no <metadata_dir> the 1.0 run read the location ladder from the directory it ran
    # in, so the config goes there and names no `metadata`: the ladder decides, as it did.
    # That directory must be the test's own: a test that has not changed into its tmp_path
    # would leave the file in the checkout.
    if positional is None and not Path.cwd().resolve().is_relative_to(
        Path(tempfile.gettempdir()).resolve()
    ):
        raise ValueError(f"as_config with no <metadata_dir> needs a temporary cwd: {argv}")
    config = write_config(
        Path(out).resolve().parent if positional is not None else Path.cwd(),
        Path(out).resolve(),
        generators,
        metadata=Path(positional).resolve() if positional is not None else None,
        template_spec=Path(spec).resolve() if spec is not None else None,
        extra=extra,
        name=CONFIG_NAME,
    )
    head = [command] + ([positional] if command == "verify" and positional is not None else [])
    return [*head, "--config", str(config), *passed]
