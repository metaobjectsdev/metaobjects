import { canvasToJpegBlob } from "./canvas-to-jpeg-blob.js";

/** Whole-image re-encode to JPEG (down-scaled to maxEdge, EXIF stripped via canvas). */
export async function reencodeJpeg(file: File | Blob, maxEdge = 2000): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvasToJpegBlob(canvas, 0.9);
}
