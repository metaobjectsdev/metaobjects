import { render } from "@metaobjectsdev/render";
import type { Provider } from "@metaobjectsdev/render";
import type { ProgramDescriptionPayload } from "./ProgramDescriptionPayload.js";

/**
 * Render the ProgramDescriptionOutput document from a typed ProgramDescriptionPayload payload. Wraps the
 * render() engine; the payload field tree is baked in so render()'s runtime drift
 * check matches the build-time gate enforced when this file was generated.
 */
export function renderProgramDescriptionOutput(payload: ProgramDescriptionPayload, provider: Provider): string {
  return render({ ref: "learn/program-description", payload, format: "markdown", provider, verify: [{"name":"title"},{"name":"summary"},{"name":"authorName"},{"name":"lessonCount"}] });
}
