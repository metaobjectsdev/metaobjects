// A provider resolves a 2-layer logical reference (`group/source`) to template
// text. The render engine never does I/O itself — it delegates resolution to
// the injected provider, so a fixed provider makes render() deterministic.

import type { TemplateEngine } from "./engine.js";

export interface Provider {
  /** Resolve a `group/source` reference to its text, or undefined if absent. */
  resolve(ref: string): string | undefined;
  /**
   * The engine `ref`'s text is written for, when the provider knows it — a
   * filesystem provider knows from the file extension it found. Optional:
   * a provider without it serves Mustache unless the caller passes `engine`.
   */
  engineOf?(ref: string): TemplateEngine | undefined;
}

export interface InMemoryProviderOptions {
  /** The engine every body in this provider is written for. Default: unset (Mustache). */
  engine?: TemplateEngine;
}

/** Deterministic, in-memory provider (the conformance + test provider). */
export class InMemoryProvider implements Provider {
  private readonly engine: TemplateEngine | undefined;

  constructor(
    private readonly map: Record<string, string>,
    options: InMemoryProviderOptions = {},
  ) {
    this.engine = options.engine;
  }

  resolve(ref: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(this.map, ref) ? this.map[ref] : undefined;
  }

  engineOf(ref: string): TemplateEngine | undefined {
    return this.resolve(ref) === undefined ? undefined : this.engine;
  }
}
