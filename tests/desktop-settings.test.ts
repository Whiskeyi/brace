import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const safeStorageState = vi.hoisted(() => ({
  available: true,
  encryptString: vi.fn((value: string) => Buffer.from(`cipher:${value}`)),
  decryptString: vi.fn((value: Buffer) => {
    const serialized = value.toString("utf8");
    if (!serialized.startsWith("cipher:")) {
      throw new Error("Invalid mock ciphertext.");
    }
    return serialized.slice("cipher:".length);
  }),
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => safeStorageState.available,
    encryptString: safeStorageState.encryptString,
    decryptString: safeStorageState.decryptString,
  },
}));

import { DesktopSettingsStore } from "../desktop/settings";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  safeStorageState.available = true;
  safeStorageState.encryptString.mockClear();
  safeStorageState.decryptString.mockClear();
});

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("DesktopSettingsStore", () => {
  it("migrates V1 settings in memory without rewriting the file", async () => {
    const fixture = await createFixture();
    const legacy = {
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      encryptedApiKey: encryptFixtureKey("legacy-secret"),
    };
    await writeFile(fixture.settingsPath, JSON.stringify(legacy), {
      encoding: "utf8",
      mode: 0o600,
    });

    const settings = await fixture.store.load();

    expect(settings).toEqual({
      provider: "bailian-payg",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      customBaseUrl: null,
      model: "qwen-plus",
      apiKey: "legacy-secret",
      credentialScope: "bailian-cn-payg",
    });
    expect(JSON.parse(await readFile(fixture.settingsPath, "utf8"))).toEqual(
      legacy,
    );
  });

  it("keeps a V1 regional endpoint in its isolated credential scope", async () => {
    const fixture = await createFixture();
    const regionalBaseUrl =
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/";
    const legacy = {
      baseUrl: regionalBaseUrl,
      model: "qwen-plus",
      encryptedApiKey: encryptFixtureKey("regional-legacy-secret"),
    };
    await writeFile(fixture.settingsPath, JSON.stringify(legacy), {
      encoding: "utf8",
      mode: 0o600,
    });

    await expect(fixture.store.load()).resolves.toEqual({
      provider: "bailian-payg",
      baseUrl:
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      customBaseUrl: null,
      model: "qwen-plus",
      apiKey: "regional-legacy-secret",
      credentialScope:
        "bailian-cn-payg:https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    });
    expect(JSON.parse(await readFile(fixture.settingsPath, "utf8"))).toEqual(
      legacy,
    );
  });

  it("preserves the legacy SDK-default endpoint as an empty custom endpoint", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.settingsPath,
      JSON.stringify({
        baseUrl: null,
        model: "gpt-compatible-model",
        encryptedApiKey: null,
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const migrated = await fixture.store.load();
    await fixture.store.save({
      provider: migrated.provider,
      baseUrl: "",
      model: migrated.model,
    });

    expect(migrated).toMatchObject({
      provider: "custom",
      baseUrl: "https://api.openai.com/v1",
      customBaseUrl: null,
      credentialScope: "openai-default",
    });
    await expect(fixture.store.load()).resolves.toMatchObject({
      provider: "custom",
      baseUrl: "https://api.openai.com/v1",
      customBaseUrl: null,
      credentialScope: "openai-default",
    });
  });

  it("preserves the existing ciphertext when saving within the same scope", async () => {
    const fixture = await createFixture();
    const encryptedApiKey = encryptFixtureKey("existing-secret");
    await writeFile(
      fixture.settingsPath,
      JSON.stringify({
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen-plus",
        encryptedApiKey,
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const resolved = await fixture.store.resolve({
      provider: "bailian-payg",
      baseUrl: "",
      model: "qwen3-coder-plus",
    });
    const beforeSave = JSON.parse(
      await readFile(fixture.settingsPath, "utf8"),
    ) as Record<string, unknown>;
    const saved = await fixture.store.save({
      provider: "bailian-payg",
      baseUrl: "",
      model: "qwen3-coder-plus",
    });
    const persisted = JSON.parse(
      await readFile(fixture.settingsPath, "utf8"),
    ) as Record<string, unknown>;

    expect(resolved.apiKey).toBe("existing-secret");
    expect(beforeSave).not.toHaveProperty("version");
    expect(saved.apiKey).toBe("existing-secret");
    expect(persisted).toMatchObject({
      version: 3,
      provider: "bailian-payg",
      baseUrl: null,
      model: "qwen3-coder-plus",
      encryptedApiKey,
      credentialScope: "bailian-cn-payg",
    });
    expect(safeStorageState.encryptString).not.toHaveBeenCalled();
  });

  it("decrypts a saved key only once per desktop process", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.settingsPath,
      JSON.stringify({
        version: 2,
        provider: "deepseek",
        customBaseUrl: null,
        model: "deepseek-v4-flash",
        encryptedApiKey: encryptFixtureKey("cached-secret"),
        credentialScope: "deepseek-payg",
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    await fixture.store.load();
    await fixture.store.resolve({
      provider: "deepseek",
      baseUrl: "",
      model: "deepseek-v4-pro",
    });
    await fixture.store.save({
      provider: "deepseek",
      baseUrl: "",
      model: "deepseek-v4-pro",
    });

    expect(safeStorageState.decryptString).toHaveBeenCalledTimes(1);
  });

  it("keeps a V2 custom endpoint inside its original credential scope", async () => {
    const fixture = await createFixture();
    const customBaseUrl = "https://models.example.test/v1";
    const encryptedApiKey = encryptFixtureKey("custom-secret");
    await writeFile(
      fixture.settingsPath,
      JSON.stringify({
        version: 2,
        provider: "custom",
        customBaseUrl,
        model: "custom-model",
        encryptedApiKey,
        credentialScope: `custom:${customBaseUrl}`,
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    await expect(fixture.store.load()).resolves.toEqual({
      provider: "custom",
      baseUrl: customBaseUrl,
      customBaseUrl,
      model: "custom-model",
      apiKey: "custom-secret",
      credentialScope: `custom:${customBaseUrl}`,
    });
    await expect(
      fixture.store.save({
        provider: "custom",
        baseUrl: customBaseUrl,
        model: "custom-model-next",
      }),
    ).resolves.toMatchObject({
      baseUrl: customBaseUrl,
      apiKey: "custom-secret",
      credentialScope: `custom:${customBaseUrl}`,
    });
    expect(JSON.parse(await readFile(fixture.settingsPath, "utf8"))).toMatchObject(
      {
        version: 3,
        baseUrl: customBaseUrl,
        encryptedApiKey,
        credentialScope: `custom:${customBaseUrl}`,
      },
    );
  });

  it("rejects silent reuse of a saved key when the credential scope changes", async () => {
    const fixture = await createFixture();
    await fixture.store.save({
      provider: "bailian-payg",
      baseUrl: "",
      model: "qwen-plus",
      apiKey: "provider-a-secret",
    });
    const original = await readFile(fixture.settingsPath, "utf8");
    const changedScope = {
      provider: "deepseek",
      baseUrl: "",
      model: "deepseek-v4-flash",
    };

    await expect(fixture.store.resolve(changedScope)).rejects.toMatchObject({
      code: "credential_scope_changed",
    });
    await expect(fixture.store.save(changedScope)).rejects.toMatchObject({
      code: "credential_scope_changed",
    });
    expect(await readFile(fixture.settingsPath, "utf8")).toBe(original);
  });

  it("allows a scope change with a new key or an explicit key removal", async () => {
    const fixture = await createFixture();
    await fixture.store.save({
      provider: "bailian-payg",
      baseUrl: "",
      model: "qwen-plus",
      apiKey: "provider-a-secret",
    });

    const replaced = await fixture.store.save({
      provider: "deepseek",
      baseUrl: "",
      model: "deepseek-v4-flash",
      apiKey: "provider-b-secret",
    });
    expect(replaced).toMatchObject({
      provider: "deepseek",
      apiKey: "provider-b-secret",
      credentialScope: "deepseek-payg",
    });

    const cleared = await fixture.store.save({
      provider: "custom",
      baseUrl: "http://localhost:11434/v1",
      model: "local-model",
      clearApiKey: true,
    });
    expect(cleared).toMatchObject({
      provider: "custom",
      baseUrl: "http://localhost:11434/v1",
      apiKey: null,
      credentialScope: "custom:http://localhost:11434/v1",
    });
    expect(
      JSON.parse(await readFile(fixture.settingsPath, "utf8")),
    ).toMatchObject({ encryptedApiKey: null });
  });

  it("uses a stable error code when secure storage is unavailable", async () => {
    const fixture = await createFixture();
    safeStorageState.available = false;

    await expect(
      fixture.store.save({
        provider: "deepseek",
        baseUrl: "",
        model: "deepseek-chat",
        apiKey: "provider-secret",
      }),
    ).rejects.toMatchObject({
      code: "secure_storage_unavailable",
    });
  });

  it("writes a private V3 file atomically without persisting plaintext secrets", async () => {
    const fixture = await createFixture();
    const secret = "never-write-this-plaintext";

    await fixture.store.save({
      provider: "custom",
      baseUrl: "https://models.example.test/v1/",
      model: "test-model",
      apiKey: secret,
    });

    const raw = await readFile(fixture.settingsPath, "utf8");
    const fileStat = await stat(fixture.settingsPath);
    const directoryEntries = await readdir(fixture.directory);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(raw).not.toContain(secret);
    expect(JSON.parse(raw)).toMatchObject({
      version: 3,
      provider: "custom",
      baseUrl: "https://models.example.test/v1",
      model: "test-model",
      credentialScope: "custom:https://models.example.test/v1",
    });
    expect(directoryEntries).toEqual(["model-settings.json"]);
  });

  it("persists an official regional Bailian endpoint with an isolated key scope", async () => {
    const fixture = await createFixture();
    const regionalBaseUrl =
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

    const saved = await fixture.store.save({
      provider: "bailian-payg",
      baseUrl: regionalBaseUrl,
      model: "qwen-plus",
      apiKey: "regional-secret",
    });

    expect(saved).toMatchObject({
      provider: "bailian-payg",
      baseUrl: regionalBaseUrl,
      customBaseUrl: null,
      credentialScope:
        "bailian-cn-payg:https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    });
    expect(JSON.parse(await readFile(fixture.settingsPath, "utf8"))).toMatchObject(
      {
        version: 3,
        provider: "bailian-payg",
        baseUrl: regionalBaseUrl,
        credentialScope:
          "bailian-cn-payg:https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      },
    );
    await expect(fixture.store.load()).resolves.toMatchObject({
      baseUrl: regionalBaseUrl,
      apiKey: "regional-secret",
    });
  });

  it("rejects an endpoint that does not belong to the selected preset", async () => {
    const fixture = await createFixture();

    await expect(
      fixture.store.save({
        provider: "deepseek",
        baseUrl: "https://api.minimax.io/v1",
        model: "deepseek-chat",
        apiKey: "provider-secret",
      }),
    ).rejects.toMatchObject({ code: "provider_endpoint_invalid" });
  });
});

async function createFixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "base-agent-desktop-settings-"),
  );
  temporaryDirectories.push(directory);
  return {
    directory,
    settingsPath: path.join(directory, "model-settings.json"),
    store: new DesktopSettingsStore(directory),
  };
}

function encryptFixtureKey(value: string): string {
  return Buffer.from(`cipher:${value}`).toString("base64");
}
