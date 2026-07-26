import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    files: ["src/lib/agent/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "../tools",
              message:
                "Agent core must import the narrow tool contract or registry module, not the tools composition barrel.",
            },
          ],
          patterns: [
            {
              group: [
                "../coding-agent",
                "../coding-agent/*",
                "../local-agent",
                "../local-agent/*",
                "../sandbox",
                "../sandbox/*",
                "../workspace",
                "../workspace/*",
                "@/lib/coding-agent",
                "@/lib/coding-agent/*",
                "@/lib/local-agent",
                "@/lib/local-agent/*",
                "@/lib/sandbox",
                "@/lib/sandbox/*",
                "@/lib/workspace",
                "@/lib/workspace/*",
                "@/server/*",
                "@/app/*",
                "@/components/*",
              ],
              message:
                "Agent core cannot depend on host, adapter, or product composition layers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/lib/coding-agent/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "../agent",
              message:
                "Coding composition must import the specific agent runtime or contract module.",
            },
            {
              name: "../tools",
              message:
                "Coding composition must import specific coding tools or tool contracts.",
            },
            {
              name: "../sandbox",
              message:
                "Coding composition depends on SandboxPort, not its Node adapter barrel.",
            },
            {
              name: "../workspace",
              message:
                "Coding composition depends on WorkspacePort, not its Node adapter barrel.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/lib/tools/coding/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "../../sandbox",
              message:
                "Coding tools depend on the sandbox contract, not its adapter barrel.",
            },
            {
              name: "../../workspace",
              message:
                "Coding tools depend on the workspace contract, not its adapter barrel.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["desktop/settings.ts", "desktop/model-runtime.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "../src/lib/local-agent",
              message:
                "Desktop configuration must import its leaf contracts, not the full local-agent application barrel.",
            },
          ],
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "coverage/**",
    "dist/**",
    "dist-desktop/**",
    "release/**",
  ]),
]);
