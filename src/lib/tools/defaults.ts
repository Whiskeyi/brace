import {
  createCalculatorTool,
  type CalculatorToolOptions,
} from "./calculator";
import {
  createGetCurrentTimeTool,
  type CurrentTimeToolOptions,
} from "./current-time";
import { ToolRegistry } from "./registry";

export interface DefaultToolRegistryOptions {
  readonly currentTime?: CurrentTimeToolOptions;
  readonly calculator?: CalculatorToolOptions;
}

export function createDefaultToolRegistry(
  options: DefaultToolRegistryOptions = {},
): ToolRegistry {
  return new ToolRegistry([
    createGetCurrentTimeTool(options.currentTime),
    createCalculatorTool(options.calculator),
  ]);
}
