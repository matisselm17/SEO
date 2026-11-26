/**
 * Client Claude simulé : rejoue des tours scriptés (texte et appels d'outils) au format des événements
 * de flux du SDK. Enregistre les requêtes reçues pour vérification.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ChatClient } from "../../src/chat/assistant.ts";

export type Turn =
  | { text?: string[]; tools?: Array<{ name: string; input: Record<string, unknown> }> }
  | { error: unknown };

export function mockClaude(turns: Turn[]): ChatClient & { requests: Anthropic.MessageStreamParams[] } {
  const requests: Anthropic.MessageStreamParams[] = [];
  let i = 0;
  return {
    requests,
    messages: {
      stream(body) {
        requests.push(structuredClone(body));
        const turn = turns[i++] ?? { text: ["(fin du script)"] };
        const content: Anthropic.ContentBlock[] = [];
        const events: Anthropic.MessageStreamEvent[] = [];
        if ("error" in turn) {
          return {
            async *[Symbol.asyncIterator]() {
              throw turn.error;
            },
            finalMessage: () => Promise.reject(turn.error),
          };
        }
        let index = 0;
        if (turn.text?.length) {
          events.push({ type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } } as Anthropic.MessageStreamEvent);
          for (const t of turn.text) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } } as Anthropic.MessageStreamEvent);
          events.push({ type: "content_block_stop", index } as Anthropic.MessageStreamEvent);
          content.push({ type: "text", text: turn.text.join(""), citations: null } as Anthropic.ContentBlock);
          index++;
        }
        for (const [k, tool] of (turn.tools ?? []).entries()) {
          const block = { type: "tool_use", id: `toolu_${i}_${k}`, name: tool.name, input: tool.input } as Anthropic.ContentBlock;
          events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } } as Anthropic.MessageStreamEvent);
          events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } } as Anthropic.MessageStreamEvent);
          events.push({ type: "content_block_stop", index } as Anthropic.MessageStreamEvent);
          content.push(block);
          index++;
        }
        const final = {
          id: `msg_${i}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content,
          stop_reason: turn.tools?.length ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as Anthropic.Message;
        return {
          async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
          },
          finalMessage: async () => final,
        };
      },
    },
  };
}
