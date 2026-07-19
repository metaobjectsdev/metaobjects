import { afterEach, describe, expect, test } from "bun:test";
import { canvasToJpegBlob } from "../src/canvas-to-jpeg-blob.js";
import { reencodeJpeg } from "../src/reencode-jpeg.js";

// runtime-web ships zero DOM dependency (no jsdom) — the canvas/document/
// createImageBitmap surface these units touch is stubbed by hand per test.

interface FakeCanvasCtx {
  drawImage: (...args: unknown[]) => void;
}

interface FakeCanvas {
  width: number;
  height: number;
  getContext: (kind: string) => FakeCanvasCtx | null;
  toBlob: (cb: (blob: Blob | null) => void, type: string, quality: number) => void;
}

interface ToBlobCall {
  type: string;
  quality: number;
}

function makeFakeCanvas(opts: {
  contextUnavailable: boolean | undefined;
  toBlobCalls: ToBlobCall[];
  drawImageCalls: unknown[][];
  toBlobReturnsNull: boolean | undefined;
}): FakeCanvas {
  const ctx: FakeCanvasCtx = {
    drawImage: (...args: unknown[]) => {
      opts.drawImageCalls.push(args);
    },
  };
  return {
    width: 0,
    height: 0,
    getContext: () => (opts.contextUnavailable ? null : ctx),
    toBlob: (cb, type, quality) => {
      opts.toBlobCalls.push({ type, quality });
      cb(opts.toBlobReturnsNull ? null : new Blob([], { type }));
    },
  };
}

/** Installs `globalThis.createImageBitmap` + `globalThis.document` for the
 *  duration of one test. Returns the fake canvas + call-capture arrays so
 *  assertions can inspect what reencodeJpeg did to them. */
function installFakeDom(opts: {
  bitmapWidth: number;
  bitmapHeight: number;
  contextUnavailable?: boolean;
  toBlobReturnsNull?: boolean;
}) {
  const closeCalls: number[] = [];
  const toBlobCalls: ToBlobCall[] = [];
  const drawImageCalls: unknown[][] = [];

  const bitmap = {
    width: opts.bitmapWidth,
    height: opts.bitmapHeight,
    close: () => {
      closeCalls.push(1);
    },
  };

  const canvas = makeFakeCanvas({
    contextUnavailable: opts.contextUnavailable,
    toBlobCalls,
    drawImageCalls,
    toBlobReturnsNull: opts.toBlobReturnsNull,
  });

  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async () => bitmap;
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => canvas,
  };

  return { canvas, closeCalls, toBlobCalls, drawImageCalls };
}

describe("canvasToJpegBlob", () => {
  test("passes image/jpeg + default quality 0.9 to canvas.toBlob and resolves the blob", async () => {
    const calls: ToBlobCall[] = [];
    let resolvedBlob: Blob | undefined;
    const canvas = {
      toBlob: (cb: (blob: Blob | null) => void, type: string, quality: number) => {
        calls.push({ type, quality });
        resolvedBlob = new Blob([], { type });
        cb(resolvedBlob);
      },
    } as unknown as HTMLCanvasElement;

    const result = await canvasToJpegBlob(canvas);

    expect(calls).toEqual([{ type: "image/jpeg", quality: 0.9 }]);
    expect(result).toBe(resolvedBlob as Blob);
  });

  test("(d) rejects with 'toBlob returned null' when toBlob yields no blob", async () => {
    const canvas = {
      toBlob: (cb: (blob: Blob | null) => void) => cb(null),
    } as unknown as HTMLCanvasElement;

    await expect(canvasToJpegBlob(canvas)).rejects.toThrow("toBlob returned null");
  });
});

describe("reencodeJpeg", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).createImageBitmap;
    delete (globalThis as Record<string, unknown>).document;
  });

  test("(a) re-encodes as JPEG at quality 0.9 and closes the source bitmap", async () => {
    const { closeCalls, toBlobCalls } = installFakeDom({ bitmapWidth: 800, bitmapHeight: 600 });

    await reencodeJpeg(new Blob([], { type: "image/png" }));

    expect(toBlobCalls).toEqual([{ type: "image/jpeg", quality: 0.9 }]);
    expect(closeCalls).toHaveLength(1);
  });

  test("(b) down-scales 4000x2000 to 2000x1000 at maxEdge=2000", async () => {
    const { canvas } = installFakeDom({ bitmapWidth: 4000, bitmapHeight: 2000 });

    await reencodeJpeg(new Blob([], { type: "image/png" }), 2000);

    expect(canvas.width).toBe(2000);
    expect(canvas.height).toBe(1000);
  });

  test("(c) never upscales — 800x600 stays 800x600 under the default maxEdge", async () => {
    const { canvas } = installFakeDom({ bitmapWidth: 800, bitmapHeight: 600 });

    await reencodeJpeg(new Blob([], { type: "image/png" }));

    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
  });

  test("(e) throws 'canvas 2d context unavailable' when getContext returns null", async () => {
    installFakeDom({ bitmapWidth: 800, bitmapHeight: 600, contextUnavailable: true });

    await expect(reencodeJpeg(new Blob([], { type: "image/png" }))).rejects.toThrow(
      "canvas 2d context unavailable",
    );
  });
});
