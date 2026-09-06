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


def test_ruff_format_no_op_when_ruff_absent(monkeypatch) -> None:
    """ruff is a codegen-time convenience, not a runtime requirement — when it's not
    installed, ruff_format returns the source unformatted (still valid Python) rather
    than crashing the whole gen run."""
    import metaobjects.codegen.format as fmt

    monkeypatch.setattr(fmt, "_RUFF_AVAILABLE", False)
    messy = "x={'a':1}\n"
    assert fmt.ruff_format(messy) == messy


def test_killed_ruff_says_it_was_killed_and_names_the_signal(monkeypatch) -> None:
    """A ruff process killed by a signal must not be reported as a source error.

    `_run_ruff` treats a non-zero exit as "ruff rejected the source", which is the
    generator bug `ruff_format`'s docstring describes. But a process killed by a
    signal returns a NEGATIVE code and writes no stderr, so that path produced
    `ruff format failed:` — a message naming neither the cause nor the fact that
    ruff never ran. Observed on a CI box running five lanes at once.
    """
    import subprocess

    import metaobjects.codegen.format as fmt

    def killed(*_a, **_k):
        return subprocess.CompletedProcess(args=[], returncode=-9, stdout="", stderr="")

    monkeypatch.setattr(fmt.subprocess, "run", killed)

    try:
        fmt.ruff_format("x = 1\n")
    except RuntimeError as e:
        msg = str(e)
    else:
        raise AssertionError("expected RuntimeError")

    # It must say the process was killed, and by which signal, so the reader is not
    # left hunting a syntax error in emitted code that ruff never looked at.
    assert "killed" in msg
    assert "9" in msg
    assert msg.rstrip().endswith(")") or "signal" in msg


def test_nonzero_ruff_with_no_stderr_still_names_the_exit_code(monkeypatch) -> None:
    """The other half: a genuine non-zero exit that happens to print nothing must
    still carry its exit code, rather than trailing off after the colon."""
    import subprocess

    import metaobjects.codegen.format as fmt

    def quiet_failure(*_a, **_k):
        return subprocess.CompletedProcess(args=[], returncode=2, stdout="", stderr="")

    monkeypatch.setattr(fmt.subprocess, "run", quiet_failure)

    try:
        fmt.ruff_format("x = 1\n")
    except RuntimeError as e:
        msg = str(e)
    else:
        raise AssertionError("expected RuntimeError")

    assert "2" in msg
    assert not msg.rstrip().endswith(":")
