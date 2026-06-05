import { describe, expect, test } from "bun:test";
import { OpenAIClient, type OpenAILike } from "../src/openai.js";

const fakeSdk: OpenAILike = {
  chat: {
    completions: {
      async create(args) {
        return {
          choices: [{ message: { content: `reply:${args.messages.at(-1)!.content}` }, finish_reason: "stop" }],
          model: "gpt-4o-mini-x",
          usage: { prompt_tokens: 5, completion_tokens: 7 },
        };
      },
    },
  },
};

describe("OpenAIClient", () => {
  test("maps LlmRequest → chat.completions.create → LlmCompletion", async () => {
    const client = new OpenAIClient(fakeSdk);
    const out = await client.complete({ prompt: "hi", model: "gpt-4o-mini", system: "sys" });
    expect(out.body).toBe("reply:hi");
    expect(out.model).toBe("gpt-4o-mini-x");
    expect(out.finishReason).toBe("stop");
    expect(out.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
  });
});
