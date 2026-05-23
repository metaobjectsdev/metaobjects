from metaobjects.codegen.format import ruff_format


def test_ruff_format_canonicalizes() -> None:
    messy = "x={'a':1,'b':2}\n"
    out = ruff_format(messy)
    assert out == 'x = {"a": 1, "b": 2}\n'


def test_ruff_format_is_idempotent() -> None:
    src = "y = [1, 2, 3]\n"
    assert ruff_format(ruff_format(src)) == ruff_format(src)


def test_ruff_format_sorts_imports() -> None:
    # stdlib before third-party before first-party-relative (PEP 8 / isort groups).
    src = "from .local import L\nimport os\n\nfrom pydantic import BaseModel\n"
    out = ruff_format(src)
    assert out.index("import os") < out.index("from pydantic") < out.index("from .local import L")
