import type { AgentEvent } from "./types";

export function encodeAgentEvent(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function* encodeAgentEvents(
  events: AsyncIterable<AgentEvent>,
): AsyncGenerator<string, void, void> {
  for await (const event of events) {
    yield encodeAgentEvent(event);
  }
}

export function agentEventsToSSE(
  events: AsyncIterable<AgentEvent>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = encodeAgentEvents(events)[Symbol.asyncIterator]();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
