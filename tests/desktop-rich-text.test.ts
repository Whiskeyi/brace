import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

interface RichTextApi {
  renderAssistantContent(container: Element, value: string): void;
}

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  readonly JSDOM: new (
    html?: string,
    options?: Readonly<Record<string, unknown>>,
  ) => { readonly window: Window & { close(): void } };
};

const projectRoot = process.cwd();
const richTextSource = readFileSync(
  path.join(projectRoot, "desktop/renderer/rich-text.js"),
  "utf8",
);
const rendererSource = readFileSync(
  path.join(projectRoot, "desktop/renderer/renderer.js"),
  "utf8",
);

function loadRichText() {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    runScripts: "dangerously",
  });
  const script = dom.window.document.createElement("script");
  script.textContent = richTextSource;
  dom.window.document.head.append(script);
  const api = (
    dom.window as unknown as { readonly baseAgentRichText: RichTextApi }
  ).baseAgentRichText;
  return { api, dom };
}

describe("desktop assistant rich text", () => {
  it("renders fenced and inline code with DOM text nodes only", () => {
    const { api, dom } = loadRichText();
    const container = dom.window.document.createElement("div");

    api.renderAssistantContent(
      container,
      "Use `pnpm test`.\n```ts\nconst value = '<safe>';\n```",
    );

    expect(container.querySelector(".inline-code")?.textContent).toBe(
      "pnpm test",
    );
    expect(container.querySelector(".message-code-language")?.textContent).toBe(
      "ts",
    );
    expect(container.querySelector("pre code")?.textContent).toBe(
      "const value = '<safe>';\n",
    );
    dom.window.close();
  });

  it("does not interpret assistant-controlled HTML", () => {
    const { api, dom } = loadRichText();
    const container = dom.window.document.createElement("div");

    api.renderAssistantContent(
      container,
      '<img src=x onerror="window.compromised=true"> `</code><script>`',
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
    expect(richTextSource).not.toContain("innerHTML");
    dom.window.close();
  });

  it("keeps timeline rendering indexed and bounded", () => {
    expect(rendererSource).toContain(
      "const MAX_RENDERED_TIMELINE_ITEMS = 400;",
    );
    expect(rendererSource).toContain("eventRecordKeys.has(recordKey)");
    expect(rendererSource).not.toContain("detail.events.some(");
  });
});
