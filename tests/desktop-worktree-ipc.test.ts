import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const mainSource = readFileSync(
  path.join(projectRoot, "desktop/main.ts"),
  "utf8",
);
const preloadSource = readFileSync(
  path.join(projectRoot, "desktop/preload.ts"),
  "utf8",
);
const rendererSource = readFileSync(
  path.join(projectRoot, "desktop/renderer/renderer.js"),
  "utf8",
);

describe("desktop worktree resolution IPC", () => {
  it("keeps destructive confirmation in the trusted main process", () => {
    expect(mainSource).toContain("confirmation.response !== 0");
    expect(mainSource).toContain("confirmed: true");
    expect(mainSource).toContain('defaultId: 1');
    expect(mainSource).toContain('cancelId: 1');
    expect(mainSource).toContain('candidate.action !== "cleanup"');
  });

  it("does not let the renderer supply the confirmation flag", () => {
    const methodStart = preloadSource.lastIndexOf("resolveWorktree: (");
    const exposedMethod = preloadSource.slice(
      methodStart,
      preloadSource.indexOf("openWorkspace:", methodStart),
    );

    expect(exposedMethod).toContain("{ threadId, action }");
    expect(exposedMethod).not.toContain("confirmed");
    expect(exposedMethod).toContain('action !== "cleanup"');
  });

  it("keeps a restart-safe cleanup action visible without allowing a second apply", () => {
    expect(rendererSource).toContain("thread.worktreeCleanupCommit");
    expect(rendererSource).toContain('? "cleanup" : "apply"');
    expect(rendererSource).toContain('"worktree.retryCleanup"');
    expect(rendererSource).toContain("!cleanupPending");
  });
});
