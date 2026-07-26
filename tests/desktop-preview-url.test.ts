import { describe, expect, it } from "vitest";

import {
  isAllowedPreviewNavigation,
  isAllowedLocalPreviewUrl,
  LocalPreviewUrlError,
  normalizeLocalPreviewUrl,
  tryNormalizeLocalPreviewUrl,
} from "../desktop/preview-url";

describe("desktop local preview URLs", () => {
  it.each([
    "http://localhost",
    "http://localhost:3000/",
    "http://localhost:5173/path?mode=preview#app",
    "http://127.0.0.1:8080/",
  ])("allows exact loopback HTTP URL %s", (value) => {
    expect(isAllowedLocalPreviewUrl(value)).toBe(true);
  });

  it.each([
    "https://localhost:3000/",
    "http://localhost.evil.example/",
    "http://localhost.:3000/",
    "http://127.0.0.2:3000/",
    "http://user:secret@localhost:3000/",
    "file:///tmp/index.html",
    "data:text/html,hello",
    "javascript:alert(1)",
    "not a url",
  ])("rejects non-preview URL %s", (value) => {
    expect(isAllowedLocalPreviewUrl(value)).toBe(false);
  });

  it("normalizes a host and port without a scheme", () => {
    expect(normalizeLocalPreviewUrl("localhost:3000")).toBe(
      "http://localhost:3000/",
    );
  });

  it("rejects an empty or untrusted value during normalization", () => {
    expect(() => normalizeLocalPreviewUrl(" ")).toThrowError(
      expect.objectContaining<Partial<LocalPreviewUrlError>>({
        code: "preview.emptyAddress",
      }),
    );
    expect(() => normalizeLocalPreviewUrl("https://example.com")).toThrowError(
      expect.objectContaining<Partial<LocalPreviewUrlError>>({
        code: "preview.untrustedAddress",
      }),
    );
  });

  it("returns renderer-localizable error codes without throwing over the bridge", () => {
    expect(tryNormalizeLocalPreviewUrl("localhost:3000")).toEqual({
      ok: true,
      url: "http://localhost:3000/",
    });
    expect(tryNormalizeLocalPreviewUrl(" ")).toEqual({
      ok: false,
      errorCode: "preview.emptyAddress",
    });
  });

  it("allows only blank or loopback navigation in child frames", () => {
    expect(isAllowedPreviewNavigation("about:blank", false)).toBe(true);
    expect(
      isAllowedPreviewNavigation("http://localhost:3000/app", false),
    ).toBe(true);
    expect(
      isAllowedPreviewNavigation("http://127.0.0.1:5173/", false),
    ).toBe(true);
    expect(isAllowedPreviewNavigation("https://example.com", false)).toBe(
      false,
    );
    expect(isAllowedPreviewNavigation("data:text/html,hello", false)).toBe(
      false,
    );
  });

  it("never permits the desktop shell main frame to navigate", () => {
    expect(isAllowedPreviewNavigation("about:blank", true)).toBe(false);
    expect(
      isAllowedPreviewNavigation("http://localhost:3000/", true),
    ).toBe(false);
  });
});
