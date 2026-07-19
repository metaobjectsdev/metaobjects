import type { Area } from "react-easy-crop";
import { canvasToJpegBlob } from "@metaobjectsdev/runtime-web";

/**
 * Draws the selected crop rectangle of `src` onto a canvas bounded to
 * `maxEdge` on its longest side, then re-encodes to JPEG. The canvas
 * redraw drops all EXIF/GPS metadata as a side effect.
 */
export async function cropToBlob(src: string, area: Area, maxEdge: number): Promise<Blob> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = src;
  });
  const scale = Math.min(1, maxEdge / Math.max(area.width, area.height));
  const w = Math.round(area.width * scale);
  const h = Math.round(area.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, w, h);
  return canvasToJpegBlob(canvas, 0.9);
}
