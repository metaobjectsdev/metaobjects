// meta fmt — issue #304: expose the canonical serializer as a formatting
// primitive. `formatMetadataFile` formats ONE file's own content (own-mode,
// declared-here layer only) by parsing it STANDALONE (no cross-file merge,
// deferred super resolution so an `extends` onto another file's base is
// never an error here) and re-emitting it via the existing canonical
// serializer. It never attempts to resolve an `overlay: true` declaration
// against a base outside this file — that surfaces as ERR_OVERLAY_NO_TARGET,
// reported back as `overlay: true` so a caller can skip the file untouched.

import { describe, it, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import { formatMetadataFile } from "../src/fmt.js";

const registry = composeRegistry(coreProviders);

describe("formatMetadataFile", () => {
  it("reformats a messy-but-valid file into canonical form", () => {
    const messy = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              "@description": "a widget",
              name: "Widget",
              children: [
                { "field.string": { name: "name", "@required": true } },
              ],
            },
          },
        ],
      },
    });

    const result = formatMetadataFile(messy, { registry, sourceId: "meta.widget.json" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Canonical key order: name, package, children — no @description before name.
    expect(result.text).toBe(
      JSON.stringify(
        {
          "metadata.root": {
            package: "acme",
            children: [
              {
                "object.entity": {
                  name: "Widget",
                  "@description": "a widget",
                  children: [
                    { "field.string": { name: "name", "@required": true } },
                  ],
                },
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );
  });

  it("is idempotent — formatting its own output changes nothing", () => {
    const messy = JSON.stringify({
      "metadata.root": {
        children: [
          { "object.entity": { name: "B", children: [] } },
          { "object.entity": { name: "A", children: [] } },
        ],
      },
    });
    const once = formatMetadataFile(messy, { registry, sourceId: "a.json" });
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = formatMetadataFile(once.text, { registry, sourceId: "a.json" });
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.text).toBe(once.text);
  });

  it("preserves a cross-file extends ref without erroring (deferred super resolution)", () => {
    const doc = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [
          { "object.entity": { name: "Car", extends: "acme::Vehicle", children: [] } },
        ],
      },
    });
    const result = formatMetadataFile(doc, { registry, sourceId: "meta.car.json" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('"extends": "acme::Vehicle"');
  });

  it("normalizes a scalar @fields into its canonical array form", () => {
    const doc = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "User",
              children: [
                { "field.string": { name: "email" } },
                { "identity.secondary": { name: "byEmail", "@fields": "email" } },
              ],
            },
          },
        ],
      },
    });
    const result = formatMetadataFile(doc, { registry, sourceId: "meta.user.json" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.text)).toMatchObject({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              children: expect.arrayContaining([
                { "identity.secondary": { name: "byEmail", "@fields": ["email"] } },
              ]),
            },
          },
        ],
      },
    });
  });

  it("reports overlay: true for a file whose overlay declaration has no local base", () => {
    const doc = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "User",
              overlay: true,
              children: [{ "field.string": { name: "nickname" } }],
            },
          },
        ],
      },
    });
    const result = formatMetadataFile(doc, { registry, sourceId: "meta.user.ui.json" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.overlay).toBe(true);
  });

  it("still formats the plain sibling in a mixed file, but reports the whole file as overlay", () => {
    const doc = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [
          { "object.entity": { name: "Plain", children: [] } },
          { "object.entity": { name: "Other", overlay: true, children: [] } },
        ],
      },
    });
    const result = formatMetadataFile(doc, { registry, sourceId: "mixed.json" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.overlay).toBe(true);
  });

  it("reports a non-overlay error (not overlay) for structurally invalid metadata", () => {
    const doc = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [{ "object.thisSubtypeDoesNotExist": { name: "Bogus", children: [] } }],
      },
    });
    const result = formatMetadataFile(doc, { registry, sourceId: "bad.json" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.overlay).toBe(false);
  });

  it("reports an error for invalid JSON", () => {
    const result = formatMetadataFile("{ not json", { registry, sourceId: "broken.json" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.overlay).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });
});
