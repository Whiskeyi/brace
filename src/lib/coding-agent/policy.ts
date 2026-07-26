import type {
  ToolPolicy,
  ToolPolicyDecision,
  ToolPolicyRequest,
} from "../agent/types";
import type { ToolEffect } from "../tools/types";

export const APPROVED_TOOLS_METADATA_KEY = "approvedTools" as const;

const RESTRICTED_EFFECTS: ReadonlySet<ToolEffect> = new Set([
  "write",
  "execute",
  "network",
]);

/**
 * Read access is the only ambient capability. Every stronger capability is
 * authorized by an exact tool name in the current run's metadata.
 */
export const codingAgentToolPolicy: ToolPolicy = Object.freeze({
  evaluate({ tool, context }: ToolPolicyRequest): ToolPolicyDecision {
    const effect = tool.annotations?.effect;
    if (effect === "read") return { allowed: true };

    if (
      effect &&
      RESTRICTED_EFFECTS.has(effect) &&
      approvedToolNames(context.metadata).has(tool.name)
    ) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: effect
        ? `Tool "${tool.name}" with ${effect} access is not approved for this run.`
        : `Tool "${tool.name}" is denied because it has no trusted effect annotation.`,
    };
  },
});

/**
 * Adds an interactive host policy without weakening the built-in coding
 * boundary. Read tools remain ambient, exact per-run preauthorization keeps
 * working, and only trusted restricted-effect tools may reach the host policy.
 */
export function createCodingAgentToolPolicy(
  interactivePolicy?: ToolPolicy,
): ToolPolicy {
  if (!interactivePolicy) return codingAgentToolPolicy;

  return Object.freeze({
    async evaluate(
      request: ToolPolicyRequest,
    ): Promise<ToolPolicyDecision> {
      const effect = request.tool.annotations?.effect;
      if (effect === "read") return { allowed: true };
      if (!effect || !RESTRICTED_EFFECTS.has(effect)) {
        return {
          allowed: false,
          reason: `Tool "${request.tool.name}" is denied because it has no trusted restricted-effect annotation.`,
        };
      }
      if (
        approvedToolNames(request.context.metadata).has(request.tool.name)
      ) {
        return { allowed: true };
      }
      return interactivePolicy.evaluate(request);
    },
  });
}

function approvedToolNames(
  metadata: Readonly<Record<string, unknown>> | undefined,
): ReadonlySet<string> {
  const candidate = metadata?.[APPROVED_TOOLS_METADATA_KEY];
  if (
    !Array.isArray(candidate) ||
    !candidate.every((name): name is string => typeof name === "string")
  ) {
    return new Set();
  }
  return new Set(candidate);
}
