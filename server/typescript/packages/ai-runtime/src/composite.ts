import type { LlmRecorder, LlmCallRow } from "@metaobjectsdev/runtime-ts";

export interface CompositeRecorderOpts {
  /** Called once per sink that rejects. Default: swallow. Telemetry must never
   * break the call path, so record() always resolves. */
  onError?: (error: unknown, index: number) => void;
}

/** Fans a row out to several sinks; a sink that rejects is isolated. */
export class CompositeRecorder implements LlmRecorder {
  private readonly recorders: readonly LlmRecorder[];
  private readonly onError: (error: unknown, index: number) => void;

  constructor(recorders: readonly LlmRecorder[], opts?: CompositeRecorderOpts) {
    this.recorders = recorders;
    this.onError = opts?.onError ?? (() => {});
  }

  async record(call: LlmCallRow): Promise<void> {
    const results = await Promise.allSettled(
      this.recorders.map((r) => r.record(call)),
    );
    results.forEach((res, i) => {
      if (res.status === "rejected") this.onError(res.reason, i);
    });
  }
}
