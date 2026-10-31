"""docs/features/adopting-existing-models.md, end to end, on examples/brownfield/pydantic.

Each test does what the recipe tells an agent to do: generate beside the existing models, prove
the two match with `model_json_schema()`, see the proof fail on a deliberate mismatch, move one
call site, then retire the old models. No MetaObjects command reads the project's source.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

EXAMPLE = Path(__file__).resolve().parents[4] / "examples" / "brownfield" / "pydantic"


def run(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, *args],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )


def metaobjects(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return run(root, "-m", "metaobjects.cli", *args)


def proof(root: Path) -> subprocess.CompletedProcess[str]:
    return run(root, "-m", "pytest", "proof", "-vv", "-p", "no:cacheprovider")


def edit(root: Path, name: str, old: str, new: str) -> None:
    path = root / name
    text = path.read_text()
    assert old in text
    path.write_text(text.replace(old, new))


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    shutil.copytree(EXAMPLE, root, ignore=shutil.ignore_patterns("__pycache__", "generated", ".metaobjects"))
    generated = metaobjects(root, "gen")
    assert generated.returncode == 0, generated.stderr
    return root


def test_generated_models_match_and_the_recipe_runs_to_retiring_the_old_ones(project: Path) -> None:
    proved = proof(project)
    assert proved.returncode == 0, proved.stdout

    # One call site moves. The other still imports the hand-written models, and both load.
    edit(
        project,
        "app/signup.py",
        "from app.models import Customer, CustomerCreate",
        "from generated.Customer import Customer, CustomerCreate",
    )
    assert run(project, "-c", "import app.signup, app.shipping").returncode == 0

    # A generated model's instance is not the hand-written class, so nested models move together.
    refused = run(
        project,
        "-c",
        "import app.models, generated.ShippingAddress as g, uuid, datetime;"
        "app.models.Order(id=1, customer_id=uuid.uuid4(), total=1, placed_on=datetime.date.today(),"
        " shipping_address=g.ShippingAddress(line1='a', city='b'))",
    )
    assert refused.returncode != 0
    assert "valid dictionary or instance of ShippingAddress" in refused.stderr

    edit(
        project,
        "app/shipping.py",
        "from app.models import Order, OrderStatus, ShippingAddress",
        "from generated.enums import OrderStatus\n"
        "from generated.Order import Order\n"
        "from generated.ShippingAddress import ShippingAddress",
    )
    (project / "app" / "models.py").unlink()
    shutil.rmtree(project / "proof")
    assert run(project, "-c", "import app.signup, app.shipping").returncode == 0
    verified = metaobjects(project, "verify")
    assert verified.returncode == 0, verified.stderr


def test_proof_fails_naming_the_field_when_the_existing_model_differs(project: Path) -> None:
    edit(project, "app/models.py", "    loyalty_points: int = 0\n    marketing_opt_in: bool = False\n    notes: Optional[str] = None\n    created_at", "    loyalty_points: str = '0'\n    marketing_opt_in: bool = False\n    notes: Optional[str] = None\n    created_at")
    failed = proof(project)
    assert failed.returncode == 1
    assert "loyalty_points" in failed.stdout
    assert "test_same_shape" in failed.stdout


def test_proof_catches_a_rule_the_python_type_does_not_carry(project: Path) -> None:
    edit(project, "app/models.py", "email: str = Field(max_length=254)\n    display_name: str = Field(max_length=120)\n    loyalty", "email: str = Field(max_length=100)\n    display_name: str = Field(max_length=120)\n    loyalty")
    failed = proof(project)
    assert failed.returncode == 1
    assert "maxLength" in failed.stdout


def test_proof_catches_a_model_that_lost_a_field_on_a_nested_type(project: Path) -> None:
    edit(project, "metaobjects/meta.shop.yaml", "          - field.string: { name: postcode }\n", "")
    regenerated = metaobjects(project, "gen")
    assert regenerated.returncode == 0, regenerated.stderr
    failed = proof(project)
    assert failed.returncode == 1
    assert "postcode" in failed.stdout


def test_a_str_enum_and_a_literal_compare_equal(project: Path) -> None:
    """The model may declare the enum inline, which generates a Literal. The proof must not
    report that as a difference: both accept and write the same strings."""
    edit(
        project,
        "metaobjects/meta.shop.yaml",
        "- field.enum: { name: status, extends: OrderStatus, required: true, default: pending }",
        "- field.enum: { name: status, values: [pending, paid, shipped], required: true, default: pending }",
    )
    regenerated = metaobjects(project, "gen")
    assert regenerated.returncode == 0, regenerated.stderr
    proved = proof(project)
    assert proved.returncode == 0, proved.stdout
