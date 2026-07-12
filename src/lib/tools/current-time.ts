import { z } from "zod";

import type { AgentTool } from "./types";

const currentTimeInputSchema = z
  .object({
    timeZone: z
      .string()
      .min(1)
      .optional()
      .describe("IANA time zone, for example Asia/Shanghai or UTC."),
    locale: z
      .string()
      .min(1)
      .optional()
      .describe("Optional BCP 47 locale, for example zh-CN or en-US."),
  })
  .strict();

export type CurrentTimeInput = z.infer<typeof currentTimeInputSchema>;

export interface CurrentTimeResult {
  readonly iso: string;
  readonly formatted: string;
  readonly timeZone: string;
}

export interface CurrentTimeToolOptions {
  readonly now?: () => Date;
  readonly defaultTimeZone?: string;
  readonly defaultLocale?: string;
}

export function createGetCurrentTimeTool(
  options: CurrentTimeToolOptions = {},
): AgentTool<CurrentTimeInput, CurrentTimeResult> {
  const now = options.now ?? (() => new Date());

  return {
    name: "get_current_time",
    description:
      "Get the current date and time in a requested IANA time zone. Use this instead of guessing the time.",
    schema: currentTimeInputSchema,
    execute(input) {
      const date = now();
      if (Number.isNaN(date.getTime())) {
        throw new Error("The configured clock returned an invalid date.");
      }

      const formatter = new Intl.DateTimeFormat(
        input.locale ?? options.defaultLocale ?? "en-US",
        {
          dateStyle: "full",
          timeStyle: "long",
          timeZone: input.timeZone ?? options.defaultTimeZone,
        },
      );

      return {
        iso: date.toISOString(),
        formatted: formatter.format(date),
        timeZone: formatter.resolvedOptions().timeZone,
      };
    },
  };
}
