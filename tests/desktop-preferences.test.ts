import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

interface JsdomWindow extends Window {
  close(): void;
}

interface JsdomInstance {
  readonly window: JsdomWindow;
}

interface JsdomConstructor {
  new (
    html?: string,
    options?: Readonly<Record<string, unknown>>,
  ): JsdomInstance;
}

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  readonly JSDOM: JsdomConstructor;
};

const projectRoot = process.cwd();
const preferencesSource = readFileSync(
  path.join(projectRoot, "desktop/renderer/preferences.js"),
  "utf8",
);
const rendererSource = readFileSync(
  path.join(projectRoot, "desktop/renderer/renderer.js"),
  "utf8",
);
const indexSource = readFileSync(
  path.join(projectRoot, "desktop/renderer/index.html"),
  "utf8",
);

interface PreferenceApi {
  readonly locale: string;
  readonly theme: string;
  readonly accent: string;
  t(
    key: string,
    parameters?: Readonly<Record<string, string | number>>,
    fallback?: string,
  ): string;
  applyDocumentTranslations(): void;
  setLocale(value: string): boolean;
  setTheme(value: string): boolean;
  setAccent(value: string): boolean;
}

function loadPreferences(
  html = "<!doctype html><html><head></head><body></body></html>",
  stored: Readonly<Record<string, string>> = {},
  initialUiPreferences = { locale: "en", theme: "system" },
  baseAgentOverrides: Readonly<Record<string, unknown>> = {},
) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://base-agent.local/",
  });
  for (const [key, value] of Object.entries(stored)) {
    dom.window.localStorage.setItem(key, value);
  }
  Object.defineProperty(dom.window, "baseAgent", {
    value: { initialUiPreferences, ...baseAgentOverrides },
  });
  const script = dom.window.document.createElement("script");
  script.textContent = preferencesSource;
  dom.window.document.head.append(script);
  const api = (
    dom.window as unknown as {
      readonly baseAgentPreferences: PreferenceApi;
    }
  ).baseAgentPreferences;
  return { api, dom };
}

async function startRenderer(dom: JsdomInstance) {
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  Object.defineProperty(dom.window, "requestAnimationFrame", {
    value: (callback: FrameRequestCallback) => {
      dom.window.setTimeout(() => callback(Date.now()), 0);
      return 1;
    },
  });
  Object.defineProperty(dom.window, "baseAgentRichText", {
    value: {
      renderAssistantContent: (target: Element, content: string) => {
        target.textContent = content;
      },
    },
  });
  const dialog = dom.window.document.querySelector(
    "#settings-dialog",
  ) as HTMLDialogElement;
  Object.defineProperties(dialog, {
    showModal: {
      value: () => dialog.setAttribute("open", ""),
    },
    close: {
      value: () => {
        dialog.removeAttribute("open");
        const closeEvent = dom.window.document.createEvent("Event");
        closeEvent.initEvent("close", false, false);
        dialog.dispatchEvent(closeEvent);
      },
    },
  });

  const rendererScript = dom.window.document.createElement("script");
  rendererScript.textContent = rendererSource;
  dom.window.document.body.append(rendererScript);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  return dialog;
}

describe("desktop UI preferences", () => {
  it("starts in English with system appearance and blue accent", () => {
    const { api, dom } = loadPreferences();

    expect(api.locale).toBe("en");
    expect(api.theme).toBe("system");
    expect(api.accent).toBe("blue");
    expect(dom.window.document.documentElement.lang).toBe("en");
    expect(dom.window.document.documentElement.dataset.theme).toBe("system");
    expect(dom.window.document.documentElement.dataset.accent).toBe("blue");

    dom.window.close();
  });

  it("updates valid choices, persists the accent, and rejects unsupported values", () => {
    const { api, dom } = loadPreferences();

    expect(api.setLocale("zh-CN")).toBe(true);
    expect(api.setTheme("light")).toBe(true);
    expect(api.setAccent("purple")).toBe(true);
    expect(api.setLocale("fr")).toBe(false);
    expect(api.setTheme("sepia")).toBe(false);
    expect(api.setAccent("custom-css")).toBe(false);

    expect(api.locale).toBe("zh-CN");
    expect(api.theme).toBe("light");
    expect(api.accent).toBe("purple");
    expect(dom.window.localStorage.getItem("base-agent:locale")).toBeNull();
    expect(dom.window.localStorage.getItem("base-agent:theme")).toBeNull();
    expect(dom.window.localStorage.getItem("base-agent:accent")).toBe("purple");
    expect(dom.window.document.documentElement.dataset.theme).toBe("light");
    expect(dom.window.document.documentElement.dataset.accent).toBe("purple");

    dom.window.close();
  });

  it("uses the main-process startup preferences instead of renderer storage", () => {
    const { api, dom } = loadPreferences(
      "<!doctype html><html></html>",
      {
        "base-agent:locale": "en",
        "base-agent:theme": "light",
      },
      { locale: "zh-CN", theme: "dark" },
    );

    expect(api.locale).toBe("zh-CN");
    expect(api.theme).toBe("dark");
    expect(dom.window.document.documentElement.lang).toBe("zh-CN");
    expect(dom.window.document.documentElement.dataset.theme).toBe("dark");

    dom.window.close();
  });

  it("falls back safely when stored values are invalid", () => {
    const { api, dom } = loadPreferences("<!doctype html><html></html>", {
      "base-agent:locale": "de",
      "base-agent:theme": "sepia",
      "base-agent:accent": "url(javascript:alert(1))",
    });

    expect(api.locale).toBe("en");
    expect(api.theme).toBe("system");
    expect(api.accent).toBe("blue");

    dom.window.close();
  });

  it("translates every marked HTML attribute in both directions", () => {
    const { api, dom } = loadPreferences(indexSource);
    api.applyDocumentTranslations();

    const document = dom.window.document;
    expect(document.title).toBe("Brace");
    expect(
      document.querySelector(".window-identity > span:last-child")?.textContent,
    ).toBe("Brace");
    expect(document.querySelector(".sidebar-heading h2")?.textContent).toBe(
      "Projects",
    );
    expect(document.querySelector("#prompt")?.getAttribute("placeholder")).toBe(
      "Describe a coding task…",
    );
    expect(
      document.querySelector(".suggestion")?.getAttribute("data-prompt"),
    ).toContain("Inspect this project");
    expect(document.querySelector("#connect-model")?.textContent).toContain(
      "Connect model",
    );

    api.setLocale("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.querySelector(".sidebar-heading h2")?.textContent).toBe(
      "项目",
    );
    expect(document.querySelector("#prompt")?.getAttribute("placeholder")).toBe(
      "描述一个编码任务…",
    );
    expect(
      document.querySelector(".suggestion")?.getAttribute("data-prompt"),
    ).toContain("检查这个项目");
    expect(document.querySelector("#connect-model")?.textContent).toContain(
      "连接模型",
    );

    api.setLocale("en");
    expect(document.querySelector(".sidebar-heading h2")?.textContent).toBe(
      "Projects",
    );

    dom.window.close();
  });

  it("gates task submission and opens model settings when no key is configured", async () => {
    let startTaskCalls = 0;
    const modelSettings = {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      hasApiKey: false,
      apiKeySource: "none",
      secureStorageAvailable: true,
      providers: [
        {
          id: "deepseek",
          label: "DeepSeek",
          description: "DeepSeek",
          apiKeyHint: "Enter a key",
          baseUrl: "https://api.deepseek.com",
          defaultModel: "deepseek-chat",
          recommendedModels: ["deepseek-chat"],
        },
      ],
    };
    const { dom } = loadPreferences(
      indexSource,
      {},
      { locale: "en", theme: "system" },
      {
        snapshot: async () => ({
          projects: [
            {
              id: "project-1",
              name: "Example",
              rootPath: "/tmp/example",
            },
          ],
          threads: [],
          activeRunIds: [],
        }),
        getModelSettings: async () => modelSettings,
        startTask: async () => {
          startTaskCalls += 1;
          throw new Error("startTask should not be called without a key");
        },
        onEvent: () => undefined,
        onMenuAction: () => undefined,
        onPreviewStatus: () => undefined,
        normalizePreviewUrl: () => ({ ok: false }),
      },
    );
    const dialog = await startRenderer(dom);

    const document = dom.window.document;
    const prompt = document.querySelector("#prompt") as HTMLTextAreaElement;
    const sendTask = document.querySelector("#send-task") as HTMLButtonElement;
    const suggestion = document.querySelector(
      ".suggestion",
    ) as HTMLButtonElement;
    const connectModel = document.querySelector(
      "#connect-model",
    ) as HTMLButtonElement;

    expect(connectModel.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#suggestion-list")?.classList).toContain(
      "hidden",
    );
    expect(prompt.disabled).toBe(true);
    expect(sendTask.disabled).toBe(true);
    expect(suggestion.disabled).toBe(true);
    expect(document.querySelector("#runtime-status")?.textContent).toBe(
      "Connect a model to run tasks",
    );

    connectModel.click();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(document.activeElement?.id).toBe("settings-api-key");

    dialog.close();
    prompt.value = "Run this task";
    const submitEvent = dom.window.document.createEvent("Event");
    submitEvent.initEvent("submit", false, true);
    document
      .querySelector("#composer")
      ?.dispatchEvent(submitEvent);
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    expect(startTaskCalls).toBe(0);
    expect(dialog.hasAttribute("open")).toBe(true);

    dom.window.close();
  });

  it("keeps terminal outcomes persistent, review-first, and non-submitting", async () => {
    for (const status of ["completed", "failed"] as const) {
      let diffCalls = 0;
      let startTaskCalls = 0;
      const project = {
        id: "project-1",
        name: "Example",
        rootPath: "/tmp/example",
      };
      const thread = {
        id: `thread-${status}`,
        projectId: project.id,
        title: "Fix the example",
        mode: "local",
        workspacePath: project.rootPath,
        worktreeCleanupCommit: null,
        status,
      };
      const modelSettings = {
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        hasApiKey: true,
        apiKeySource: "secure_storage",
        secureStorageAvailable: true,
        providers: [
          {
            id: "deepseek",
            label: "DeepSeek",
            description: "DeepSeek",
            apiKeyHint: "Enter a key",
            baseUrl: "https://api.deepseek.com",
            defaultModel: "deepseek-chat",
            recommendedModels: ["deepseek-chat"],
          },
        ],
      };
      const { api, dom } = loadPreferences(
        indexSource,
        {
          "base-agent:project": project.id,
          "base-agent:thread": thread.id,
        },
        { locale: "en", theme: "system" },
        {
          snapshot: async () => ({
            projects: [project],
            threads: [thread],
            activeRunIds: [],
          }),
          getModelSettings: async () => modelSettings,
          getThread: async () => ({
            thread,
            messages: [
              {
                id: "message-1",
                threadId: thread.id,
                role: "user",
                content: "Fix the failing example and verify it.",
                createdAt: "2026-07-26T10:00:00.000Z",
              },
            ],
            runs: [
              {
                id: `run-${status}`,
                threadId: thread.id,
                status,
                model: modelSettings.model,
                startedAt: "2026-07-26T10:00:00.000Z",
                finishedAt: "2026-07-26T10:01:00.000Z",
                errorMessage:
                  status === "failed" ? "The verification command failed." : null,
              },
            ],
            events: [],
            approvals: [],
          }),
          getDiff: async () => {
            diffCalls += 1;
            return "### Untracked files\n?? src/example.ts";
          },
          startTask: async () => {
            startTaskCalls += 1;
          },
          onEvent: () => undefined,
          onMenuAction: () => undefined,
          onPreviewStatus: () => undefined,
          normalizePreviewUrl: () => ({ ok: false }),
        },
      );

      await startRenderer(dom);
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

      const document = dom.window.document;
      const outcome = document.querySelector(
        "#task-outcome",
      ) as HTMLElement;
      const next = document.querySelector(
        "#outcome-next",
      ) as HTMLButtonElement;
      const prompt = document.querySelector("#prompt") as HTMLTextAreaElement;

      expect(outcome.classList.contains("hidden")).toBe(false);
      expect(outcome.dataset.state).toBe(status);
      expect(outcome.getAttribute("aria-live")).toBe("polite");
      expect(diffCalls).toBe(1);
      expect(document.querySelector("#outcome-title")?.textContent).not.toMatch(
        /verified/i,
      );

      document.querySelector<HTMLButtonElement>("#outcome-review")?.click();
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
      expect(diffCalls).toBe(2);
      expect(document.body.classList.contains("inspector-hidden")).toBe(false);

      next.click();
      expect(startTaskCalls).toBe(0);
      expect(document.activeElement).toBe(prompt);
      expect(prompt.value).toBe(
        status === "failed"
          ? "Fix the failing example and verify it."
          : "",
      );

      expect(api.setLocale("zh-CN")).toBe(true);
      expect(api.t(`outcome.${status}.title`)).not.toMatch(/已验证/);
      dom.window.close();
    }
  });

  it("contains translations for every static and dynamic literal key", () => {
    const { api, dom } = loadPreferences(indexSource);
    const staticKeys = [
      ...indexSource.matchAll(
        /data-i18n(?:-title|-aria-label|-placeholder|-prompt)?="([^"]+)"/g,
      ),
    ].map((match) => match[1]);
    const dynamicKeys = [...rendererSource.matchAll(/\bt\("([^"]+)"/g)].map(
      (match) => match[1],
    );
    const computedKeys = ["tool.delete_file", "tool.move_file"];
    const keys = [
      ...new Set([...staticKeys, ...dynamicKeys, ...computedKeys]),
    ];

    for (const locale of ["en", "zh-CN"]) {
      expect(api.setLocale(locale)).toBe(true);
      for (const key of keys) {
        expect(api.t(key), `${locale} is missing ${key}`).not.toBe(key);
      }
    }

    dom.window.close();
  });
});
