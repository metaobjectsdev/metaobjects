from generated.models import Plan, WelcomePayload
from worker.prompts import render_welcome


def test_welcome_greeting_renders_every_variable() -> None:
    # StrictUndefined (see worker/prompts.py) raises on any variable the payload lacks.
    out = render_welcome(WelcomePayload(name="Ada Lovelace", email="ada@example.test", plan=Plan.pro))
    assert "Ada Lovelace" in out and "ada@example.test" in out
