import { z } from "zod";

import {
  modelBaseUrlSchema,
  modelProviderIdSchema,
} from "../model-providers";

export const localIdSchema = z.string().trim().min(1).max(128);

export const startLocalTaskSchema = z
  .object({
    projectId: localIdSchema,
    threadId: localIdSchema.optional(),
    prompt: z.string().trim().min(1).max(65_536),
    mode: z.enum(["local", "worktree"]).default("local"),
  })
  .strict();

export const decideLocalApprovalSchema = z
  .object({
    approvalId: localIdSchema,
    decision: z.enum(["allow_once", "deny"]),
  })
  .strict();

export const localThreadRequestSchema = z
  .object({ threadId: localIdSchema })
  .strict();

export const localRunRequestSchema = z
  .object({ runId: localIdSchema })
  .strict();

export const resolveLocalWorktreeSchema = z
  .object({
    threadId: localIdSchema,
    action: z.enum(["apply", "discard", "cleanup"]),
    confirmed: z.literal(true),
  })
  .strict();

export const saveLocalModelSettingsSchema = z
  .object({
    provider: modelProviderIdSchema.optional(),
    baseUrl: z.preprocess(
      (value) => (typeof value === "string" ? value.trim() : value),
      z.union([z.literal(""), modelBaseUrlSchema]),
    ),
    model: z.string().trim().min(1).max(200),
    apiKey: z.string().trim().min(8).max(8_192).optional(),
    clearApiKey: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.apiKey && value.clearApiKey) {
      context.addIssue({
        code: "custom",
        message: "A new API key and clearApiKey cannot be used together.",
      });
    }
  });

export type StartLocalTaskInput = z.input<typeof startLocalTaskSchema>;
export type DecideLocalApprovalInput = z.input<
  typeof decideLocalApprovalSchema
>;
export type ResolveLocalWorktreeInput = z.input<
  typeof resolveLocalWorktreeSchema
>;
export type SaveLocalModelSettingsInput = z.input<
  typeof saveLocalModelSettingsSchema
>;
