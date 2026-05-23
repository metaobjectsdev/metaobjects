// A provider resolves a 2-layer logical reference (`group/source`) to template
// text. The render engine never does I/O itself — it delegates resolution to
// the injected provider, so a fixed provider makes render() deterministic.

export interface Provider {
  /** Resolve a `group/source` reference to its text, or undefined if absent. */
  resolve(ref: string): string | undefined;
}

/** Deterministic, in-memory provider (the conformance + test provider). */
export class InMemoryProvider implements Provider {
  constructor(private readonly map: Record<string, string>) {}
  resolve(ref: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(this.map, ref) ? this.map[ref] : undefined;
  }
}
