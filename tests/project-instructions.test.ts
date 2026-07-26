import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProjectInstructions } from "@/lib/coding-agent";
import { createNodeWorkspace } from "@/lib/workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("project instructions", () => {
  it("loads bounded root AGENTS.md and CLAUDE.md guidance", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "base-agent-instructions-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "AGENTS.md"), "Use pnpm.\n");
    await writeFile(path.join(root, "CLAUDE.md"), "Run focused tests.\n");
    const workspace = await createNodeWorkspace({ root });

    await expect(loadProjectInstructions(workspace)).resolves.toEqual({
      content:
        "### AGENTS.md\nUse pnpm.\n\n### CLAUDE.md\nRun focused tests.",
      files: ["AGENTS.md", "CLAUDE.md"],
      truncated: false,
    });
  });

  it("ignores missing or symlinked optional instruction files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "base-agent-instructions-"));
    temporaryDirectories.push(root);
    const outside = path.join(root, "..", `${path.basename(root)}-outside`);
    await mkdir(outside);
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, "AGENTS.md"), "Do not load me.");
    await symlink(
      path.join(outside, "AGENTS.md"),
      path.join(root, "AGENTS.md"),
    );
    const workspace = await createNodeWorkspace({ root });

    await expect(loadProjectInstructions(workspace)).resolves.toBeNull();
  });

  it("truncates by UTF-8 bytes instead of splitting encoded characters", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "base-agent-instructions-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "AGENTS.md"), "中文约定".repeat(20));
    const workspace = await createNodeWorkspace({ root });

    const result = await loadProjectInstructions(workspace, 40);

    expect(result).toMatchObject({
      files: ["AGENTS.md"],
      truncated: true,
    });
    expect(Buffer.byteLength(result?.content ?? "", "utf8")).toBeLessThanOrEqual(
      40,
    );
    expect(result?.content).not.toContain("�");
  });
});
