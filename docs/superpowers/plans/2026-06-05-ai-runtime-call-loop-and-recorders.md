# AI Runtime (#2/#3) — Call Loop + Recorder Adapters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `@metaobjectsdev/ai-runtime` TS package — the `LlmClient` CALL seam, the `callLlm` GENERATE→CALL→record bridge, the generated `call<Entity>` helper, a pluggable cost catalog with injectable clock/ids, the three recorder adapters (Composite/Langfuse/OTel), and two reference vendor clients (Anthropic/OpenAI).

**Architecture:** New `ai-runtime` package depends on `runtime-ts` (recorder seam + `recordLlmCall`) + `render`. The CALL seam is a single-method `LlmClient` interface; vendor SDKs and telemetry SDKs are never hard deps — adapters take **constructor-injected, structurally-typed** clients/sinks so they are optional and unit-testable without live services. `callLlm` reuses the shipped `recordLlmCall` verbatim for PARSE→WRITE and adds CALL + cost/latency/ids in a finally-style write. The `trace-helper-file` codegen generator gains a second emitted function, `call<Entity>`.

**Tech Stack:** TypeScript (ESM), Bun test runner, `@metaobjectsdev/{runtime-ts,render,metadata,codegen-ts}`, Testcontainers Postgres (existing `integration-tests` harness). Vendor SDKs (`@anthropic-ai/sdk`, `openai`, `langfuse`, `@opentelemetry/api`) are optional peer deps, never imported by core.

**Spec:** `docs/superpowers/specs/2026-06-05-ai-runtime-call-loop-and-recorders-design.md`

**Working dir for all commands:** `server/typescript` (the Bun server workspace). Run `bun install` once at the **repo root** after Task 1 adds the new package.

---

## File Structure

**New package `server/typescript/packages/ai-runtime/`:**
- `package.json` — name `@metaobjectsdev/ai-runtime`, subpath exports, optional peer deps.
- `tsconfig.json`, `tsconfig.typecheck.json` — mirror `packages/render`.
- `src/index.ts` — barrel: `LlmClient`/`LlmRequest`/`LlmCompletion`/`LlmUsage`, `Clock`/`IdGen` + defaults, `CostFn`/`builtinCost`, `callLlm`/`CallLlmInput`/`CallLlmDeps`, `CompositeRecorder`.
- `src/client.ts` — `LlmClient` seam + types + `systemClock` + `uuidIds`.
- `src/cost.ts` — `CostFn`, `builtinCost`.
- `src/call-loop.ts` — `callLlm` bridge.
- `src/composite.ts` — `CompositeRecorder`.
- `src/anthropic.ts` — `AnthropicClient` (subpath `./anthropic`).
- `src/openai.ts` — `OpenAIClient` (subpath `./openai`).
- `src/langfuse.ts` — `LangfuseRecorder` (subpath `./langfuse`).
- `src/otel.ts` — `OtelRecorder` (subpath `./otel`).
- `test/*.test.ts` — one file per unit.

**Modified:**
- `packages/runtime-ts/src/llm-recorder.ts` — add optional `parentSpanId`/`sessionId` to `LlmCallInput`, thread into row.
- `packages/codegen-ts/src/generators/trace-helper-file.ts` — emit `call<Entity>` alongside `record<Entity>`.
- `packages/codegen-ts/test/...` — extend trace-helper test.
- `packages/integration-tests/test/llm-call-persistence.test.ts` — add a `callLlm` round-trip case.

---

## Task 1: Scaffold the `ai-runtime` package

**Files:**
- Create: `packages/ai-runtime/package.json`
- Create: `packages/ai-runtime/tsconfig.json`
- Create: `packages/ai-runtime/tsconfig.typecheck.json`
- Create: `packages/ai-runtime/src/index.ts`
- Create: `packages/ai-runtime/test/smoke.test.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@metaobjectsdev/ai-runtime",
  "version": "0.9.0",
  "description": "LLM call loop + typed-trace recorder adapters for MetaObjects: provider-neutral LlmClient seam, callLlm bridge, Composite/Langfuse/OTel recorders.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "bun": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./anthropic": {
      "bun": "./src/anthropic.ts",
      "types": "./dist/anthropic.d.ts",
      "default": "./dist/anthropic.js"
    },
    "./openai": {
      "bun": "./src/openai.ts",
      "types": "./dist/openai.d.ts",
      "default": "./dist/openai.js"
    },
    "./langfuse": {
      "bun": "./src/langfuse.ts",
      "types": "./dist/langfuse.d.ts",
      "default": "./dist/langfuse.js"
    },
    "./otel": {
      "bun": "./src/otel.ts",
      "types": "./dist/otel.d.ts",
      "default": "./dist/otel.js"
    }
  },
  "files": ["dist", "src", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc -p .",
    "typecheck": "tsc -p tsconfig.typecheck.json"
  },
  "license": "Apache-2.0",
  "author": "Doug Mealing <doug@dougmealing.com>",
  "homepage": "https://metaobjects.dev",
  "bugs": { "url": "https://github.com/metaobjectsdev/metaobjects/issues" },
  "repository": {
    "type": "git",
    "url": "https://github.com/metaobjectsdev/metaobjects.git",
    "directory": "server/typescript/packages/ai-runtime"
  },
  "keywords": ["metaobjects", "llm", "ai", "trace", "langfuse", "opentelemetry"],
  "publishConfig": { "access": "public" },
  "dependencies": {
    "@metaobjectsdev/metadata": "workspace:*",
    "@metaobjectsdev/render": "workspace:*",
    "@metaobjectsdev/runtime-ts": "workspace:*"
  },
  "peerDependencies": {
    "@anthropic-ai/sdk": ">=0.30.0",
    "openai": ">=4.0.0",
    "langfuse": ">=3.0.0",
    "@opentelemetry/api": ">=1.0.0"
  },
  "peerDependenciesMeta": {
    "@anthropic-ai/sdk": { "optional": true },
    "openai": { "optional": true },
    "langfuse": { "optional": true },
    "@opentelemetry/api": { "optional": true }
  },
  "devDependencies": {
    "bun-types": "latest",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "test", "node_modules"]
}
```

- [ ] **Step 3: Write `tsconfig.typecheck.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "."
  },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 4: Write a minimal `src/index.ts` so the package resolves**

```ts
// @metaobjectsdev/ai-runtime — LLM call loop + typed-trace recorder adapters.
// Populated by later tasks; this placeholder lets the workspace resolve.
export const AI_RUNTIME_PACKAGE = "@metaobjectsdev/ai-runtime";
```

- [ ] **Step 5: Write the smoke test `test/smoke.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { AI_RUNTIME_PACKAGE } from "../src/index.ts";

describe("ai-runtime package", () => {
  test("resolves", () => {
    expect(AI_RUNTIME_PACKAGE).toBe("@metaobjectsdev/ai-runtime");
  });
});
```

- [ ] **Step 6: Install + run the smoke test**

Run (from repo root): `bun install`
Then (from `server/typescript`): `bun test packages/ai-runtime`
Expected: 1 pass.

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/ai-runtime package.json bun.lock
git commit -m "feat(ai-runtime): scaffold @metaobjectsdev/ai-runtime package"
```

---

## Task 2: `LlmClient` seam + types + default Clock/IdGen

**Files:**
- Create: `packages/ai-runtime/src/client.ts`
- Test: `packages/ai-runtime/test/client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { systemClock, uuidIds, type LlmClient } from "../src/client.ts";

describe("client seam", () => {
  test("systemClock returns a number", () => {
    expect(typeof systemClock.now()).toBe("number");
  });

  test("uuidIds.next returns distinct uuid-shaped strings", () => {
    const a = uuidIds.next();
    const b = uuidIds.next();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("LlmClient is structurally satisfiable", async () => {
    const client: LlmClient = {
      async complete(req) {
        return { body: `echo:${req.prompt}`, model: req.model };
      },
    };
    const out = await client.complete({ prompt: "hi", model: "m" });
    expect(out.body).toBe("echo:hi");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ai-runtime/test/client.test.ts`
Expected: FAIL — cannot resolve `../src/client.ts`.

- [ ] **Step 3: Write `src/client.ts`**

```ts
// The CALL seam. Named LlmClient to avoid collision with render's Provider
// (which resolves prompt-TEXT references, not LLM calls).

export interface LlmRequest {
  /** The rendered prompt text (the GENERATE step's output). */
  prompt: string;
  /** gen_ai.request.model */
  model: string;
  /** Optional system prompt text (gen_ai.system / system message). */
  system?: string;
  /** Provider params: temperature, max_tokens, top_p, ... */
  params?: Record<string, unknown>;
}

export interface LlmUsage {
  /** gen_ai.usage.input_tokens */
  inputTokens?: number;
  /** gen_ai.usage.output_tokens */
  outputTokens?: number;
}

export interface LlmCompletion {
  /** Raw completion text — fed to extract/record. */
  body: string;
  usage?: LlmUsage;
  /** gen_ai.response.model (may differ from request.model). */
  model?: string;
  /** Full wire request → llmRequest column (falls back to LlmRequest). */
  request?: unknown;
  /** gen_ai.response.finish_reasons */
  finishReason?: string;
}

/** The single-method, provider-neutral CALL seam. */
export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmCompletion>;
}

/** Injectable wall clock (ms since epoch). Injected so tests are deterministic. */
export interface Clock {
  now(): number;
}

/** Injectable id generator (span/trace ids). Injected so tests are deterministic. */
export interface IdGen {
  next(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export const uuidIds: IdGen = {
  next: () => crypto.randomUUID(),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/ai-runtime/test/client.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Export from the barrel** — replace `src/index.ts` body with:

```ts
// @metaobjectsdev/ai-runtime — LLM call loop + typed-trace recorder adapters.
export const AI_RUNTIME_PACKAGE = "@metaobjectsdev/ai-runtime";

export {
  systemClock,
  uuidIds,
  type LlmClient,
  type LlmRequest,
  type LlmCompletion,
  type LlmUsage,
  type Clock,
  type IdGen,
} from "./client.js";
```

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/ai-runtime
git commit -m "feat(ai-runtime): LlmClient CALL seam + injectable Clock/IdGen"
```

---

## Task 3: Cost catalog (`CostFn` + `builtinCost`)

**Files:**
- Create: `packages/ai-runtime/src/cost.ts`
- Test: `packages/ai-runtime/test/cost.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { builtinCost, type CostFn } from "../src/cost.ts";

describe("builtinCost", () => {
  test("known model computes integer USD minor units", () => {
    // gpt-4o-mini: $0.15 / 1M input, $0.60 / 1M output (see cost.ts MODEL_RATES).
    // 1_000_000 in + 1_000_000 out → 15 + 60 = 75 cents.
    const cents = builtinCost("gpt-4o-mini", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cents).toBe(75);
  });

  test("rounds to the nearest minor unit", () => {
    // 1000 in + 1000 out for gpt-4o-mini → 0.00015 + 0.0006 = 0.00075 dollars
    // = 0.075 cents → rounds to 0.
    expect(builtinCost("gpt-4o-mini", { inputTokens: 1000, outputTokens: 1000 })).toBe(0);
  });

  test("unknown model returns null (never throws)", () => {
    expect(builtinCost("no-such-model", { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });

  test("missing usage returns null", () => {
    expect(builtinCost("gpt-4o-mini", undefined)).toBeNull();
  });

  test("is assignable to CostFn", () => {
    const fn: CostFn = builtinCost;
    expect(typeof fn).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ai-runtime/test/cost.test.ts`
Expected: FAIL — cannot resolve `../src/cost.ts`.

- [ ] **Step 3: Write `src/cost.ts`**

```ts
import type { LlmUsage } from "./client.js";

/**
 * Maps (model, usage) to a cost in integer USD minor units (cents), per the
 * field.currency wire contract. Returns null when the cost is unknown
 * (unknown model or missing usage) — never throws.
 */
export type CostFn = (model: string, usage: LlmUsage | undefined) => number | null;

/**
 * Best-effort static rate table: USD dollars per 1,000,000 tokens.
 * Intentionally small — NOT a maintained pricing oracle. Adopters override by
 * passing their own CostFn to callLlm. Public model identifiers only.
 */
const MODEL_RATES: Record<string, { inputPerM: number; outputPerM: number }> = {
  "gpt-4o": { inputPerM: 2.5, outputPerM: 10 },
  "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6 },
  "claude-3-5-sonnet": { inputPerM: 3, outputPerM: 15 },
  "claude-3-5-haiku": { inputPerM: 0.8, outputPerM: 4 },
};

export const builtinCost: CostFn = (model, usage) => {
  if (usage === undefined) return null;
  const rate = MODEL_RATES[model];
  if (rate === undefined) return null;
  const inTok = usage.inputTokens ?? 0;
  const outTok = usage.outputTokens ?? 0;
  const dollars = (inTok * rate.inputPerM + outTok * rate.outputPerM) / 1_000_000;
  return Math.round(dollars * 100); // → integer cents
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/ai-runtime/test/cost.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Export from the barrel** — append to `src/index.ts`:

```ts
export { builtinCost, type CostFn } from "./cost.js";
```

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/ai-runtime
git commit -m "feat(ai-runtime): pluggable cost catalog (builtinCost, null-for-unknown)"
```

---

## Task 4: Extend `LlmCallInput` with `parentSpanId` + `sessionId` (runtime-ts)

**Files:**
- Modify: `packages/runtime-ts/src/llm-recorder.ts`
- Test: `packages/runtime-ts/test/llm-recorder.test.ts` (create if absent; otherwise append)

Context: `LlmCallInput` (in `llm-recorder.ts`) currently lacks `parentSpanId` and `sessionId`, but the shipped `LlmCallBase` envelope (`library/ai/llm-call.yaml`) declares both columns. This task threads them through `recordLlmCall` so the call loop can populate the full envelope. Additive + backward-compatible.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { NullRecorder, recordLlmCall, type LlmCallRow } from "../src/llm-recorder.ts";
import { MetaDataLoader } from "@metaobjectsdev/metadata";

// A capturing recorder to inspect the row built by recordLlmCall.
class CaptureRecorder extends NullRecorder {
  last: LlmCallRow | null = null;
  async record(call: LlmCallRow): Promise<void> {
    this.last = call;
  }
}

const META = JSON.stringify({
  "metadata.root": {
    package: "test::ai",
    children: [
      {
        "object.value": {
          name: "Resp",
          children: [{ "field.string": { name: "verdict", "@required": true } }],
        },
      },
    ],
  },
});

function respMo() {
  const root = MetaDataLoader.fromString(META).load();
  return root.findObject("Resp")!;
}

describe("recordLlmCall envelope fields", () => {
  test("threads parentSpanId + sessionId into the row", async () => {
    const rec = new CaptureRecorder();
    await recordLlmCall(
      {
        spanId: "s1",
        traceId: "t1",
        parentSpanId: "p1",
        sessionId: "sess1",
        callType: "X",
        startedAt: "2026-06-05T00:00:00Z",
        llmRequest: { a: 1 },
        llmResponseText: JSON.stringify({ verdict: "ok" }),
      },
      { recorder: rec, responseMo: respMo() },
    );
    expect(rec.last?.parentSpanId).toBe("p1");
    expect(rec.last?.sessionId).toBe("sess1");
  });

  test("omitted parentSpanId + sessionId default to null", async () => {
    const rec = new CaptureRecorder();
    await recordLlmCall(
      {
        spanId: "s2",
        traceId: "t2",
        callType: "X",
        startedAt: "2026-06-05T00:00:00Z",
        llmRequest: {},
        llmResponseText: JSON.stringify({ verdict: "ok" }),
      },
      { recorder: rec, responseMo: respMo() },
    );
    expect(rec.last?.parentSpanId).toBeNull();
    expect(rec.last?.sessionId).toBeNull();
  });
});
```

Note: confirm `MetaDataLoader.fromString(...).load()` is the loader entry; if the existing integration test uses a different constructor (e.g. `fromString(META)` returns a loader), match that call shape. Check `packages/integration-tests/test/llm-call-persistence.test.ts` for the exact loader usage and mirror it.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/runtime-ts/test/llm-recorder.test.ts`
Expected: FAIL — `rec.last.parentSpanId` is `undefined`, not `"p1"` (field not threaded).

- [ ] **Step 3: Add the two optional fields to `LlmCallInput`**

In `packages/runtime-ts/src/llm-recorder.ts`, in the `LlmCallInput` interface, after `traceId: string;` add:

```ts
  /** Parent span id; null/absent → this is a root span. */
  parentSpanId?: string;
  /** Logical session/conversation id (gen_ai session grouping). */
  sessionId?: string;
```

- [ ] **Step 4: Thread them into the row**

In `recordLlmCall`, in the `const row: LlmCallRow = {` literal, after `traceId: input.traceId,` add:

```ts
    parentSpanId: input.parentSpanId ?? null,
    sessionId: input.sessionId ?? null,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/runtime-ts/test/llm-recorder.test.ts`
Expected: 2 pass.

- [ ] **Step 6: Run the full runtime-ts suite to confirm no regression**

Run: `bun test packages/runtime-ts`
Expected: all pass (no existing test asserted the absence of these keys).

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/runtime-ts
git commit -m "feat(ai): thread parentSpanId + sessionId through recordLlmCall envelope"
```

---

## Task 5: `callLlm` bridge (GENERATE→CALL→record)

**Files:**
- Create: `packages/ai-runtime/src/call-loop.ts`
- Test: `packages/ai-runtime/test/call-loop.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { NullRecorder, type LlmCallRow } from "@metaobjectsdev/runtime-ts";
import { callLlm } from "../src/call-loop.ts";
import type { LlmClient, Clock, IdGen } from "../src/client.ts";

const META = JSON.stringify({
  "metadata.root": {
    package: "test::ai",
    children: [
      {
        "object.value": {
          name: "Resp",
          children: [{ "field.string": { name: "verdict", "@required": true } }],
        },
      },
    ],
  },
});
function respMo() {
  return MetaDataLoader.fromString(META).load().findObject("Resp")!;
}

class Capture extends NullRecorder {
  rows: LlmCallRow[] = [];
  async record(c: LlmCallRow): Promise<void> { this.rows.push(c); }
}

// Deterministic seams.
const fixedClock = (() => { let t = 1000; return { now: () => (t += 500) } as Clock; })();
const seqIds: IdGen = (() => { let n = 0; return { next: () => `id${++n}` }; })();

describe("callLlm", () => {
  test("happy path: CALL then record, captures latency/cost/ids", async () => {
    const client: LlmClient = {
      async complete(req) {
        return { body: JSON.stringify({ verdict: "ok" }), model: req.model,
                 usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } };
      },
    };
    const rec = new Capture();
    const res = await callLlm(
      { callType: "Verdict", payload: { q: "x" },
        request: { prompt: "P", model: "gpt-4o-mini" } },
      { client, recorder: rec, responseMo: respMo(),
        clock: { now: fixedClock.now }, ids: seqIds },
    );
    expect(res.status).toBe("ok");
    expect(rec.rows.length).toBe(1);
    const row = rec.rows[0]!;
    expect(row.callType).toBe("Verdict");
    expect(row.spanId).toBe("id1");          // first id → span
    expect(row.traceId).toBe("id2");         // second id → trace (none supplied)
    expect(row.costMinor).toBe(75);          // builtinCost gpt-4o-mini @1M+1M
    expect(typeof row.latencyMs).toBe("number");
    expect(row.status).toBe("ok");
  });

  test("supplied traceId is preserved (no new trace id)", async () => {
    const client: LlmClient = {
      async complete() { return { body: JSON.stringify({ verdict: "ok" }) }; },
    };
    const rec = new Capture();
    await callLlm(
      { callType: "V", payload: {}, request: { prompt: "P", model: "m" }, traceId: "T-EXIST" },
      { client, recorder: rec, responseMo: respMo(), ids: (() => { let n = 0; return { next: () => `s${++n}` }; })() },
    );
    expect(rec.rows[0]!.traceId).toBe("T-EXIST");
    expect(rec.rows[0]!.spanId).toBe("s1");
  });

  test("client throws: finally-style error row, no rethrow", async () => {
    const client: LlmClient = {
      async complete() { throw new Error("boom"); },
    };
    const rec = new Capture();
    const res = await callLlm(
      { callType: "V", payload: {}, request: { prompt: "P", model: "m" } },
      { client, recorder: rec, responseMo: respMo() },
    );
    expect(res.status).toBe("error");
    expect(res.voResponse).toBeNull();
    expect(rec.rows.length).toBe(1);
    expect(rec.rows[0]!.status).toBe("error");
    expect(rec.rows[0]!.errorDetail).toContain("boom");
    expect(rec.rows[0]!.llmResponse).toBeNull();
  });

  test("parse failure (lost required): error row, still persisted", async () => {
    const client: LlmClient = {
      async complete() { return { body: JSON.stringify({ wrong: "shape" }) }; },
    };
    const rec = new Capture();
    const res = await callLlm(
      { callType: "V", payload: {}, request: { prompt: "P", model: "m" } },
      { client, recorder: rec, responseMo: respMo() },
    );
    expect(res.status).toBe("error");
    expect(res.voResponse).toBeNull();
    expect(rec.rows.length).toBe(1);
    expect(rec.rows[0]!.status).toBe("error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ai-runtime/test/call-loop.test.ts`
Expected: FAIL — cannot resolve `../src/call-loop.ts`.

- [ ] **Step 3: Write `src/call-loop.ts`**

```ts
import { recordLlmCall, type LlmRecorder, type RecordLlmCallResult, type Format }
  from "@metaobjectsdev/runtime-ts";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { systemClock, uuidIds, type Clock, type IdGen, type LlmClient, type LlmRequest }
  from "./client.js";
import { builtinCost, type CostFn } from "./cost.js";

export interface CallLlmInput {
  /** Discriminator / call identity; defaults to the generated entity name. */
  callType: string;
  /** The typed request VO (logged as llmRequest unless completion.request is set). */
  payload: unknown;
  /** What we send to the client (already-rendered prompt + model + params). */
  request: LlmRequest;
  /** Existing trace to attach to; a new trace id is generated when absent. */
  traceId?: string;
  parentSpanId?: string;
  sessionId?: string;
}

export interface CallLlmDeps {
  client: LlmClient;
  recorder: LlmRecorder;
  /** MetaObject for the response VO (passed to extract, same as recordLlmCall). */
  responseMo: MetaObject;
  format?: Format;
  cost?: CostFn;
  clock?: Clock;
  ids?: IdGen;
}

/**
 * GENERATE-adjacent → CALL → PARSE → WRITE. The caller supplies the already
 * rendered prompt in `input.request.prompt`; callLlm does the CALL, computes
 * latency/cost/ids, then delegates PARSE+WRITE to recordLlmCall. Finally-style:
 * a client throw still writes an error row and never rethrows into the caller.
 */
export async function callLlm(
  input: CallLlmInput,
  deps: CallLlmDeps,
): Promise<RecordLlmCallResult> {
  const clock = deps.clock ?? systemClock;
  const ids = deps.ids ?? uuidIds;
  const cost = deps.cost ?? builtinCost;

  const spanId = ids.next();
  const traceId = input.traceId ?? ids.next();
  const t0 = clock.now();
  const startedAt = new Date(t0).toISOString();

  let completion;
  try {
    completion = await deps.client.complete(input.request);
  } catch (err) {
    const errorDetail = err instanceof Error ? err.message : String(err);
    const row = {
      spanId,
      traceId,
      parentSpanId: input.parentSpanId ?? null,
      sessionId: input.sessionId ?? null,
      callType: input.callType,
      requestModel: input.request.model,
      responseModel: null,
      inputTokens: null,
      outputTokens: null,
      costMinor: null,
      latencyMs: clock.now() - t0,
      finishReason: null,
      status: "error" as const,
      errorDetail,
      startedAt,
      llmRequest: JSON.stringify(input.request),
      llmResponse: null,
      voResponse: null,
    };
    await deps.recorder.record(row);
    return { voResponse: null, status: "error", errorDetail };
  }

  return recordLlmCall(
    {
      spanId,
      traceId,
      parentSpanId: input.parentSpanId,
      sessionId: input.sessionId,
      callType: input.callType,
      startedAt,
      llmRequest: completion.request ?? input.request,
      llmResponseText: completion.body,
      requestModel: input.request.model,
      inputTokens: completion.usage?.inputTokens,
      outputTokens: completion.usage?.outputTokens,
      costMinor: cost(completion.model ?? input.request.model, completion.usage) ?? undefined,
      latencyMs: clock.now() - t0,
      finishReason: completion.finishReason,
    },
    { recorder: deps.recorder, responseMo: deps.responseMo, format: deps.format },
  );
}
```

Note on the error-path row: it mirrors the keys `recordLlmCall` writes (see `llm-recorder.ts`), plus `parentSpanId`/`sessionId`/`responseModel`. If the shipped `recordLlmCall` row does not yet include `responseModel`, drop that key here too so the entity-declared column set stays consistent — verify against the current `row` literal in `llm-recorder.ts` before implementing and match it exactly (ObjectManager.create rejects unknown keys).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/ai-runtime/test/call-loop.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Export from the barrel** — append to `src/index.ts`:

```ts
export { callLlm, type CallLlmInput, type CallLlmDeps } from "./call-loop.js";
```

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/ai-runtime
git commit -m "feat(ai-runtime): callLlm bridge (GENERATE->CALL->record, finally-style)"
```

---

## Task 6: `CompositeRecorder`

**Files:**
- Create: `packages/ai-runtime/src/composite.ts`
- Test: `packages/ai-runtime/test/composite.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { NullRecorder, type LlmCallRow } from "@metaobjectsdev/runtime-ts";
import { CompositeRecorder } from "../src/composite.ts";

class Capture extends NullRecorder {
  rows: LlmCallRow[] = [];
  async record(c: LlmCallRow): Promise<void> { this.rows.push(c); }
}
class Throwing extends NullRecorder {
  async record(): Promise<void> { throw new Error("sink-down"); }
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ai-runtime/test/composite.test.ts`
Expected: FAIL — cannot resolve `../src/composite.ts`.

- [ ] **Step 3: Write `src/composite.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/ai-runtime/test/composite.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Export from the barrel** — append to `src/index.ts`:

```ts
export { CompositeRecorder, type CompositeRecorderOpts } from "./composite.js";
```

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/ai-runtime
git commit -m "feat(ai-runtime): CompositeRecorder fan-out (sink failures isolated)"
```

---

## Task 7: `LangfuseRecorder`

**Files:**
- Create: `packages/ai-runtime/src/langfuse.ts`
- Test: `packages/ai-runtime/test/langfuse.test.ts`

Design: the recorder takes a constructor-injected, structurally-typed `LangfuseSink` (a single `trace(payload)` method) so the `langfuse` SDK is never a hard dep and the mapping is unit-testable. An adopter constructs `new LangfuseRecorder({ sink: realLangfuseClientAdapter })`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { LangfuseRecorder, type LangfuseSink, type LangfuseTracePayload } from "../src/langfuse.ts";
import type { LlmCallRow } from "@metaobjectsdev/runtime-ts";

class FakeSink implements LangfuseSink {
  payloads: LangfuseTracePayload[] = [];
  async trace(p: LangfuseTracePayload): Promise<void> { this.payloads.push(p); }
}

const ROW: LlmCallRow = {
  spanId: "span-1", traceId: "trace-1", callType: "Verdict",
  requestModel: "gpt-4o-mini", inputTokens: 10, outputTokens: 20,
  finishReason: "stop", status: "ok",
  llmRequest: JSON.stringify({ q: "x" }),
  voResponse: { verdict: "ok" },
};

describe("LangfuseRecorder", () => {
  test("maps a trace row to a Langfuse payload", async () => {
    const sink = new FakeSink();
    await new LangfuseRecorder({ sink }).record(ROW);
    expect(sink.payloads.length).toBe(1);
    const p = sink.payloads[0]!;
    expect(p.id).toBe("span-1");
    expect(p.traceId).toBe("trace-1");
    expect(p.name).toBe("Verdict");
    expect(p.model).toBe("gpt-4o-mini");
    expect(p.usage).toEqual({ input: 10, output: 20 });
    expect(p.metadata?.status).toBe("ok");
  });

  test("never throws into the caller when the sink rejects", async () => {
    const sink: LangfuseSink = { async trace() { throw new Error("net"); } };
    // Should resolve, not reject.
    await new LangfuseRecorder({ sink }).record(ROW);
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ai-runtime/test/langfuse.test.ts`
Expected: FAIL — cannot resolve `../src/langfuse.ts`.

- [ ] **Step 3: Write `src/langfuse.ts`**

```ts
import type { LlmRecorder, LlmCallRow } from "@metaobjectsdev/runtime-ts";

/** The shape we post to Langfuse — a generation/observation. */
export interface LangfuseTracePayload {
  id: string;
  traceId: string;
  name: string;
  model?: string;
  input?: unknown;
  output?: unknown;
  usage?: { input?: number; output?: number };
  metadata?: Record<string, unknown>;
}

/** Injected sink — implemented over the real langfuse SDK by the adopter, or a
 * fake in tests. Keeps the langfuse SDK an optional dep (never imported here). */
export interface LangfuseSink {
  trace(payload: LangfuseTracePayload): Promise<void> | void;
}

export interface LangfuseRecorderOpts {
  sink: LangfuseSink;
  /** Called when the sink rejects. Default: swallow (telemetry never breaks the call). */
  onError?: (error: unknown) => void;
}

const numOrUndef = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined;
const strOrUndef = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

export class LangfuseRecorder implements LlmRecorder {
  private readonly sink: LangfuseSink;
  private readonly onError: (error: unknown) => void;

  constructor(opts: LangfuseRecorderOpts) {
    this.sink = opts.sink;
    this.onError = opts.onError ?? (() => {});
  }

  async record(call: LlmCallRow): Promise<void> {
    const payload: LangfuseTracePayload = {
      id: String(call.spanId ?? ""),
      traceId: String(call.traceId ?? ""),
      name: String(call.callType ?? "llm-call"),
      model: strOrUndef(call.requestModel),
      input: call.llmRequest,
      output: call.voResponse ?? call.llmResponse,
      usage: {
        input: numOrUndef(call.inputTokens),
        output: numOrUndef(call.outputTokens),
      },
      metadata: {
        status: call.status,
        finishReason: call.finishReason,
        latencyMs: call.latencyMs,
        costMinor: call.costMinor,
      },
    };
    try {
      await this.sink.trace(payload);
    } catch (err) {
      this.onError(err);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/ai-runtime/test/langfuse.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/ai-runtime
git commit -m "feat(ai-runtime): LangfuseRecorder (injected sink, optional SDK)"
```

---

## Task 8: `OtelRecorder`

**Files:**
- Create: `packages/ai-runtime/src/otel.ts`
- Test: `packages/ai-runtime/test/otel.test.ts`

Design: the recorder takes a constructor-injected, structurally-typed `OtelTracer` (minimal `startSpan` → span with `setAttributes`/`end`) so `@opentelemetry/api` is never a hard dep. The internal→`gen_ai.*` attribute mapping lives here (the one edge boundary).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { OtelRecorder, type OtelTracer, type OtelSpan } from "../src/otel.ts";
import type { LlmCallRow } from "@metaobjectsdev/runtime-ts";

class FakeSpan implements OtelSpan {
  attrs: Record<string, unknown> = {};
  ended = false;
  setAttributes(a: Record<string, unknown>): void { Object.assign(this.attrs, a); }
  end(): void { this.ended = true; }
}
class FakeTracer implements OtelTracer {
  spans: { name: string; span: FakeSpan }[] = [];
  startSpan(name: string): OtelSpan {
    const span = new FakeSpan();
    this.spans.push({ name, span });
    return span;
  }
}

const ROW: LlmCallRow = {
  spanId: "s", traceId: "t", callType: "Verdict", system: "openai",
  requestModel: "gpt-4o-mini", responseModel: "gpt-4o-mini-2024",
  inputTokens: 10, outputTokens: 20, finishReason: "stop", status: "ok",
};

describe("OtelRecorder", () => {
  test("emits a gen_ai.* span and ends it", async () => {
    const tracer = new FakeTracer();
    await new OtelRecorder({ tracer }).record(ROW);
    expect(tracer.spans.length).toBe(1);
    const { name, span } = tracer.spans[0]!;
    expect(name).toBe("Verdict");
    expect(span.attrs["gen_ai.request.model"]).toBe("gpt-4o-mini");
    expect(span.attrs["gen_ai.usage.input_tokens"]).toBe(10);
    expect(span.attrs["gen_ai.usage.output_tokens"]).toBe(20);
    expect(span.attrs["gen_ai.response.finish_reasons"]).toBe("stop");
    expect(span.ended).toBe(true);
  });

  test("omits attributes for absent fields", async () => {
    const tracer = new FakeTracer();
    await new OtelRecorder({ tracer }).record({ spanId: "s", callType: "X" });
    const { span } = tracer.spans[0]!;
    expect("gen_ai.request.model" in span.attrs).toBe(false);
    expect("gen_ai.usage.input_tokens" in span.attrs).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ai-runtime/test/otel.test.ts`
Expected: FAIL — cannot resolve `../src/otel.ts`.

- [ ] **Step 3: Write `src/otel.ts`**

```ts
import type { LlmRecorder, LlmCallRow } from "@metaobjectsdev/runtime-ts";

/** Minimal structural subset of an OTel span. Avoids a hard @opentelemetry/api dep. */
export interface OtelSpan {
  setAttributes(attrs: Record<string, unknown>): void;
  end(): void;
}
/** Minimal structural subset of an OTel tracer. */
export interface OtelTracer {
  startSpan(name: string): OtelSpan;
}

export interface OtelRecorderOpts {
  tracer: OtelTracer;
  onError?: (error: unknown) => void;
}

/** Maps a trace row → a span with gen_ai.* attributes. The internal→gen_ai.*
 * mapping lives here (stable internal names, canonicalize at the edge). */
export class OtelRecorder implements LlmRecorder {
  private readonly tracer: OtelTracer;
  private readonly onError: (error: unknown) => void;

  constructor(opts: OtelRecorderOpts) {
    this.tracer = opts.tracer;
    this.onError = opts.onError ?? (() => {});
  }

  async record(call: LlmCallRow): Promise<void> {
    try {
      const span = this.tracer.startSpan(String(call.callType ?? "llm-call"));
      const attrs: Record<string, unknown> = {};
      const put = (key: string, v: unknown) => {
        if (v !== undefined && v !== null) attrs[key] = v;
      };
      put("gen_ai.system", call.system);
      put("gen_ai.request.model", call.requestModel);
      put("gen_ai.response.model", call.responseModel);
      put("gen_ai.usage.input_tokens", call.inputTokens);
      put("gen_ai.usage.output_tokens", call.outputTokens);
      put("gen_ai.response.finish_reasons", call.finishReason);
      put("metaobjects.trace_id", call.traceId);
      put("metaobjects.span_id", call.spanId);
      put("metaobjects.status", call.status);
      span.setAttributes(attrs);
      span.end();
    } catch (err) {
      this.onError(err);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/ai-runtime/test/otel.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/ai-runtime
git commit -m "feat(ai-runtime): OtelRecorder (gen_ai.* span attrs, injected tracer)"
```

---

## Task 9: Vendor client adapters (`AnthropicClient` + `OpenAIClient`)

**Files:**
- Create: `packages/ai-runtime/src/anthropic.ts`
- Create: `packages/ai-runtime/src/openai.ts`
- Test: `packages/ai-runtime/test/anthropic.test.ts`
- Test: `packages/ai-runtime/test/openai.test.ts`

Design: each adapter takes a constructor-injected, structurally-typed SDK client (minimal subset of the real SDK surface) so the vendor SDK is never imported by core and the mapping is testable with a fake. Adopter wires `new AnthropicClient(new Anthropic(), { model })`.

- [ ] **Step 1: Write the failing Anthropic test**

```ts
import { describe, expect, test } from "bun:test";
import { AnthropicClient, type AnthropicLike } from "../src/anthropic.ts";

const fakeSdk: AnthropicLike = {
  messages: {
    async create(args) {
      return {
        content: [{ type: "text", text: `reply-to:${args.messages[0]!.content}` }],
        model: "claude-3-5-haiku-x",
        stop_reason: "end_turn",
        usage: { input_tokens: 11, output_tokens: 22 },
      };
    },
  },
};

describe("AnthropicClient", () => {
  test("maps LlmRequest → messages.create → LlmCompletion", async () => {
    const client = new AnthropicClient(fakeSdk);
    const out = await client.complete({ prompt: "hello", model: "claude-3-5-haiku", system: "sys" });
    expect(out.body).toBe("reply-to:hello");
    expect(out.model).toBe("claude-3-5-haiku-x");
    expect(out.finishReason).toBe("end_turn");
    expect(out.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
    expect(out.request).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/ai-runtime/test/anthropic.test.ts`
Expected: FAIL — cannot resolve `../src/anthropic.ts`.

- [ ] **Step 3: Write `src/anthropic.ts`**

```ts
import type { LlmClient, LlmRequest, LlmCompletion } from "./client.js";

/** Minimal structural subset of @anthropic-ai/sdk used here. */
export interface AnthropicLike {
  messages: {
    create(args: {
      model: string;
      system?: string;
      max_tokens: number;
      messages: { role: "user"; content: string }[];
      [k: string]: unknown;
    }): Promise<{
      content: { type: string; text?: string }[];
      model?: string;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>;
  };
}

export interface AnthropicClientOpts {
  /** Default max_tokens when request.params has none. */
  maxTokens?: number;
}

export class AnthropicClient implements LlmClient {
  constructor(private readonly sdk: AnthropicLike, private readonly opts: AnthropicClientOpts = {}) {}

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const args = {
      model: req.model,
      system: req.system,
      max_tokens: (req.params?.max_tokens as number | undefined) ?? this.opts.maxTokens ?? 1024,
      messages: [{ role: "user" as const, content: req.prompt }],
      ...req.params,
    };
    const res = await this.sdk.messages.create(args);
    const body = res.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("");
    return {
      body,
      model: res.model,
      finishReason: res.stop_reason,
      usage: { inputTokens: res.usage?.input_tokens, outputTokens: res.usage?.output_tokens },
      request: args,
    };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/ai-runtime/test/anthropic.test.ts`
Expected: 1 pass.

- [ ] **Step 5: Write the failing OpenAI test**

```ts
import { describe, expect, test } from "bun:test";
import { OpenAIClient, type OpenAILike } from "../src/openai.ts";

const fakeSdk: OpenAILike = {
  chat: {
    completions: {
      async create(args) {
        return {
          choices: [{ message: { content: `reply:${args.messages.at(-1)!.content}` }, finish_reason: "stop" }],
          model: "gpt-4o-mini-x",
          usage: { prompt_tokens: 5, completion_tokens: 7 },
        };
      },
    },
  },
};

describe("OpenAIClient", () => {
  test("maps LlmRequest → chat.completions.create → LlmCompletion", async () => {
    const client = new OpenAIClient(fakeSdk);
    const out = await client.complete({ prompt: "hi", model: "gpt-4o-mini", system: "sys" });
    expect(out.body).toBe("reply:hi");
    expect(out.model).toBe("gpt-4o-mini-x");
    expect(out.finishReason).toBe("stop");
    expect(out.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `bun test packages/ai-runtime/test/openai.test.ts`
Expected: FAIL — cannot resolve `../src/openai.ts`.

- [ ] **Step 7: Write `src/openai.ts`**

```ts
import type { LlmClient, LlmRequest, LlmCompletion } from "./client.js";

/** Minimal structural subset of the openai SDK used here. */
export interface OpenAILike {
  chat: {
    completions: {
      create(args: {
        model: string;
        messages: { role: "system" | "user"; content: string }[];
        [k: string]: unknown;
      }): Promise<{
        choices: { message: { content?: string | null }; finish_reason?: string }[];
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>;
    };
  };
}

export class OpenAIClient implements LlmClient {
  constructor(private readonly sdk: OpenAILike) {}

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const messages = [
      ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
      { role: "user" as const, content: req.prompt },
    ];
    const args = { model: req.model, messages, ...req.params };
    const res = await this.sdk.chat.completions.create(args);
    const choice = res.choices[0];
    return {
      body: choice?.message.content ?? "",
      model: res.model,
      finishReason: choice?.finish_reason,
      usage: { inputTokens: res.usage?.prompt_tokens, outputTokens: res.usage?.completion_tokens },
      request: args,
    };
  }
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `bun test packages/ai-runtime/test/openai.test.ts`
Expected: 1 pass.

- [ ] **Step 9: Typecheck the whole package**

Run (from `server/typescript`): `bun run --filter '@metaobjectsdev/ai-runtime' typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add server/typescript/packages/ai-runtime
git commit -m "feat(ai-runtime): Anthropic + OpenAI reference clients (injected SDK, optional dep)"
```

---

## Task 10: Generated `call<Entity>` (extend `trace-helper-file`)

**Files:**
- Modify: `packages/codegen-ts/src/generators/trace-helper-file.ts`
- Test: `packages/codegen-ts/test/trace-helper-file.test.ts` (create if absent; otherwise append)

Context: `trace-helper-file.ts` currently emits `record<Entity>` when an entity extends `LlmCallBase` and nests a `template.prompt` with `@responseRef`. This task makes it ALSO emit `call<Entity>` when that prompt additionally has a `@textRef` (renderable). When `@textRef` is absent, only `record<Entity>` is emitted (today's behavior, unchanged).

- [ ] **Step 1: Write the failing test**

Find or create the trace-helper test. Build a loaded root with an entity that extends `LlmCallBase`, nests a `template.prompt` with `@textRef` + `@payloadRef` + `@responseRef`, and assert the emitted file contains both functions. Mirror the fixture style used in `packages/codegen-ts/test/derive-trace-fields.test.ts` for constructing the loaded root.

```ts
import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { traceHelperFile } from "../src/generators/trace-helper-file.ts";
import { runGeneratorForTest } from "./helpers/run-generator.ts"; // see note below

// NOTE: reuse whatever harness derive-trace-fields.test.ts uses to run a
// generator over a loaded root + GenContext. If none is exported, build a
// GenContext inline as that test does and call generator.generate(ctx).

const META = JSON.stringify({
  "metadata.root": {
    package: "app::ai",
    children: [
      { "object.value": { name: "ClassifyRequest", children: [
        { "field.string": { name: "text", "@required": true } } ] } },
      { "object.value": { name: "ClassifyResponse", children: [
        { "field.string": { name: "label", "@required": true } } ] } },
      { "object.entity": { name: "LlmCallBase", "@abstract": true, children: [
        { "field.string": { name: "spanId" } } ] } },
      { "object.entity": { name: "ClassifyCall",
        "@extends": "app::ai::LlmCallBase", children: [
        { "source.rdb": { "@table": "classify_call" } },
        { "identity.primary": { "@fields": ["spanId"] } },
        { "template.prompt": { name: "ClassifyPrompt",
          "@textRef": "prompts/classify", "@payloadRef": "ClassifyRequest",
          "@responseRef": "ClassifyResponse", "@format": "json" } } ] } },
    ],
  },
});

describe("trace-helper-file call<Entity>", () => {
  test("emits both record<Entity> and call<Entity> for a renderable prompt", () => {
    const root = MetaDataLoader.fromString(META).load();
    const files = runGeneratorForTest(traceHelperFile(), root); // returns EmittedFile[]
    const f = files.find((x) => x.path.endsWith("ClassifyCall.trace.ts"))!;
    expect(f.content).toContain("export async function recordClassifyCall(");
    expect(f.content).toContain("export async function callClassifyCall(");
    expect(f.content).toContain("@metaobjectsdev/ai-runtime");
    expect(f.content).toContain('render({ ref: "prompts/classify"');
  });

  test("omits call<Entity> when the prompt has no @textRef", () => {
    const noText = META.replace('"@textRef": "prompts/classify", ', "");
    const root = MetaDataLoader.fromString(noText).load();
    const files = runGeneratorForTest(traceHelperFile(), root);
    const f = files.find((x) => x.path.endsWith("ClassifyCall.trace.ts"))!;
    expect(f.content).toContain("export async function recordClassifyCall(");
    expect(f.content).not.toContain("export async function callClassifyCall(");
  });
});
```

Note: if `derive-trace-fields.test.ts` constructs `GenContext` inline rather than via a `runGeneratorForTest` helper, copy that exact construction here instead of importing a helper. Read that file first and match its harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/codegen-ts/test/trace-helper-file.test.ts`
Expected: FAIL — emitted content lacks `callClassifyCall`.

- [ ] **Step 3: Implement `call<Entity>` emission in `trace-helper-file.ts`**

In `trace-helper-file.ts`:

(a) Import the text-ref + format constants (top of file, with the other `@metaobjectsdev/metadata` imports):

```ts
  TEMPLATE_ATTR_TEXT_REF,
```

(`TEMPLATE_ATTR_FORMAT`, `TEMPLATE_ATTR_PAYLOAD_REF`, `TEMPLATE_ATTR_RESPONSE_REF` are already imported.)

(b) After computing `responseRef`/`payloadRef`/`formatLiteral`/`requestType`, read the text ref and compute the render format string literal:

```ts
      const textRef = prompt.ownAttr(TEMPLATE_ATTR_TEXT_REF);
      const renderable = typeof textRef === "string";
      // render() format string: the prompt's @format value, defaulting to "text".
      const renderFormat = typeof promptFormat === "string" ? promptFormat : "text";
```

(c) After the existing `record<Entity>` lines are pushed into `lines`, append the `call<Entity>` block only when `renderable`. Insert before the final `return [{ path: ... }]`:

```ts
      if (renderable) {
        const callFn = `call${pascal(entityName)}`;
        lines.push(
          ``,
          `// ---- Call helper (GENERATE -> CALL -> record) -------------------------------`,
          ``,
          `import { render, type Provider } from "@metaobjectsdev/render";`,
          `import {`,
          `  callLlm,`,
          `  LlmCallDbRecorder as _AiLlmCallDbRecorder,`,
          `  type LlmClient,`,
          `  type CostFn,`,
          `  type Clock,`,
          `  type IdGen,`,
          `} from "@metaobjectsdev/ai-runtime";`,
          ``,
          `export interface ${entityName}CallDeps {`,
          `  om: ObjectManager;`,
          `  responseMo: MetaObject;`,
          `  client: LlmClient;`,
          `  /** Prompt-TEXT resolver for render() (NOT the LLM client). */`,
          `  provider: Provider;`,
          `  model: string;`,
          `  system?: string;`,
          `  params?: Record<string, unknown>;`,
          `  cost?: CostFn;`,
          `  clock?: Clock;`,
          `  ids?: IdGen;`,
          `  traceId?: string;`,
          `  parentSpanId?: string;`,
          `  sessionId?: string;`,
          `}`,
          ``,
          `/**`,
          ` * Render the ${entityName} prompt, call the LLM, then parse + persist a`,
          ` * trace row (finally-style: a call/parse failure still writes a row).`,
          ` */`,
          `export async function ${callFn}(`,
          `  payload: ${requestType},`,
          `  deps: ${entityName}CallDeps,`,
          `): Promise<${entityName}TraceResult> {`,
          `  const prompt = render({ ref: ${JSON.stringify(textRef)}, payload, format: ${JSON.stringify(renderFormat)}, provider: deps.provider });`,
          `  const result = await callLlm(`,
          `    {`,
          `      callType: ${JSON.stringify(entityName)},`,
          `      payload,`,
          `      request: { prompt, model: deps.model, system: deps.system, params: deps.params },`,
          `      traceId: deps.traceId,`,
          `      parentSpanId: deps.parentSpanId,`,
          `      sessionId: deps.sessionId,`,
          `    },`,
          `    {`,
          `      client: deps.client,`,
          `      recorder: new _AiLlmCallDbRecorder(deps.om, ${JSON.stringify(entityName)}),`,
          `      responseMo: deps.responseMo,`,
          `      format: ${formatLiteral},`,
          `      cost: deps.cost,`,
          `      clock: deps.clock,`,
          `      ids: deps.ids,`,
          `    },`,
          `  );`,
          `  return result as ${entityName}TraceResult;`,
          `}`,
        );
      }
```

Note on imports: the generated file already imports `ObjectManager`, `MetaObject`, `LlmCallDbRecorder`, `recordLlmCall`, `Format` for the record helper. The `call<Entity>` block adds a `render` import from `@metaobjectsdev/render` and the `ai-runtime` imports. `LlmCallDbRecorder` is imported from `runtime-ts` for the record helper AND needed here; to avoid a duplicate symbol, the call block imports it from `ai-runtime` under the alias `_AiLlmCallDbRecorder` (ai-runtime re-exports it — confirm, or import the alias from runtime-ts instead). Verify there is exactly one binding per symbol in the emitted file (duplicate `import { render }` lines are fine only if identical and de-duped; prefer a single hoisted `render` import — if the record block does not import `render`, this single occurrence is clean).

(d) Ensure `ai-runtime` re-exports `LlmCallDbRecorder` for the alias, OR change the alias import to come from `@metaobjectsdev/runtime-ts`. Simplest: import `LlmCallDbRecorder` once (already present from runtime-ts) and drop the aliased ai-runtime import — use the existing `LlmCallDbRecorder` symbol in the call block. Adjust the emitted block accordingly so there is no duplicate binding.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/codegen-ts/test/trace-helper-file.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Confirm the emitted file type-checks**

Add an assertion (or a manual check) that the generated content has no duplicate `import` of the same symbol. If the harness can write the file to a temp dir and run `tsc`, do so; otherwise assert on string content (single `LlmCallDbRecorder` import, single `render` import).

- [ ] **Step 6: Run the full codegen-ts suite**

Run: `bun test packages/codegen-ts`
Expected: all pass (existing trace-helper / derive-trace-fields tests still green).

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/codegen-ts
git commit -m "feat(ai): generate call<Entity> alongside record<Entity> for renderable prompts"
```

---

## Task 11: Integration round-trip — `callLlm` through real Postgres

**Files:**
- Modify: `packages/integration-tests/test/llm-call-persistence.test.ts`

Context: the existing test round-trips `recordLlmCall`. Add a case that drives `callLlm` (with a canned `LlmClient`) so the GENERATE→CALL→record loop is verified end-to-end against real Postgres, including the typed `voResponse` jsonb and the failure path.

- [ ] **Step 1: Add the import**

At the top of the test, alongside the existing runtime-ts imports, add:

```ts
import { callLlm } from "@metaobjectsdev/ai-runtime";
import type { LlmClient } from "@metaobjectsdev/ai-runtime";
```

- [ ] **Step 2: Write the failing test case**

Inside the existing `describe`, after the `recordLlmCall` cases (reuse the same `om`, `TraceCall` entity, and `VerdictResponse` MetaObject the file already sets up):

```ts
  test("callLlm round-trips a typed trace through Postgres", async () => {
    const client: LlmClient = {
      async complete() {
        return {
          body: JSON.stringify({ verdict: "ship", score: 9 }),
          model: "gpt-4o-mini",
          usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
          finishReason: "stop",
        };
      },
    };
    const res = await callLlm(
      { callType: "TraceCall", payload: { q: "ready?" },
        request: { prompt: "decide", model: "gpt-4o-mini" } },
      { client, recorder: new LlmCallDbRecorder(om, "TraceCall"), responseMo,
        format: Format.JSON },
    );
    expect(res.status).toBe("ok");

    const rows = await om.list("TraceCall", {});
    const row = rows.find((r) => r.callType === "TraceCall" && r.status === "ok");
    expect(row).toBeDefined();
    expect((row!.voResponse as { verdict: string }).verdict).toBe("ship");
    expect(row!.costMinor).toBe(75);
  });

  test("callLlm persists an error row when the client throws", async () => {
    const client: LlmClient = { async complete() { throw new Error("provider-503"); } };
    const res = await callLlm(
      { callType: "TraceCall", payload: {}, request: { prompt: "x", model: "gpt-4o-mini" } },
      { client, recorder: new LlmCallDbRecorder(om, "TraceCall"), responseMo, format: Format.JSON },
    );
    expect(res.status).toBe("error");
    const rows = await om.list("TraceCall", {});
    expect(rows.some((r) => r.status === "error" && String(r.errorDetail).includes("provider-503"))).toBe(true);
  });
```

Note: match the existing file's API for reading rows (`om.list(...)` vs a Kysely query) — read the existing assertions in this file and mirror them exactly. If `TraceCall` does not declare `parentSpanId`/`sessionId`/`responseModel` columns, either add them to the inline `TraceCall` metadata in this file (so `ObjectManager.create` accepts the row callLlm builds) OR confirm callLlm's row keys are a subset of the declared columns. **This is the most likely failure point** — reconcile the `TraceCall` column set with the keys `callLlm`/`recordLlmCall` write before running.

- [ ] **Step 3: Reconcile `TraceCall` columns with the row keys**

Read the inline `TraceCall` entity in the test. Ensure it declares every key `callLlm` writes: `spanId, traceId, parentSpanId, sessionId, callType, requestModel, responseModel?, inputTokens, outputTokens, costMinor, latencyMs, finishReason, status, errorDetail, startedAt, llmRequest, llmResponse?, voResponse`. Add any missing `field.*` declarations (match the types used by the existing rows; `parentSpanId`/`sessionId` → `field.string`). Keep the column set EXACTLY aligned with what `recordLlmCall` (Task 4) now writes.

- [ ] **Step 4: Run the integration test**

Run (from `server/typescript`): `bun test packages/integration-tests/test/llm-call-persistence.test.ts`
Expected: all cases pass (requires Docker for Testcontainers; if Docker is unavailable, note it and run in an environment that has it — do not mark complete on a skipped run).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/integration-tests
git commit -m "test(ai-runtime): callLlm Postgres round-trip (typed trace + error path)"
```

---

## Task 12: Final verification

- [ ] **Step 1: Typecheck the touched packages**

Run (from `server/typescript`):
```bash
bun run --filter '@metaobjectsdev/ai-runtime' typecheck
bun run --filter '@metaobjectsdev/runtime-ts' typecheck
bun run --filter '@metaobjectsdev/codegen-ts' typecheck
```
Expected: no errors in any.

- [ ] **Step 2: Run the server test suite**

Run (from `server/typescript`): `bun test`
Expected: all pass (existing 2100+ tests + the new ai-runtime / codegen / integration cases).

- [ ] **Step 3: Build the new package**

Run (from `server/typescript`): `bun run --filter '@metaobjectsdev/ai-runtime' build`
Expected: `dist/` emitted, no errors.

- [ ] **Step 4: Confirm clean git status + summarize**

Run: `git status` and `git log --oneline main..HEAD`
Expected: working tree clean; the Task 1–11 commits present.

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** §2 LlmClient → Task 2; §2.1 vendor adapters → Task 9; §3 callLlm + §3.1 envelope extension → Tasks 4–5; §4 generated call<Entity> → Task 10; §5 cost/clock/ids → Tasks 2–3; §6 recorders → Tasks 6–8; §7 testing → Tasks 5–11; §9 package layout → Task 1.
- **No live calls:** every test uses a canned `LlmClient` / fake SDK / fake sink / fake tracer. Integration uses Testcontainers Postgres only.
- **Most likely failure points, flagged in-task:** (1) the `TraceCall` column set vs the row keys callLlm/recordLlmCall write (Task 11 Step 3); (2) duplicate imports in the generated `call<Entity>` file (Task 10 Step 3d); (3) the exact `MetaDataLoader` entry call (`fromString(...).load()`) — verify against the existing integration test and mirror it (Tasks 4, 5, 10).
- **Public-repo hygiene:** generic domains (`Classify`, `Verdict`, `TraceCall`); only public model ids in `builtinCost`; vendor SDK names are public packages.
