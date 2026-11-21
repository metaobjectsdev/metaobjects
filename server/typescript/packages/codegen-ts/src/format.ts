// `formatTs` is a no-op kept only so an owned 1.2 generator copy still loads.
//
// Until 1.3.0 every reference generator piped its rendered text through Biome before it
// was written. Generation no longer runs a formatter: each generator writes the layout it
// means (the templates and `TsWriter`), and the adopter's own formatter owns the rest. A
// generator copied out with `meta eject` in 1.2 imports this name from the package entry,
// so the export stays and returns its input unchanged. A copy that wants a formatter calls
// the one it already depends on.

/**
 * Returns `content` unchanged.
 *
 * @deprecated Generation runs no formatter. A generator that wants one calls its own.
 */
export async function formatTs(content: string): Promise<string> {
  return content;
}
