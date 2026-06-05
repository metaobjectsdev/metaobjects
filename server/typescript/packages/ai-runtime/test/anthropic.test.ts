import { describe, expect, test } from "bun:test";
import { AnthropicClient, type AnthropicLike } from "../src/anthropic.js";

const fakeSdk: AnthropicLike = {
  messages: {
    async create(args) {
      return {
        content: [{ type: "text", text: `reply-to:${args.messages[0]!.content}` }],
        model: "claude-3-5-haiku-x",
        stop_reason: "end_turn",
        usage: { input_tokens: 11, output_tokens: 22 },
      };
    },
  },
};

describe("AnthropicClient", () => {
  test("maps LlmRequest → messages.create → LlmCompletion", async () => {
    const client = new AnthropicClient(fakeSdk);
    const out = await client.complete({ prompt: "hello", model: "claude-3-5-haiku", system: "sys" });
    expect(out.body).toBe("reply-to:hello");
    expect(out.model).toBe("claude-3-5-haiku-x");
    expect(out.finishReason).toBe("end_turn");
    expect(out.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
    expect(out.request).toBeDefined();
  });
});
