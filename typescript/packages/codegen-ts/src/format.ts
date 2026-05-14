// Biome formatter integration. Used by generate() to format rendered TS before write.
// Per design §11: format errors are warnings, not throws.

import { Biome, Distribution } from "@biomejs/js-api";

// Cache the Promise (not the resolved instance) so concurrent first calls
// share the same in-flight Biome.create() rather than racing to spawn two.
let _biomePromise: Promise<Biome> | undefined;

function getBiome(): Promise<Biome> {
  if (!_biomePromise) {
    _biomePromise = Biome.create({ distribution: Distribution.NODE }).then((biome) => {
      biome.applyConfiguration({
        formatter: { enabled: true, indentStyle: "space", indentWidth: 2 },
        javascript: { formatter: { quoteStyle: "double", semicolons: "always" } },
      });
      return biome;
    });
  }
  return _biomePromise;
}

/**
 * Summarize Biome diagnostics into a single human-readable line, without
 * dumping the raw diagnostic objects (which produce "[Object ...]" /
 * "source: null" noise when stringified by console).
 */
function summarizeDiagnostics(diagnostics: ReadonlyArray<unknown>): string {
  const count = diagnostics.length;
  const first = diagnostics[0] as { description?: string; message?: string } | undefined;
  const firstMsg = first?.description ?? first?.message ?? "(no description)";
  return count === 1
    ? `1 diagnostic: ${firstMsg}`
    : `${count} diagnostics; first: ${firstMsg}`;
}

export async function formatTs(content: string): Promise<string> {
  try {
    const biome = await getBiome();
    const result = biome.formatContent(content, { filePath: "in-memory.ts" });
    if (result.diagnostics.length > 0) {
      console.warn(`[codegen-ts] Biome formatter: ${summarizeDiagnostics(result.diagnostics)}`);
      return content;
    }
    return result.content;
  } catch (err) {
    console.warn(`[codegen-ts] Biome formatter error: ${(err as Error).message}`);
    return content;
  }
}
