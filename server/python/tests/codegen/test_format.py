from metaobjects.codegen.format import ruff_format


def test_ruff_format_canonicalizes():
    messy = "x={'a':1,'b':2}\n"
    out = ruff_format(messy)
    assert out == 'x = {"a": 1, "b": 2}\n'


def test_ruff_format_is_idempotent():
    src = "y = [1, 2, 3]\n"
    assert ruff_format(ruff_format(src)) == ruff_format(src)
