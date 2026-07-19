/** The upload/serve seam a consumer implements for <ImageUpload>. The library ships
 *  no concrete adapter — the app supplies one (see docs). `store` is an opaque
 *  namespace hint from view.image's @store attr, not infrastructure. */
export interface ImageUploadAdapter {
  upload(blob: Blob, opts: { store?: string }): Promise<{ key: string }>;
  imageUrl(key: string): string;
}

/** view.image's declared attrs, resolved into props for <ImageUpload>. */
export interface ImageMeta {
  aspectRatio?: number;
  maxEdge?: number;
  store?: string;
  accept?: string[];
  maxBytes?: number;
}
