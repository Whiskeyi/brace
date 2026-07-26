import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type DesktopLocale = "en" | "zh-CN";
export type DesktopTheme = "system" | "light" | "dark";

export interface DesktopUiPreferences {
  readonly locale: DesktopLocale;
  readonly theme: DesktopTheme;
}

export const DEFAULT_DESKTOP_UI_PREFERENCES: DesktopUiPreferences =
  Object.freeze({
    locale: "en",
    theme: "system",
  });

export class DesktopUiPreferencesStore {
  readonly #preferencesPath: string;

  constructor(userDataPath: string) {
    this.#preferencesPath = path.join(userDataPath, "ui-preferences.json");
  }

  async load(): Promise<DesktopUiPreferences> {
    try {
      const input = JSON.parse(
        await readFile(this.#preferencesPath, "utf8"),
      ) as unknown;
      return parseDesktopUiPreferences(input);
    } catch {
      return DEFAULT_DESKTOP_UI_PREFERENCES;
    }
  }

  async save(input: unknown): Promise<DesktopUiPreferences> {
    const preferences = parseDesktopUiPreferences(input);
    await mkdir(path.dirname(this.#preferencesPath), { recursive: true });
    const temporaryPath = `${this.#preferencesPath}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(preferences, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporaryPath, this.#preferencesPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
    return preferences;
  }
}

export function parseDesktopUiPreferences(
  input: unknown,
): DesktopUiPreferences {
  if (!input || typeof input !== "object") {
    throw new TypeError("Invalid desktop UI preferences.");
  }
  const candidate = input as Record<string, unknown>;
  const locale = candidate.locale;
  const theme = candidate.theme;
  if (
    (locale !== "en" && locale !== "zh-CN") ||
    (theme !== "system" && theme !== "light" && theme !== "dark")
  ) {
    throw new TypeError("Invalid desktop UI preferences.");
  }
  return { locale, theme };
}
