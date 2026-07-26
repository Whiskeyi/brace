import { existsSync, renameSync, writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createApplyPatchTool,
  createCodingTools,
  createDeleteFileTool,
  createListFilesTool,
  createMoveFileTool,
  createReadFileTool,
  createSearchCodeTool,
  type CodingTool,
  type ToolExecutionContext,
} from "@/lib/tools";
import { createNodeWorkspace, WorkspaceError } from "@/lib/workspace";

const temporaryDirectories: string[] = [];
const context: ToolExecutionContext = {
  callId: "call_workspace",
  runId: "run_workspace",
  round: 1,
  signal: new AbortController().signal,
};

async function fixture() {
  const container = await mkdtemp(path.join(tmpdir(), "base-agent-workspace-"));
  temporaryDirectories.push(container);
  const root = path.join(container, "repo");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "greeting.ts"),
    'export const greeting = "hello";\n',
    "utf8",
  );
  return { container, root };
}

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function execute<TInput, TOutput>(
  tool: CodingTool<TInput, TOutput>,
  input: TInput,
): Promise<TOutput> {
  return Promise.resolve(tool.execute(input, context));
}

describe("coding workspace tools", () => {
  it("lists, reads, and searches with relative paths and read annotations", async () => {
    const { root } = await fixture();
    const workspace = await createNodeWorkspace({ root });
    const listTool = createListFilesTool(workspace);
    const readTool = createReadFileTool(workspace);
    const searchTool = createSearchCodeTool(workspace);

    await expect(
      execute(listTool, { path: ".", maxDepth: 3, maxEntries: 20 }),
    ).resolves.toMatchObject({
      entries: [
        { path: "src", kind: "directory" },
        { path: "src/greeting.ts", kind: "file" },
      ],
      truncated: false,
    });
    await expect(
      execute(readTool, { path: "src/greeting.ts" }),
    ).resolves.toMatchObject({
      path: "src/greeting.ts",
      content: 'export const greeting = "hello";\n',
    });
    await expect(
      execute(searchTool, {
        path: "src",
        query: "GREETING",
        caseSensitive: false,
        maxResults: 10,
      }),
    ).resolves.toMatchObject({
      matches: [{ path: "src/greeting.ts", line: 1, column: 14 }],
      filesScanned: 1,
      truncated: false,
    });
    expect(listTool.annotations).toMatchObject({ effect: "read", idempotent: true });
    expect(readTool.annotations.effect).toBe("read");
    expect(searchTool.annotations.effect).toBe("read");
  });

  it("rejects absolute paths and parent traversal", async () => {
    const { root } = await fixture();
    const workspace = await createNodeWorkspace({ root });
    const readTool = createReadFileTool(workspace);

    await expect(execute(readTool, { path: "/etc/passwd" })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    await expect(
      execute(readTool, { path: "src/../../outside.txt" }),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(
      execute(readTool, { path: "C:\\Windows\\system.ini" }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("does not follow symbolic links outside the workspace", async () => {
    const { container, root } = await fixture();
    const outside = path.join(container, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, path.join(root, "escape"), "dir");
    const workspace = await createNodeWorkspace({ root });

    await expect(
      execute(createReadFileTool(workspace), { path: "escape/secret.txt" }),
    ).rejects.toMatchObject({ code: "SYMLINK_NOT_ALLOWED" });
    await expect(
      execute(createSearchCodeTool(workspace), {
        path: "escape",
        query: "secret",
        caseSensitive: true,
        maxResults: 10,
      }),
    ).rejects.toMatchObject({ code: "SYMLINK_NOT_ALLOWED" });
    await expect(
      execute(createDeleteFileTool(workspace), {
        path: "escape",
        expectedContent: "",
      }),
    ).rejects.toMatchObject({ code: "SYMLINK_NOT_ALLOWED" });
    await expect(
      execute(createMoveFileTool(workspace), {
        fromPath: "escape",
        toPath: "moved",
        expectedContent: "",
      }),
    ).rejects.toMatchObject({ code: "SYMLINK_NOT_ALLOWED" });
    const listing = await execute(createListFilesTool(workspace), {
      path: ".",
      maxDepth: 4,
      maxEntries: 20,
    });
    expect(listing.entries).toContainEqual({ path: "escape", kind: "symlink" });
    expect(listing.entries).not.toContainEqual(
      expect.objectContaining({ path: "escape/secret.txt" }),
    );
  });

  it("hides common credential paths unless the trusted host opts in", async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, ".env"), "TOKEN=secret", "utf8");
    await writeFile(path.join(root, ".npmrc"), "//registry/:_authToken=secret", "utf8");
    await writeFile(path.join(root, ".env.example"), "TOKEN=placeholder", "utf8");
    const workspace = await createNodeWorkspace({ root });

    await expect(workspace.readFile({ path: ".env" })).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    await expect(
      workspace.applyPatch({
        path: ".npmrc",
        expectedContent: "//registry/:_authToken=secret",
        newContent: "changed",
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(
      workspace.deleteFile({
        path: ".env",
        expectedContent: "TOKEN=secret",
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(
      workspace.moveFile({
        fromPath: "src/greeting.ts",
        toPath: ".npmrc",
        expectedContent: 'export const greeting = "hello";\n',
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    const listing = await workspace.listFiles({ maxDepth: 2, maxEntries: 20 });
    expect(listing.entries.map((entry) => entry.path)).not.toContain(".env");
    expect(listing.entries.map((entry) => entry.path)).not.toContain(".npmrc");
    expect(listing.entries.map((entry) => entry.path)).toContain(".env.example");

    const trustedWorkspace = await createNodeWorkspace({
      root,
      allowSensitivePaths: true,
    });
    await expect(trustedWorkspace.readFile({ path: ".env" })).resolves.toMatchObject({
      content: "TOKEN=secret",
    });
  });

  it("atomically replaces and creates files while preserving existing mode", async () => {
    const { root } = await fixture();
    const target = path.join(root, "src", "greeting.ts");
    await chmod(target, 0o640);
    const workspace = await createNodeWorkspace({ root });
    const patchTool = createApplyPatchTool(workspace);
    const original = await readFile(target, "utf8");

    await expect(
      execute(patchTool, {
        path: "src/greeting.ts",
        expectedContent: original,
        newContent: 'export const greeting = "hi";\n',
      }),
    ).resolves.toMatchObject({
      path: "src/greeting.ts",
      created: false,
    });
    expect(await readFile(target, "utf8")).toBe('export const greeting = "hi";\n');
    expect((await lstat(target)).mode & 0o777).toBe(0o640);

    await expect(
      execute(patchTool, {
        path: "src/new-file.ts",
        expectedContent: null,
        newContent: "export {};\n",
      }),
    ).resolves.toMatchObject({ created: true, bytesWritten: 11 });
    expect(await readFile(path.join(root, "src", "new-file.ts"), "utf8")).toBe(
      "export {};\n",
    );
    expect(
      (await readdir(path.join(root, "src"))).some((name) => name.includes(".codex-")),
    ).toBe(false);
    expect(patchTool.annotations).toMatchObject({
      effect: "write",
      requiresApproval: true,
      concurrencyKey: "coding-workspace",
    });
  });

  it("leaves the file unchanged when expected content is stale", async () => {
    const { root } = await fixture();
    const workspace = await createNodeWorkspace({ root });
    const patchTool = createApplyPatchTool(workspace);
    const target = path.join(root, "src", "greeting.ts");

    await expect(
      execute(patchTool, {
        path: "src/greeting.ts",
        expectedContent: "stale content",
        newContent: "replacement",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(target, "utf8")).toBe(
      'export const greeting = "hello";\n',
    );
  });

  it("moves and deletes files without overwriting or accepting stale content", async () => {
    const { root } = await fixture();
    const workspace = await createNodeWorkspace({ root });
    const moveTool = createMoveFileTool(workspace);
    const deleteTool = createDeleteFileTool(workspace);
    const original = 'export const greeting = "hello";\n';

    await expect(
      execute(moveTool, {
        fromPath: "src/greeting.ts",
        toPath: "src/renamed.ts",
        expectedContent: original,
      }),
    ).resolves.toEqual({
      fromPath: "src/greeting.ts",
      toPath: "src/renamed.ts",
    });
    await expect(readFile(path.join(root, "src", "greeting.ts"), "utf8")).rejects
      .toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, "src", "renamed.ts"), "utf8")).toBe(
      original,
    );

    await writeFile(path.join(root, "src", "existing.ts"), "existing\n", "utf8");
    await expect(
      execute(moveTool, {
        fromPath: "src/renamed.ts",
        toPath: "src/existing.ts",
        expectedContent: original,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(path.join(root, "src", "existing.ts"), "utf8")).toBe(
      "existing\n",
    );
    expect(await readFile(path.join(root, "src", "renamed.ts"), "utf8")).toBe(
      original,
    );

    await expect(
      execute(deleteTool, {
        path: "src/renamed.ts",
        expectedContent: "stale\n",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      execute(deleteTool, {
        path: "src/renamed.ts",
        expectedContent: original,
      }),
    ).resolves.toEqual({ path: "src/renamed.ts", deleted: true });
    await expect(readFile(path.join(root, "src", "renamed.ts"), "utf8")).rejects
      .toMatchObject({ code: "ENOENT" });
    expect(deleteTool.annotations).toMatchObject({
      effect: "write",
      requiresApproval: true,
      concurrencyKey: "coding-workspace",
    });
    expect(moveTool.annotations).toMatchObject({
      effect: "write",
      requiresApproval: true,
      concurrencyKey: "coding-workspace",
    });
  });

  it("cleans a linked destination when a move is aborted after link creation", async () => {
    const { root } = await fixture();
    const workspace = await createNodeWorkspace({ root });
    const sourcePath = path.join(root, "src", "greeting.ts");
    const targetPath = path.join(root, "src", "aborted.ts");
    const original = 'export const greeting = "hello";\n';
    const signal = {
      get aborted() {
        return existsSync(targetPath);
      },
    } as unknown as AbortSignal;

    await expect(
      workspace.moveFile({
        fromPath: "src/greeting.ts",
        toPath: "src/aborted.ts",
        expectedContent: original,
        signal,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(await readFile(sourcePath, "utf8")).toBe(original);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not delete a same-content replacement with a different identity", async () => {
    const { root } = await fixture();
    const workspace = await createNodeWorkspace({ root });
    const sourcePath = path.join(root, "src", "greeting.ts");
    const preservedPath = path.join(root, "src", "preserved.ts");
    const original = 'export const greeting = "hello";\n';
    let checks = 0;
    let replaced = false;
    const signal = {
      get aborted() {
        checks += 1;
        if (checks === 7) {
          renameSync(sourcePath, preservedPath);
          writeFileSync(sourcePath, original, "utf8");
          replaced = true;
        }
        return false;
      },
    } as unknown as AbortSignal;

    await expect(
      workspace.deleteFile({
        path: "src/greeting.ts",
        expectedContent: original,
        signal,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(replaced).toBe(true);
    expect(await readFile(sourcePath, "utf8")).toBe(original);
    expect(await readFile(preservedPath, "utf8")).toBe(original);
  });

  it("cleans the destination and preserves a replaced source during move", async () => {
    const { root } = await fixture();
    const workspace = await createNodeWorkspace({ root });
    const sourcePath = path.join(root, "src", "greeting.ts");
    const preservedPath = path.join(root, "src", "preserved.ts");
    const targetPath = path.join(root, "src", "moved.ts");
    const original = 'export const greeting = "hello";\n';
    let checksAfterLink = 0;
    let replaced = false;
    const signal = {
      get aborted() {
        if (existsSync(targetPath)) {
          checksAfterLink += 1;
          if (checksAfterLink === 4) {
            renameSync(sourcePath, preservedPath);
            writeFileSync(sourcePath, original, "utf8");
            replaced = true;
          }
        }
        return false;
      },
    } as unknown as AbortSignal;

    await expect(
      workspace.moveFile({
        fromPath: "src/greeting.ts",
        toPath: "src/moved.ts",
        expectedContent: original,
        signal,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(replaced).toBe(true);
    expect(await readFile(sourcePath, "utf8")).toBe(original);
    expect(await readFile(preservedPath, "utf8")).toBe(original);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports a partial move when the linked destination identity is unverified", async () => {
    const { root } = await fixture();
    const workspace = await createNodeWorkspace({ root });
    const sourcePath = path.join(root, "src", "greeting.ts");
    const preservedPath = path.join(root, "src", "preserved.ts");
    const targetPath = path.join(root, "src", "unverified.ts");
    const original = 'export const greeting = "hello";\n';
    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        if (checks === 7) {
          renameSync(sourcePath, preservedPath);
          writeFileSync(sourcePath, original, "utf8");
        }
        return false;
      },
    } as unknown as AbortSignal;

    await expect(
      workspace.moveFile({
        fromPath: "src/greeting.ts",
        toPath: "src/unverified.ts",
        expectedContent: original,
        signal,
      }),
    ).rejects.toMatchObject({
      code: "IO_ERROR",
      message: expect.stringContaining("partial state"),
      workspacePath: "src/unverified.ts",
    });
    expect(await readFile(sourcePath, "utf8")).toBe(original);
    expect(await readFile(preservedPath, "utf8")).toBe(original);
    expect(await readFile(targetPath, "utf8")).toBe(original);
  });

  it("rejects directories and honors cancellation for delete and move", async () => {
    const { root } = await fixture();
    const workspace = await createNodeWorkspace({ root });

    await expect(
      workspace.deleteFile({ path: "src", expectedContent: "" }),
    ).rejects.toMatchObject({ code: "NOT_FILE" });
    await expect(
      workspace.moveFile({
        fromPath: "src",
        toPath: "renamed-src",
        expectedContent: "",
      }),
    ).rejects.toMatchObject({ code: "NOT_FILE" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      workspace.deleteFile({
        path: "src/greeting.ts",
        expectedContent: 'export const greeting = "hello";\n',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    await expect(
      workspace.moveFile({
        fromPath: "src/greeting.ts",
        toPath: "src/moved.ts",
        expectedContent: 'export const greeting = "hello";\n',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("serializes concurrent writes so stale replacements cannot both win", async () => {
    const { root } = await fixture();
    const workspace = await createNodeWorkspace({ root });
    const patchTool = createApplyPatchTool(workspace);
    const original = 'export const greeting = "hello";\n';

    const results = await Promise.allSettled([
      execute(patchTool, {
        path: "src/greeting.ts",
        expectedContent: original,
        newContent: 'export const greeting = "first";\n',
      }),
      execute(patchTool, {
        path: "src/greeting.ts",
        expectedContent: original,
        newContent: 'export const greeting = "second";\n',
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "CONFLICT" } });
    expect(await readFile(path.join(root, "src", "greeting.ts"), "utf8")).toMatch(
      /"(?:first|second)"/,
    );
  });

  it("acquires overlapping move locks in a consistent order", async () => {
    const { root } = await fixture();
    const workspace = await createNodeWorkspace({ root });
    await writeFile(path.join(root, "src", "other.ts"), "other\n", "utf8");
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const results = await Promise.race([
        Promise.allSettled([
          workspace.moveFile({
            fromPath: "src/greeting.ts",
            toPath: "src/other.ts",
            expectedContent: 'export const greeting = "hello";\n',
          }),
          workspace.moveFile({
            fromPath: "src/other.ts",
            toPath: "src/greeting.ts",
            expectedContent: "other\n",
          }),
        ]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Overlapping move locks deadlocked.")),
            1_000,
          );
        }),
      ]);
      expect(results).toHaveLength(2);
      expect(results).toEqual([
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "CONFLICT" }),
        }),
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "CONFLICT" }),
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  });

  it("enforces file and output limits", async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, "src", "large.txt"), "x".repeat(65), "utf8");
    const workspace = await createNodeWorkspace({
      root,
      maxFileBytes: 64,
      maxOutputBytes: 32,
    });

    await expect(
      execute(createReadFileTool(workspace), { path: "src/large.txt" }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(
      execute(createReadFileTool(workspace), { path: "src/greeting.ts" }),
    ).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
    await expect(
      execute(createApplyPatchTool(workspace), {
        path: "src/new.txt",
        expectedContent: null,
        newContent: "x".repeat(65),
      }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(
      execute(createDeleteFileTool(workspace), {
        path: "src/large.txt",
        expectedContent: "x".repeat(65),
      }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(
      execute(createMoveFileTool(workspace), {
        fromPath: "src/large.txt",
        toPath: "src/moved.txt",
        expectedContent: "x".repeat(65),
      }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("builds all six tools in a stable order", async () => {
    const { root } = await fixture();
    const tools = createCodingTools(await createNodeWorkspace({ root }));
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_files",
      "search_code",
      "read_file",
      "apply_patch",
      "delete_file",
      "move_file",
    ]);
  });
});
