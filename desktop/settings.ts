import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { safeStorage } from "electron";
import { z } from "zod";

import {
  modelProviderIdSchema,
  resolveModelProvider,
  type ModelProviderId,
} from "../src/lib/model-providers";
import { saveLocalModelSettingsSchema } from "../src/lib/local-agent/protocol";

export type DesktopSettingsErrorCode =
  | "secure_storage_unavailable"
  | "credential_scope_changed"
  | "settings_read_failed"
  | "settings_write_failed"
  | "settings_input_invalid"
  | "credential_scope_invalid"
  | "custom_endpoint_invalid"
  | "provider_endpoint_invalid"
  | "credential_decryption_unavailable"
  | "credential_decryption_failed";

export class DesktopSettingsError extends Error {
  readonly code: DesktopSettingsErrorCode;

  constructor(code: DesktopSettingsErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "DesktopSettingsError";
    this.code = code;
  }
}

const storedSettingsV1Schema = z
  .object({
    baseUrl: z.string().nullable(),
    model: z.string().min(1).max(200),
    encryptedApiKey: z.string().nullable(),
  })
  .strict();

const storedSettingsV2Schema = z
  .object({
    version: z.literal(2),
    provider: modelProviderIdSchema,
    customBaseUrl: z.string().nullable(),
    model: z.string().min(1).max(200),
    encryptedApiKey: z.string().nullable(),
    credentialScope: z.string().min(1).max(2_048),
  })
  .strict();

const storedSettingsV3Schema = z
  .object({
    version: z.literal(3),
    provider: modelProviderIdSchema,
    baseUrl: z.string().nullable(),
    model: z.string().min(1).max(200),
    encryptedApiKey: z.string().nullable(),
    credentialScope: z.string().min(1).max(2_048),
  })
  .strict();

const storedSettingsSchema = z.union([
  storedSettingsV3Schema,
  storedSettingsV2Schema,
  storedSettingsV1Schema,
]);

type StoredSettingsV3 = z.infer<typeof storedSettingsV3Schema>;

export interface DesktopModelSettings {
  readonly provider: ModelProviderId;
  readonly baseUrl: string | null;
  readonly customBaseUrl: string | null;
  readonly model: string | null;
  readonly apiKey: string | null;
  readonly credentialScope: string | null;
}

interface ResolvedSettings {
  readonly settings: DesktopModelSettings;
  readonly stored: StoredSettingsV3;
}

export class DesktopSettingsStore {
  readonly #settingsPath: string;
  readonly #decryptedApiKeyCache = new Map<string, string>();

  constructor(userDataPath: string) {
    this.#settingsPath = path.join(userDataPath, "model-settings.json");
  }

  async load(): Promise<DesktopModelSettings> {
    const stored = await this.#readStored();
    if (!stored) return emptySettings();
    return publicSettings(
      stored,
      this.#decryptApiKey(stored.encryptedApiKey),
    );
  }

  async resolve(input: unknown): Promise<DesktopModelSettings> {
    return (await this.#resolve(input)).settings;
  }

  async save(input: unknown): Promise<DesktopModelSettings> {
    const resolved = await this.#resolve(input);
    await mkdir(path.dirname(this.#settingsPath), { recursive: true });
    const temporaryPath = `${this.#settingsPath}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(resolved.stored, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporaryPath, this.#settingsPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw new DesktopSettingsError("settings_write_failed", {
        cause: error,
      });
    }
    return resolved.settings;
  }

  async #resolve(input: unknown): Promise<ResolvedSettings> {
    let parsed: ReturnType<typeof saveLocalModelSettingsSchema.parse>;
    try {
      parsed = saveLocalModelSettingsSchema.parse(input);
    } catch (error) {
      throw new DesktopSettingsError("settings_input_invalid", {
        cause: error,
      });
    }
    const current = await this.#readStored();
    const provider =
      parsed.provider ??
      current?.provider ??
      resolveLegacyProvider(parsed.baseUrl);
    const requestedBaseUrl = parsed.baseUrl || undefined;
    const requestedProvider = requestedBaseUrl
      ? resolveModelProvider({ baseUrl: requestedBaseUrl }).provider.id
      : provider;
    if (
      provider !== "custom" &&
      requestedBaseUrl &&
      requestedProvider !== provider
    ) {
      throw new DesktopSettingsError("provider_endpoint_invalid");
    }
    const endpoint = resolveModelProvider({
      provider,
      ...(requestedBaseUrl ? { baseUrl: requestedBaseUrl } : {}),
    });
    const baseUrl =
      endpoint.baseUrl === endpoint.provider.baseUrl ? null : endpoint.baseUrl;

    let apiKey: string | null;
    let encryptedApiKey: string | null;
    if (parsed.clearApiKey) {
      apiKey = null;
      encryptedApiKey = null;
    } else if (parsed.apiKey) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new DesktopSettingsError("secure_storage_unavailable");
      }
      apiKey = parsed.apiKey;
      encryptedApiKey = safeStorage.encryptString(parsed.apiKey).toString(
        "base64",
      );
      this.#decryptedApiKeyCache.set(encryptedApiKey, parsed.apiKey);
    } else if (current?.encryptedApiKey) {
      if (current.credentialScope !== endpoint.credentialScope) {
        throw new DesktopSettingsError("credential_scope_changed");
      }
      apiKey = this.#decryptApiKey(current.encryptedApiKey);
      encryptedApiKey = current.encryptedApiKey;
    } else {
      apiKey = null;
      encryptedApiKey = null;
    }

    const stored: StoredSettingsV3 = {
      version: 3,
      provider,
      baseUrl,
      model: parsed.model,
      encryptedApiKey,
      credentialScope: endpoint.credentialScope,
    };
    return {
      settings: publicSettings(stored, apiKey),
      stored,
    };
  }

  async #readStored(): Promise<StoredSettingsV3 | null> {
    let raw: string;
    try {
      raw = await readFile(this.#settingsPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new DesktopSettingsError("settings_read_failed", {
        cause: error,
      });
    }

    let stored: z.infer<typeof storedSettingsSchema>;
    try {
      stored = storedSettingsSchema.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      throw new DesktopSettingsError("settings_read_failed", {
        cause: error,
      });
    }
    if ("version" in stored && stored.version === 3) {
      const endpoint = resolveModelProvider({
        provider: stored.provider,
        ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
      });
      if (stored.credentialScope !== endpoint.credentialScope) {
        throw new DesktopSettingsError("credential_scope_invalid");
      }
      if (
        stored.provider !== "custom" &&
        stored.baseUrl !== null &&
        endpoint.baseUrl !== stored.baseUrl
      ) {
        throw new DesktopSettingsError("provider_endpoint_invalid");
      }
      return stored;
    }

    if ("version" in stored) {
      const endpoint = resolveModelProvider({
        provider: stored.provider,
        ...(stored.customBaseUrl
          ? { baseUrl: stored.customBaseUrl }
          : {}),
      });
      if (stored.credentialScope !== endpoint.credentialScope) {
        throw new DesktopSettingsError("credential_scope_invalid");
      }
      if (
        stored.provider !== "custom" &&
        stored.customBaseUrl !== null
      ) {
        throw new DesktopSettingsError("custom_endpoint_invalid");
      }
      return {
        version: 3,
        provider: stored.provider,
        baseUrl: stored.customBaseUrl,
        model: stored.model,
        encryptedApiKey: stored.encryptedApiKey,
        credentialScope: stored.credentialScope,
      };
    }

    const legacyBaseUrl = stored.baseUrl;
    const provider = resolveLegacyProvider(legacyBaseUrl ?? "");
    const endpoint = resolveModelProvider({
      provider,
      ...(legacyBaseUrl ? { baseUrl: legacyBaseUrl } : {}),
    });
    const baseUrl =
      endpoint.baseUrl === endpoint.provider.baseUrl
        ? null
        : endpoint.baseUrl;
    return {
      version: 3,
      provider,
      baseUrl,
      model: stored.model,
      encryptedApiKey: stored.encryptedApiKey,
      credentialScope: endpoint.credentialScope,
    };
  }

  #decryptApiKey(encryptedApiKey: string | null): string | null {
    if (!encryptedApiKey) return null;
    const cached = this.#decryptedApiKeyCache.get(encryptedApiKey);
    if (cached !== undefined) return cached;
    const decrypted = decryptApiKey(encryptedApiKey);
    if (decrypted !== null) {
      this.#decryptedApiKeyCache.set(encryptedApiKey, decrypted);
    }
    return decrypted;
  }
}

function resolveLegacyProvider(baseUrl: string): ModelProviderId {
  if (!baseUrl.trim()) return "custom";
  return resolveModelProvider({ baseUrl }).provider.id;
}

function publicSettings(
  stored: StoredSettingsV3,
  apiKey: string | null,
): DesktopModelSettings {
  const endpoint = resolveModelProvider({
    provider: stored.provider,
    ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
  });
  return {
    provider: stored.provider,
    baseUrl: endpoint.baseUrl,
    customBaseUrl: stored.provider === "custom" ? stored.baseUrl : null,
    model: stored.model,
    apiKey,
    credentialScope: stored.credentialScope,
  };
}

function emptySettings(): DesktopModelSettings {
  const endpoint = resolveModelProvider({});
  return {
    provider: endpoint.provider.id,
    baseUrl: null,
    customBaseUrl: null,
    model: null,
    apiKey: null,
    credentialScope: null,
  };
}

function decryptApiKey(encryptedApiKey: string | null): string | null {
  if (!encryptedApiKey) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new DesktopSettingsError("credential_decryption_unavailable");
  }
  try {
    return safeStorage.decryptString(
      Buffer.from(encryptedApiKey, "base64"),
    );
  } catch (error) {
    throw new DesktopSettingsError("credential_decryption_failed", {
      cause: error,
    });
  }
}

export function desktopSettingsErrorCode(
  error: unknown,
): DesktopSettingsErrorCode | null {
  return error instanceof DesktopSettingsError ? error.code : null;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
