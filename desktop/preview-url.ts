const LOCAL_PREVIEW_HOSTS = new Set(["localhost", "127.0.0.1"]);

export type LocalPreviewUrlErrorCode =
  | "preview.emptyAddress"
  | "preview.untrustedAddress";

export type LocalPreviewUrlResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly errorCode: LocalPreviewUrlErrorCode };

export class LocalPreviewUrlError extends Error {
  readonly code: LocalPreviewUrlErrorCode;

  constructor(code: LocalPreviewUrlErrorCode) {
    super(code);
    this.name = "LocalPreviewUrlError";
    this.code = code;
  }
}

export function isAllowedLocalPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      LOCAL_PREVIEW_HOSTS.has(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function normalizeLocalPreviewUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new LocalPreviewUrlError("preview.emptyAddress");
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  if (!isAllowedLocalPreviewUrl(candidate)) {
    throw new LocalPreviewUrlError("preview.untrustedAddress");
  }
  return new URL(candidate).href;
}

export function tryNormalizeLocalPreviewUrl(
  value: string,
): LocalPreviewUrlResult {
  try {
    return { ok: true, url: normalizeLocalPreviewUrl(value) };
  } catch (error) {
    return {
      ok: false,
      errorCode:
        error instanceof LocalPreviewUrlError
          ? error.code
          : "preview.untrustedAddress",
    };
  }
}

export function isAllowedPreviewNavigation(
  value: string,
  isMainFrame: boolean,
): boolean {
  return (
    !isMainFrame &&
    (value === "about:blank" || isAllowedLocalPreviewUrl(value))
  );
}
