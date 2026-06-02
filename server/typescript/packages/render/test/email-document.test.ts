import { describe, test, expect } from "bun:test";
import type { EmailDocument } from "../src/index.js";

describe("EmailDocument", () => {
  test("constructs with all fields", () => {
    const doc: EmailDocument = {
      subject: "Hello",
      htmlBody: "<p>Hi</p>",
      textBody: "Hi",
    };
    expect(doc.subject).toBe("Hello");
    expect(doc.htmlBody).toBe("<p>Hi</p>");
    expect(doc.textBody).toBe("Hi");
  });

  test("textBody is optional (plain-text alternative omitted)", () => {
    const doc: EmailDocument = { subject: "S", htmlBody: "<b>H</b>" };
    expect(doc.subject).toBe("S");
    expect(doc.htmlBody).toBe("<b>H</b>");
    expect(doc.textBody).toBeUndefined();
  });
});
