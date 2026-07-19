import { createContext, useContext, type ReactNode } from "react";
import type { ImageUploadAdapter } from "@metaobjectsdev/runtime-web";

const ImageUploadAdapterContext = createContext<ImageUploadAdapter | null>(null);

export interface ImageUploadAdapterProviderProps {
  value: ImageUploadAdapter;
  children: ReactNode;
}

/** Wrap your app (or the relevant subtree) to supply an upload/serve adapter to <ImageUpload>. */
export function ImageUploadAdapterProvider({ value, children }: ImageUploadAdapterProviderProps) {
  return <ImageUploadAdapterContext.Provider value={value}>{children}</ImageUploadAdapterContext.Provider>;
}

/** Reads the image upload adapter from context. Throws if not provided. */
export function useImageUploadAdapter(): ImageUploadAdapter {
  const adapter = useContext(ImageUploadAdapterContext);
  if (!adapter) {
    throw new Error(
      "useImageUploadAdapter() called outside <ImageUploadAdapterProvider>. " +
        "Wrap your app (or the relevant subtree) with ImageUploadAdapterProvider value={...}.",
    );
  }
  return adapter;
}
