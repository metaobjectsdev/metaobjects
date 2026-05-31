// FR-010 artifact-1 output-format prompt renderer.
//
// Mirrors the Java OutputFormatRenderer{Guide,Inline,ExampleOnly}Test +
// OutputFormatSpecModelTest — the rendered text is a cross-port invariant, so
// these assertions match Java/C# exactly. JSON fragments are validated by
// extracting the first `{` … last `}` and running JSON.parse.

import { describe, expect, test } from "bun:test";
import {
  type OutputFormatSpec,
  type PromptField,
  PromptStyle,
  promptStyleFrom,
  type PromptOverrides,
  PROMPT_OVERRIDES_NONE,
  renderOutputFormat,
} from "../../src/index.js";
import { FieldKind, Format } from "../../src/extract/types.js";

/** The JSON substring of a fragment: first `{` to last `}`. Mirrors the Java tests. */
function extractJson(fragment: string): Record<string, unknown> {
  const open = fragment.indexOf("{");
  const close = fragment.lastIndexOf("}");
  return JSON.parse(fragment.substring(open, close + 1)) as Record<string, unknown>;
}

function field(
  name: string,
  kind: FieldKind,
  required: boolean,
  opts: Partial<Omit<PromptField, "name" | "kind" | "required">> = {},
): PromptField {
  return {
    name,
    kind,
    required,
    array: opts.array ?? false,
    enumValues: opts.enumValues ?? null,
    enumDoc: opts.enumDoc ?? null,
    example: opts.example ?? null,
    instruction: opts.instruction ?? null,
    nested: opts.nested ?? null,
  };
}

// ===== GUIDE =====

function guideSpec(): OutputFormatSpec {
  return {
    format: Format.XML,
    rootName: "Answer",
    style: PromptStyle.GUIDE,
    fields: [
      field("text", FieldKind.STRING, true, {
        example: "Your refund will appear in 3-5 days.",
        instruction: "One or two sentences to the customer.",
      }),
      field("confidence", FieldKind.ENUM, true, {
        enumValues: ["HIGH", "LOW"],
        enumDoc: { HIGH: "Directly supported.", LOW: "A guess." },
        example: "HIGH",
      }),
      field("note", FieldKind.STRING, false),
    ],
  };
}

describe("guide style", () => {
  test("lists fields required/optional and enum docs without comments", () => {
    const out = renderOutputFormat(guideSpec(), PROMPT_OVERRIDES_NONE);
    expect(out).not.toContain("<!--");
    expect(out).toContain("text (required)");
    expect(out).toContain("One or two sentences to the customer.");
    expect(out).toContain("confidence (required)");
    expect(out).toContain("HIGH = Directly supported.");
    expect(out).toContain("LOW = A guess.");
    expect(out).toContain("note (optional)");
    expect(out).toContain("Respond exactly like this:");
    expect(out).toContain("<Answer>");
    expect(out).toContain("<text>Your refund will appear in 3-5 days.</text>");
    expect(out).toContain("<confidence>HIGH</confidence>");
  });

  test("instruction override wins", () => {
    const ov: PromptOverrides = { instructions: { text: "NEW INSTRUCTION" } };
    expect(renderOutputFormat(guideSpec(), ov)).toContain("NEW INSTRUCTION");
  });

  test("guide json skeleton is valid json even with prose braces above", () => {
    const s: OutputFormatSpec = {
      format: Format.JSON,
      rootName: "Answer",
      style: PromptStyle.GUIDE,
      fields: [
        field("text", FieldKind.STRING, true, { example: "hi {now}", instruction: "say {x}" }),
        field("confidence", FieldKind.ENUM, true, {
          enumValues: ["HIGH", "LOW"],
          enumDoc: { HIGH: "Directly supported." },
          example: "HIGH",
        }),
      ],
    };
    const out = renderOutputFormat(s, PROMPT_OVERRIDES_NONE);
    const afterMarker = out.substring(out.indexOf("Respond exactly like this:"));
    const node = extractJson(afterMarker);
    expect(node.text).toBe("hi {now}");
    expect(node.confidence).toBe("HIGH");
  });
});

// ===== INLINE =====

function inlineSpec(f: Format): OutputFormatSpec {
  return {
    format: f,
    rootName: "Answer",
    style: PromptStyle.INLINE,
    fields: [
      field("text", FieldKind.STRING, true, { instruction: "one sentence" }),
      field("confidence", FieldKind.ENUM, true, { enumValues: ["HIGH", "OK", "LOW"] }),
    ],
  };
}

describe("inline style", () => {
  test("xml inline choices, no comments", () => {
    const out = renderOutputFormat(inlineSpec(Format.XML), PROMPT_OVERRIDES_NONE);
    expect(out).not.toContain("<!--");
    expect(out).toContain("<confidence>HIGH | OK | LOW</confidence>");
    expect(out).toContain("<text>");
    expect(out).toContain("</Answer>");
  });

  test("json inline still valid", () => {
    const out = renderOutputFormat(inlineSpec(Format.JSON), PROMPT_OVERRIDES_NONE);
    expect(extractJson(out).confidence).toBe("HIGH | OK | LOW");
  });

  test("boolean inline renders true | false", () => {
    const s: OutputFormatSpec = {
      format: Format.XML,
      rootName: "Answer",
      style: PromptStyle.INLINE,
      fields: [field("flag", FieldKind.BOOLEAN, true)],
    };
    expect(renderOutputFormat(s, PROMPT_OVERRIDES_NONE)).toContain("<flag>true | false</flag>");
  });
});

// ===== EXAMPLE-ONLY =====

function exampleOnlySpec(fmt: Format): OutputFormatSpec {
  return {
    format: fmt,
    rootName: "Answer",
    style: PromptStyle.EXAMPLE_ONLY,
    fields: [
      field("text", FieldKind.STRING, true, { example: "hello" }),
      field("confidence", FieldKind.ENUM, true, { enumValues: ["HIGH", "LOW"], example: "HIGH" }),
    ],
  };
}

describe("exampleOnly style", () => {
  test("xml is well-formed and comment-free", () => {
    const out = renderOutputFormat(exampleOnlySpec(Format.XML), PROMPT_OVERRIDES_NONE);
    expect(out).not.toContain("<!--");
    expect(out).toContain("<Answer>");
    expect(out).toContain("<text>hello</text>");
    expect(out).toContain("<confidence>HIGH</confidence>");
    expect(out).toContain("</Answer>");
  });

  test("json example block is valid json", () => {
    const out = renderOutputFormat(exampleOnlySpec(Format.JSON), PROMPT_OVERRIDES_NONE);
    const node = extractJson(out);
    expect(node.text).toBe("hello");
    expect(node.confidence).toBe("HIGH");
  });

  test("example override wins", () => {
    const ov: PromptOverrides = { examples: { text: "OVERRIDDEN" } };
    const out = renderOutputFormat(exampleOnlySpec(Format.XML), ov);
    expect(out).toContain("<text>OVERRIDDEN</text>");
  });

  test("NaN double stays valid json, quoted", () => {
    const s: OutputFormatSpec = {
      format: Format.JSON,
      rootName: "Answer",
      style: PromptStyle.EXAMPLE_ONLY,
      fields: [field("score", FieldKind.DOUBLE, true, { example: "NaN" })],
    };
    const out = renderOutputFormat(s, PROMPT_OVERRIDES_NONE);
    expect(extractJson(out).score).toBe("NaN"); // quoted string, valid JSON
  });

  test("finite double renders unquoted number", () => {
    const s: OutputFormatSpec = {
      format: Format.JSON,
      rootName: "Answer",
      style: PromptStyle.EXAMPLE_ONLY,
      fields: [field("score", FieldKind.DOUBLE, true, { example: "0.85" })],
    };
    const out = renderOutputFormat(s, PROMPT_OVERRIDES_NONE);
    expect(extractJson(out).score).toBe(0.85); // unquoted JSON number
  });

  test("url value does not break json", () => {
    const s: OutputFormatSpec = {
      format: Format.JSON,
      rootName: "Answer",
      style: PromptStyle.EXAMPLE_ONLY,
      fields: [field("link", FieldKind.STRING, true, { example: "https://example.com/x" })],
    };
    const out = renderOutputFormat(s, PROMPT_OVERRIDES_NONE);
    expect(extractJson(out).link).toBe("https://example.com/x");
  });

  test("json value with quotes stays valid", () => {
    const s: OutputFormatSpec = {
      format: Format.JSON,
      rootName: "Answer",
      style: PromptStyle.EXAMPLE_ONLY,
      fields: [field("q", FieldKind.STRING, true, { example: 'she said "hi"' })],
    };
    const out = renderOutputFormat(s, PROMPT_OVERRIDES_NONE);
    expect(extractJson(out).q).toBe('she said "hi"');
  });
});

// ===== MODEL =====

describe("model + style mapping", () => {
  test("builds spec", () => {
    const f = field("confidence", FieldKind.ENUM, true, {
      enumValues: ["HIGH", "LOW"],
      enumDoc: { HIGH: "Directly supported." },
      example: "HIGH",
      instruction: "Pick one.",
    });
    const s: OutputFormatSpec = {
      format: Format.XML,
      rootName: "Answer",
      style: PromptStyle.GUIDE,
      fields: [f],
    };
    expect(s.style).toBe(PromptStyle.GUIDE);
    expect(s.fields[0]!.enumDoc!.HIGH).toBe("Directly supported.");
  });

  test("none-overrides defaults empty", () => {
    expect(PROMPT_OVERRIDES_NONE.style).toBeUndefined();
    expect(PROMPT_OVERRIDES_NONE.examples).toEqual({});
    expect(PROMPT_OVERRIDES_NONE.instructions).toEqual({});
  });

  test("override style switches the rendered style", () => {
    // guideSpec defaults to GUIDE; an exampleOnly override yields just the skeleton.
    const ov: PromptOverrides = { style: PromptStyle.EXAMPLE_ONLY };
    const out = renderOutputFormat(guideSpec(), ov);
    expect(out).not.toContain("Fill in each field as described below:");
    expect(out.startsWith("<Answer>")).toBe(true);
  });

  test("promptStyleFrom maps the wire vocabulary, unknown/null -> guide", () => {
    expect(promptStyleFrom("inline")).toBe(PromptStyle.INLINE);
    expect(promptStyleFrom("exampleOnly")).toBe(PromptStyle.EXAMPLE_ONLY);
    expect(promptStyleFrom("guide")).toBe(PromptStyle.GUIDE);
    expect(promptStyleFrom(null)).toBe(PromptStyle.GUIDE);
    expect(promptStyleFrom(undefined)).toBe(PromptStyle.GUIDE);
    expect(promptStyleFrom("whatever")).toBe(PromptStyle.GUIDE);
  });
});

// ===== regression: edge cases the pre-merge review caught =====

describe("json edge cases (cross-port parity)", () => {
  test("empty fields render `{\\n}` not `{\\n\\n}`", () => {
    const empty = (style: PromptStyle): OutputFormatSpec => ({
      format: Format.JSON,
      rootName: "Empty",
      style,
      fields: [],
    });
    expect(renderOutputFormat(empty(PromptStyle.EXAMPLE_ONLY), PROMPT_OVERRIDES_NONE)).toContain("{\n}");
    expect(renderOutputFormat(empty(PromptStyle.EXAMPLE_ONLY), PROMPT_OVERRIDES_NONE)).not.toContain("{\n\n}");
    expect(renderOutputFormat(empty(PromptStyle.INLINE), PROMPT_OVERRIDES_NONE)).toContain("{\n}");
    // GUIDE appends the skeleton; its JSON block must still parse.
    expect(() => extractJson(renderOutputFormat(empty(PromptStyle.GUIDE), PROMPT_OVERRIDES_NONE))).not.toThrow();
  });

  test("JS-only radix-literal example on a numeric field stays quoted (valid JSON)", () => {
    for (const ex of ["0x1F", "0xFF", "0b101", "0o17"]) {
      const s: OutputFormatSpec = {
        format: Format.JSON,
        rootName: "N",
        style: PromptStyle.EXAMPLE_ONLY,
        fields: [field("score", FieldKind.INT, true, { example: ex })],
      };
      const out = renderOutputFormat(s, PROMPT_OVERRIDES_NONE);
      // Quoted → valid JSON, value preserved as the string (Java/C# parity).
      expect(extractJson(out).score).toBe(ex);
    }
  });

  test("finite numeric example renders unquoted", () => {
    const s: OutputFormatSpec = {
      format: Format.JSON,
      rootName: "N",
      style: PromptStyle.EXAMPLE_ONLY,
      fields: [field("score", FieldKind.DOUBLE, true, { example: "0.85" })],
    };
    expect(extractJson(renderOutputFormat(s, PROMPT_OVERRIDES_NONE)).score).toBe(0.85);
  });
});
