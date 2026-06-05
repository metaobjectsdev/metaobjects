import { describe, expect, test } from "bun:test";
import { NullRecorder, type LlmCallRow } from "@metaobjectsdev/runtime-ts";
import { CompositeRecorder } from "../src/composite.js";

class Capture extends NullRecorder {
  rows: LlmCallRow[] = [];
  override async record(c: LlmCallRow): Promise<void> { this.rows.push(c); }
}
class Throwing extends NullRecorder {
  override async record(): Promise<void> { throw new Error("sink-down"); }
}

const ROW: LlmCallRow = { spanId: "s", callType: "X" };

describe("CompositeRecorder", () => {
  test("fans out to every sink", async () => {
    const a = new Capture(); const b = new Capture();
    await new CompositeRecorder([a, b]).record(ROW);
    expect(a.rows.length).toBe(1);
    expect(b.rows.length).toBe(1);
  });

  test("a failing sink does not stop the others and does not throw", async () => {
    const ok = new Capture();
    const errors: unknown[] = [];
    const composite = new CompositeRecorder([new Throwing(), ok], {
      onError: (e) => errors.push(e),
    });
    await composite.record(ROW); // must not reject
    expect(ok.rows.length).toBe(1);
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe("sink-down");
  });

  test("default onError swallows (no throw, no crash)", async () => {
    const ok = new Capture();
    const composite = new CompositeRecorder([new Throwing(), ok]);
    await composite.record(ROW);
    expect(ok.rows.length).toBe(1);
  });
});
