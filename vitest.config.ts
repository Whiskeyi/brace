import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportOnFailure: true,
      include: [
        "src/lib/agent/{model,runtime,tool-executor}.ts",
        "src/lib/coding-agent/policy.ts",
        "src/lib/sandbox/node-process-sandbox.ts",
        "src/lib/tools/coding/{command,git,tools}.ts",
        "src/lib/workspace/node-workspace.ts"
      ],
      thresholds: {
        statements: 80,
        branches: 65,
        functions: 85,
        lines: 80,
      },
    },
  },
});
