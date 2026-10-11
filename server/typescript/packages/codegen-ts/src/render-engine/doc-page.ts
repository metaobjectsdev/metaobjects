import { render } from "@metaobjectsdev/render";
import type { Provider } from "@metaobjectsdev/render";

/**
 * Render one Markdown docs page from a Mustache template ref, wrapping any engine error
 * with the page ref and the output path so a template failure points at the exact page.
 *
 * Public so an owned docs generator (`src/reference/docs.ts`) renders its pages through the
 * same call, and with the same error contract, as the packaged one.
 */
export function renderDocPage(ref: string, payload: unknown, provider: Provider, path: string): string {
  try {
    return render({ ref, payload, provider, format: "markdown" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`docs-file: failed rendering '${ref}' for '${path}': ${msg}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }
}
