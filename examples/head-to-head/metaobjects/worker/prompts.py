from pathlib import Path

from metaobjects.render import FilesystemProvider
from metaobjects.render.renderer import RenderRequest, render

from worker.generated.WelcomePayload import WelcomePayload

_provider = FilesystemProvider(str(Path(__file__).parent.parent / "prompts"))


def render_welcome(payload: WelcomePayload) -> str:
    return render(
        RenderRequest(payload=payload.model_dump(mode="json"), provider=_provider, ref="welcome/greeting")
    )
