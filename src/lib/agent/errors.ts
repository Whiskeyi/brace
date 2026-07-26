import type { AgentErrorInfo } from "./types";

export class AgentRuntimeFailure extends Error {
  constructor(readonly info: AgentErrorInfo) {
    super(info.message);
    this.name = "AgentRuntimeFailure";
  }
}

export class AgentModelFailure extends Error {
  constructor(
    readonly code: "invalid_model_response" | "llm_error",
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentModelFailure";
  }
}
