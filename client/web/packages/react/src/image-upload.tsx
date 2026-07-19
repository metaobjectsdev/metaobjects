import { lazy, Suspense, useCallback, useRef, useState } from "react";
import type { ChangeEvent, ReactElement } from "react";
import type { Area } from "react-easy-crop";
import type { ImageMeta } from "@metaobjectsdev/runtime-web";
import { useImageUploadAdapter } from "./image-adapter-provider.js";
import { cropToBlob } from "./crop-to-blob.js";

// react-easy-crop is an optional peer dependency — loaded lazily so consumers
// who don't use <ImageUpload> never pay for it.
const Cropper = lazy(() => import("react-easy-crop"));

export interface ImageUploadProps {
  /** Current stored image key, or null/undefined when no image is set. */
  value?: string | null;
  /** Called with the new stored image key, or null when the image is removed. */
  onChange: (key: string | null) => void;
  /** Resolved view.image attrs (aspectRatio / maxEdge / store / accept / maxBytes). */
  meta: ImageMeta;
}

/**
 * Metadata-driven image upload + crop control. Renders a preview plus
 * Upload/Replace/Remove actions when idle, and a lazy-loaded crop UI
 * (react-easy-crop) while a picked file is being cropped. On save, crops the
 * selection to a bounded JPEG and hands the blob to the adapter supplied via
 * <ImageUploadAdapterProvider> — this component has no knowledge of the
 * storage backend, upload endpoint, or auth.
 *
 * Bound by the generated form's `view.image` field; usable standalone too.
 */
export function ImageUpload({ value, onChange, meta }: ImageUploadProps): ReactElement {
  const adapter = useImageUploadAdapter();
  const [editing, setEditing] = useState<string | null>(null); // object URL being cropped
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const areaRef = useRef<Area | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = (meta.accept ?? ["image/jpeg", "image/png", "image/webp"]).join(",");

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (meta.maxBytes && file.size > meta.maxBytes) return; // client guard; server re-enforces
    setError(null);
    setEditing(URL.createObjectURL(file));
  };

  const onSave = useCallback(async () => {
    if (!editing || !areaRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await cropToBlob(editing, areaRef.current, meta.maxEdge ?? 2000);
      // exactOptionalPropertyTypes: only forward `store` when the caller supplied one.
      const { key } = await adapter.upload(blob, { ...(meta.store !== undefined && { store: meta.store }) });
      onChange(key);
      URL.revokeObjectURL(editing);
      setEditing(null);
    } catch {
      // Crop/upload failed (adapter rejected the image, network drop, etc).
      // Leave `editing` in place so the user's crop selection isn't lost —
      // they can retry Save crop without re-picking the file.
      setError("Something went wrong saving that image. Try again.");
    } finally {
      setBusy(false);
    }
  }, [editing, meta.maxEdge, meta.store, adapter, onChange]);

  return (
    <div className="metaobjects-image-upload">
      {value && !editing && (
        <img src={adapter.imageUrl(value)} alt="" className="metaobjects-image-preview" />
      )}
      {!editing && (
        <div className="metaobjects-image-actions">
          <label className="metaobjects-form-submit">
            {value ? "Replace" : "Upload"}
            <input type="file" accept={accept} onChange={onPick} hidden />
          </label>
          {value && (
            <button type="button" className="metaobjects-form-submit" onClick={() => onChange(null)}>
              Remove
            </button>
          )}
        </div>
      )}
      {editing && (
        <div className="metaobjects-image-cropper">
          <Suspense fallback={<p>Loading cropper…</p>}>
            <div style={{ position: "relative", height: 320 }}>
              <Cropper
                image={editing}
                crop={crop}
                zoom={zoom}
                aspect={meta.aspectRatio}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={(_croppedArea, croppedAreaPixels) => (areaRef.current = croppedAreaPixels)}
              />
            </div>
          </Suspense>
          <div className="metaobjects-image-actions">
            <button type="button" className="metaobjects-form-submit" disabled={busy} onClick={onSave}>
              {busy ? "Saving…" : "Save crop"}
            </button>
            <button
              type="button"
              className="metaobjects-form-submit"
              disabled={busy}
              onClick={() => {
                URL.revokeObjectURL(editing);
                setEditing(null);
              }}
            >
              Cancel
            </button>
          </div>
          {error && (
            <span className="metaobjects-field-error" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
