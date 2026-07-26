import { z } from "zod";

import {
  SandboxError,
  type SandboxPort,
  type SandboxRunResult,
} from "../../sandbox/types";
import { AgentToolError } from "../types";
import type { CodingTool } from "./tools";

const runCommandSchema = z
  .object({
    executable: z.string().min(1).max(4_096),
    args: z.array(z.string().max(65_536)).max(256).default([]),
    cwd: z.string().min(1).max(4_096).default("."),
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
  })
  .strict();

export function createRunCommandTool(
  sandbox: SandboxPort,
): CodingTool<z.infer<typeof runCommandSchema>, SandboxRunResult> {
  return {
    name: "run_command",
    description:
      "Run one allowlisted executable directly with a separate argument array inside a workspace-relative cwd. Shell command strings, absolute cwd paths, and parent traversal are rejected.",
    schema: runCommandSchema,
    annotations: Object.freeze({
      effect: "execute",
      idempotent: false,
      requiresApproval: true,
      concurrencyKey: "coding-workspace",
    }),
    async execute(input, context) {
      let result: SandboxRunResult;
      try {
        result = await sandbox.run({ ...input, signal: context.signal });
      } catch (error) {
        if (!(error instanceof SandboxError)) throw error;
        throw new AgentToolError(
          `run_command failed: ${error.message}`,
          error.code === "IO_ERROR" || error.code === "SPAWN_FAILED",
          { code: error.code },
          { cause: error },
        );
      }
      if (result.terminationReason !== "exit") {
        throw new AgentToolError(
          `run_command was terminated: ${result.terminationReason}.`,
          result.terminationReason === "timeout" ||
            result.terminationReason === "output_limit",
          {
            terminationReason: result.terminationReason,
            exitCode: result.exitCode,
            truncated: result.truncated,
          },
        );
      }
      return result;
    },
  };
}
