from pathlib import Path

import jinja2

from generated.models import WelcomePayload

_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(Path(__file__).parent.parent / "prompts"),
    undefined=jinja2.StrictUndefined,
    keep_trailing_newline=True,
)


def render_welcome(payload: WelcomePayload) -> str:
    return _env.get_template("welcome/greeting.jinja").render(**payload.model_dump(mode="json"))
