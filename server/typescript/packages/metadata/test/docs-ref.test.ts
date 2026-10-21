import { describe, expect, test } from "bun:test";
import { docsRefForVersion, docsBlobUrl, pinDocsRefs } from "../src/docs-ref.js";
import { guideUrl, metadataPackageVersion, physicalNamingGuideUrl } from "../src/release-docs.js";

describe("docs refs pin to the release tag", () => {
  test("a release pins to v<version>", () => {
    expect(docsRefForVersion("1.1.0")).toBe("v1.1.0");
    expect(docsRefForVersion(" 1.0.13 ")).toBe("v1.0.13");
  });
  test("a prerelease, the unresolved sentinel and junk keep main", () => {
    for (const v of ["1.1.0-rc.7", "1.1.0-SNAPSHOT", "0.0.0", "", "latest"]) expect(docsRefForVersion(v)).toBe("main");
  });
  test("docsBlobUrl and pinDocsRefs", () => {
    expect(docsBlobUrl("docs/a.md", "v1.1.0")).toBe("https://github.com/metaobjectsdev/metaobjects/blob/v1.1.0/docs/a.md");
    const text = "see https://github.com/metaobjectsdev/metaobjects/blob/main/docs/a.md and https://example.com/blob/main/x";
    expect(pinDocsRefs(text, "v1.1.0")).toBe(
      "see https://github.com/metaobjectsdev/metaobjects/blob/v1.1.0/docs/a.md and https://example.com/blob/main/x",
    );
    expect(pinDocsRefs(text, "main")).toBe(text);
  });
  test("guideUrl derives from this package's version, never a literal", () => {
    expect(guideUrl("docs/a.md")).toBe(docsBlobUrl("docs/a.md", docsRefForVersion(metadataPackageVersion())));
    expect(metadataPackageVersion()).not.toBe("0.0.0");
  });
});

test("the physical-naming guide is pinned the same way", () => {
  expect(physicalNamingGuideUrl()).toBe(guideUrl("docs/features/migrations/physical-naming.md"));
});
