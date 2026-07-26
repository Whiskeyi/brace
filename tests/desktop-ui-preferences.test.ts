import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DESKTOP_UI_PREFERENCES,
  DesktopUiPreferencesStore,
  parseDesktopUiPreferences,
} from "../desktop/ui-preferences";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("DesktopUiPreferencesStore", () => {
  it("falls back to English and the system theme for missing or invalid files", async () => {
    const fixture = await createFixture();
    await expect(fixture.store.load()).resolves.toEqual(
      DEFAULT_DESKTOP_UI_PREFERENCES,
    );

    await writeFile(fixture.preferencesPath, '{"locale":"fr","theme":"sepia"}');
    await expect(fixture.store.load()).resolves.toEqual(
      DEFAULT_DESKTOP_UI_PREFERENCES,
    );
  });

  it("persists a validated private preference file atomically", async () => {
    const fixture = await createFixture();

    await expect(
      fixture.store.save({ locale: "zh-CN", theme: "dark" }),
    ).resolves.toEqual({ locale: "zh-CN", theme: "dark" });

    expect(JSON.parse(await readFile(fixture.preferencesPath, "utf8"))).toEqual({
      locale: "zh-CN",
      theme: "dark",
    });
    expect((await stat(fixture.preferencesPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(fixture.directory)).toEqual(["ui-preferences.json"]);
  });

  it("rejects unsupported values before writing", () => {
    expect(() =>
      parseDesktopUiPreferences({ locale: "en", theme: "sepia" }),
    ).toThrow(/Invalid desktop UI preferences/);
  });
});

async function createFixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "base-agent-ui-preferences-"),
  );
  temporaryDirectories.push(directory);
  return {
    directory,
    preferencesPath: path.join(directory, "ui-preferences.json"),
    store: new DesktopUiPreferencesStore(directory),
  };
}
