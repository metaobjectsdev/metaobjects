import "./setup.js";
import { describe, test, expect, afterEach } from "bun:test";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";
import React from "react";
import type { ImageUploadAdapter } from "@metaobjectsdev/runtime-web";
import { ImageUpload } from "../src/image-upload.js";
import { ImageUploadAdapterProvider } from "../src/image-adapter-provider.js";

afterEach(() => {
  cleanup();
});

function mockAdapter(): ImageUploadAdapter {
  return {
    upload: async (_blob, _opts) => ({ key: "uploaded-key" }),
    imageUrl: (key) => `https://example.test/images/${key}`,
  };
}

// NOTE: the crop -> upload flow (picking a file, driving react-easy-crop,
// clicking "Save crop") is not exercised here — react-easy-crop is loaded
// lazily via React.lazy/Suspense and is out of scope for this unit test
// (see the task brief); that flow is covered by the reference
// implementation's e2e tests. This suite asserts adapter wiring + the
// controlled idle-state behavior only.

describe("ImageUpload — adapter wiring", () => {
  test("renders the preview image via adapter.imageUrl(value) when a value is set", () => {
    const adapter = mockAdapter();
    // alt="" is intentional (decorative preview) — that makes the accessible
    // role "presentation" rather than "img", so query by class instead of
    // getByRole("img").
    const { container } = render(
      <ImageUploadAdapterProvider value={adapter}>
        <ImageUpload value="k1" onChange={() => {}} meta={{ store: "photos" }} />
      </ImageUploadAdapterProvider>,
    );
    const img = container.querySelector<HTMLImageElement>("img.metaobjects-image-preview");
    expect(img).not.toBeNull();
    expect(img!.src).toBe(adapter.imageUrl("k1"));
  });

  test("renders no preview image when value is null", () => {
    const adapter = mockAdapter();
    const { container } = render(
      <ImageUploadAdapterProvider value={adapter}>
        <ImageUpload value={null} onChange={() => {}} meta={{ store: "photos" }} />
      </ImageUploadAdapterProvider>,
    );
    expect(container.querySelector("img.metaobjects-image-preview")).toBeNull();
  });
});

describe("ImageUpload — Remove", () => {
  test("clicking Remove calls onChange(null)", () => {
    const adapter = mockAdapter();
    let received: string | null | undefined;
    render(
      <ImageUploadAdapterProvider value={adapter}>
        <ImageUpload
          value="k1"
          onChange={(key) => {
            received = key;
          }}
          meta={{ store: "photos" }}
        />
      </ImageUploadAdapterProvider>,
    );
    fireEvent.click(screen.getByText("Remove"));
    expect(received).toBeNull();
  });
});

describe("ImageUpload — missing provider", () => {
  test("throws the clear useImageUploadAdapter() error when rendered without a provider", () => {
    expect(() =>
      render(<ImageUpload value={null} onChange={() => {}} meta={{ store: "photos" }} />),
    ).toThrow(/useImageUploadAdapter\(\) called outside <ImageUploadAdapterProvider>/);
  });
});
