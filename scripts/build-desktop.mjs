import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputRoot = path.join(repositoryRoot, "dist-desktop");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: false,
  external: ["electron"],
  logLevel: "info",
};

await Promise.all([
  build({
    ...shared,
    entryPoints: [path.join(repositoryRoot, "desktop", "main.ts")],
    outfile: path.join(outputRoot, "main.cjs"),
    format: "cjs",
  }),
  build({
    ...shared,
    entryPoints: [path.join(repositoryRoot, "desktop", "preload.ts")],
    outfile: path.join(outputRoot, "preload.cjs"),
    format: "cjs",
  }),
  cp(
    path.join(repositoryRoot, "desktop", "renderer"),
    path.join(outputRoot, "renderer"),
    { recursive: true },
  ),
  cp(
    path.join(repositoryRoot, "desktop", "assets"),
    path.join(outputRoot, "assets"),
    { recursive: true },
  ),
]);

await cp(
  path.join(repositoryRoot, "desktop", "assets", "base-agent-icon.png"),
  path.join(outputRoot, "renderer", "app-icon.png"),
);
