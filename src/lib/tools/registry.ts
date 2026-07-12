import { z } from "zod";

import type { AgentTool, OpenAIToolDefinition } from "./types";

export class ToolRegistry {
  readonly #tools = new Map<string, AgentTool>();

  constructor(tools: readonly AgentTool[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: AgentTool, options: { readonly replace?: boolean } = {}): this {
    assertValidToolName(tool.name);

    if (this.#tools.has(tool.name) && !options.replace) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }

    this.#tools.set(tool.name, tool);
    return this;
  }

  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  get(name: string): AgentTool | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  list(): readonly AgentTool[] {
    return [...this.#tools.values()];
  }

  toOpenAITools(): readonly OpenAIToolDefinition[] {
    return this.list().map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? schemaToJsonSchema(tool.schema),
      },
    }));
  }
}

function schemaToJsonSchema(schema: AgentTool["schema"]): Readonly<Record<string, unknown>> {
  const jsonSchema: Record<string, unknown> = { ...z.toJSONSchema(schema) };
  delete jsonSchema.$schema;
  return jsonSchema;
}

function assertValidToolName(name: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error(
      `Invalid tool name "${name}". Use 1-64 letters, numbers, underscores, or hyphens.`,
    );
  }
}
