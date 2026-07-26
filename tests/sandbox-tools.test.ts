import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNodeProcessSandbox,
  SandboxError,
  type SandboxPort,
} from "@/lib/sandbox";
import {
  AgentToolError,
  createGitDiffTool,
  createGitStatusTool,
  createRunCommandTool,
  type ToolExecutionContext,
} from "@/lib/tools";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
const context: ToolExecutionContext = {
  callId: "call_sandbox",
  runId: "run_sandbox",
  round: 1,
  signal: new AbortController().signal,
};

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "base-agent-sandbox-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "nested"));
  return root;
}

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("NodeProcessSandbox", () => {
  it("denies executables by default and matches an explicit allowlist exactly", async () => {
    const root = await fixture();
    const denied = await createNodeProcessSandbox({ root });

    await expect(
      denied.run({ executable: process.execPath, args: ["--version"] }),
    ).rejects.toMatchObject({ code: "EXECUTABLE_NOT_ALLOWED" });

    const allowed = await createNodeProcessSandbox({
      root,
      allowedExecutables: [process.execPath],
    });
    await expect(
      allowed.run({
        executable: path.basename(process.execPath),
        args: ["--version"],
      }),
    ).rejects.toMatchObject({ code: "EXECUTABLE_NOT_ALLOWED" });
  });

  it("classifies an invalid output limit as an argument error", async () => {
    const root = await fixture();

    await expect(
      createNodeProcessSandbox({ root, maxOutputBytes: 0 }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "maxOutputBytes must be a positive safe integer.",
    });
  });

  it("accepts only workspace-relative cwd paths and confines resolved links", async () => {
    const root = await fixture();
    const outside = await fixture();
    await symlink(outside, path.join(root, "escape"), "dir");
    const sandbox = await createNodeProcessSandbox({
      root,
      allowedExecutables: [process.execPath],
    });
    const result = await sandbox.run({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      cwd: "nested",
    });

    expect(result).toMatchObject({ cwd: "nested", stdout: "ok", exitCode: 0 });
    expect(JSON.stringify(result)).not.toContain(root);
    await expect(
      sandbox.run({ executable: process.execPath, cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(
      sandbox.run({ executable: process.execPath, cwd: "nested/../../tmp" }),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(
      sandbox.run({ executable: process.execPath, cwd: "C:\\Windows" }),
    ).rejects.toBeInstanceOf(SandboxError);
    await expect(
      sandbox.run({ executable: process.execPath, cwd: "escape" }),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
  });

  it("passes arguments without shell interpretation and inherits only allowed env", async () => {
    const root = await fixture();
    const secretName = "BASE_AGENT_SANDBOX_SECRET";
    process.env[secretName] = "must-not-leak";
    try {
      const sandbox = await createNodeProcessSandbox({
        root,
        allowedExecutables: [process.execPath],
      });
      const literal = "$(touch should-not-run); && echo injected";
      const result = await sandbox.run({
        executable: process.execPath,
        args: [
          "-e",
          `process.stdout.write(JSON.stringify({arg: process.argv[1], secret: process.env.${secretName} ?? null, hasPath: Boolean(process.env.PATH)}))`,
          literal,
        ],
      });

      expect(JSON.parse(result.stdout)).toEqual({
        arg: literal,
        secret: null,
        hasPath: true,
      });
    } finally {
      delete process.env[secretName];
    }
  });

  it("terminates a process when its timeout expires", async () => {
    const root = await fixture();
    const sandbox = await createNodeProcessSandbox({
      root,
      allowedExecutables: [process.execPath],
      killGraceMs: 20,
    });
    const result = await sandbox.run({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1_000)"],
      timeoutMs: 30,
    });

    expect(result.terminationReason).toBe("timeout");
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeLessThan(2_000);
  });

  it("caps combined stdout and stderr, truncates, and terminates the process", async () => {
    const root = await fixture();
    const sandbox = await createNodeProcessSandbox({
      root,
      allowedExecutables: [process.execPath],
      maxOutputBytes: 32,
      killGraceMs: 20,
    });
    const result = await sandbox.run({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write('o'.repeat(20)); process.stderr.write('e'.repeat(20)); setInterval(() => {}, 1_000)",
      ],
    });

    expect(result).toMatchObject({
      capturedOutputBytes: 32,
      truncated: true,
      terminationReason: "output_limit",
    });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(
      32,
    );
    expect(result.outputBytes).toBeGreaterThan(32);
  });

  it("terminates a running process when its AbortSignal fires", async () => {
    const root = await fixture();
    const sandbox = await createNodeProcessSandbox({
      root,
      allowedExecutables: [process.execPath],
      killGraceMs: 20,
    });
    const controller = new AbortController();
    const execution = sandbox.run({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1_000)"],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);

    await expect(execution).resolves.toMatchObject({
      exitCode: null,
      terminationReason: "aborted",
    });
  });
});

describe("sandbox coding tools", () => {
  it("marks run_command as approved execution and keeps argv separated", async () => {
    const calls: Parameters<SandboxPort["run"]>[0][] = [];
    const sandbox: SandboxPort = {
      async run(input) {
        calls.push(input);
        return {
          cwd: input.cwd ?? ".",
          exitCode: 0,
          signal: null,
          stdout: "ok",
          stderr: "",
          outputBytes: 2,
          capturedOutputBytes: 2,
          truncated: false,
          terminationReason: "exit",
          durationMs: 1,
        };
      },
    };
    const tool = createRunCommandTool(sandbox);
    const result = await tool.execute(
      { executable: "node", args: ["script.js", "a && b"], cwd: "." },
      context,
    );

    expect(result.stdout).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      executable: "node",
      args: ["script.js", "a && b"],
      cwd: ".",
      signal: context.signal,
    });
    expect(tool.annotations).toEqual({
      effect: "execute",
      idempotent: false,
      requiresApproval: true,
      concurrencyKey: "coding-workspace",
    });
    expect(tool.schema.safeParse({ command: "node script.js" }).success).toBe(
      false,
    );
  });

  it.each(["timeout", "output_limit"] as const)(
    "turns a %s process termination into a recoverable tool error",
    async (terminationReason) => {
      const sandbox: SandboxPort = {
        async run(input) {
          return {
            cwd: input.cwd ?? ".",
            exitCode: null,
            signal: "SIGTERM",
            stdout: "",
            stderr: "",
            outputBytes: 0,
            capturedOutputBytes: 0,
            truncated: terminationReason === "output_limit",
            terminationReason,
            durationMs: 5,
          };
        },
      };
      const tool = createRunCommandTool(sandbox);

      await expect(
        tool.execute({ executable: "node", args: [], cwd: "." }, context),
      ).rejects.toMatchObject({
        name: "AgentToolError",
        retryable: true,
        details: {
          terminationReason,
          exitCode: null,
          truncated: terminationReason === "output_limit",
        },
      });
    },
  );

  it("preserves a stable sandbox error code without exposing adapter internals", async () => {
    const sandbox: SandboxPort = {
      async run() {
        throw new SandboxError(
          "EXECUTABLE_NOT_ALLOWED",
          "Executable is not allowed.",
        );
      },
    };
    const tool = createRunCommandTool(sandbox);

    await expect(
      tool.execute({ executable: "denied", args: [], cwd: "." }, context),
    ).rejects.toMatchObject({
      name: "AgentToolError",
      message: "run_command failed: Executable is not allowed.",
      retryable: false,
      details: { code: "EXECUTABLE_NOT_ALLOWED" },
    });
  });

  it("runs fixed Git inspection commands behind an execute capability", async () => {
    const root = await fixture();
    await execFile("git", ["init", "--quiet"], { cwd: root });
    await execFile("git", ["config", "user.email", "agent@example.test"], {
      cwd: root,
    });
    await execFile("git", ["config", "user.name", "Agent Test"], { cwd: root });
    await writeFile(path.join(root, "tracked.txt"), "before\n", "utf8");
    await execFile("git", ["add", "tracked.txt"], { cwd: root });
    await execFile("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });

    const sandbox = await createNodeProcessSandbox({
      root,
      allowedExecutables: ["git"],
    });
    const statusTool = createGitStatusTool(sandbox);
    const diffTool = createGitDiffTool(sandbox);
    const cleanDiff = await diffTool.execute({ cwd: "." }, context);
    expect(cleanDiff.diff).toBe("");

    await writeFile(path.join(root, "tracked.txt"), "staged\n", "utf8");
    await execFile("git", ["add", "tracked.txt"], { cwd: root });
    await writeFile(path.join(root, "tracked.txt"), "after\n", "utf8");
    await writeFile(path.join(root, "untracked.txt"), "new\n", "utf8");
    const status = await statusTool.execute({ cwd: "." }, context);
    const diff = await diffTool.execute({ cwd: "." }, context);

    expect(status.status).toContain("MM tracked.txt");
    expect(status.status).toContain("?? untracked.txt");
    expect(diff.diff).toContain("### Unstaged changes");
    expect(diff.diff).toContain("-staged");
    expect(diff.diff).toContain("+after");
    expect(diff.diff).toContain("### Staged changes");
    expect(diff.diff).toContain("-before");
    expect(diff.diff).toContain("+staged");
    expect(diff.diff).toContain("### Untracked files");
    expect(diff.diff).toContain("?? untracked.txt");
    expect(statusTool.annotations).toMatchObject({
      effect: "execute",
      idempotent: true,
      requiresApproval: true,
      concurrencyKey: "coding-workspace",
    });
    expect(diffTool.annotations.effect).toBe("execute");
    expect(statusTool.schema.safeParse({ cwd: ".", args: ["reset", "--hard"] }).success)
      .toBe(false);
    expect(diffTool.schema.safeParse({ cwd: ".", revision: "HEAD~1" }).success)
      .toBe(false);
  });

  it("turns a non-repository git failure into a controlled tool error", async () => {
    const root = await fixture();
    const sandbox = await createNodeProcessSandbox({
      root,
      allowedExecutables: ["git"],
    });

    await expect(
      createGitStatusTool(sandbox).execute({ cwd: "." }, context),
    ).rejects.toBeInstanceOf(AgentToolError);
  });
});
