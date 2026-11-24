import type { TransportRequest } from "@hyperttp/types";

export const EMPTY_HEADERS = Object.freeze(Object.create(null)) as Record<string, string>;
export const ABORT_ERROR = new DOMException("The operation was aborted.", "AbortError");

export function getAbortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? ABORT_ERROR;
}

export function normalizeHeaders(
  headers: TransportRequest["headers"] | Headers | undefined,
): Record<string, string> {
  if (!headers) return EMPTY_HEADERS;

  if (headers instanceof Headers) {
    let output: Record<string, string> | undefined;
    headers.forEach((value, key) => {
      (output ??= Object.create(null))[key.toLowerCase()] = value;
    });
    return output ?? EMPTY_HEADERS;
  }

  let output: Record<string, string> | undefined;
  for (const key in headers) {
    const value = headers[key];
    if (value == null) continue;

    const name = key.toLowerCase();
    const target = (output ??= Object.create(null));
    target[name] = Array.isArray(value)
      ? name === "cookie"
        ? value.join("; ")
        : value.join(", ")
      : String(value);
  }
  return output ?? EMPTY_HEADERS;
}

export function resolveUrl(baseUrl: string, value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    // Continue with the configured base URL for relative paths.
  }

  if (!baseUrl) {
    throw new TypeError(
      `Cannot resolve relative URL "${value}" without DenoTransportConfig.baseUrl.`,
    );
  }

  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(value, base).toString();
}

export function combineSignals(
  signals: readonly (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

export function normalizeResponseHeaders(headers: Headers): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = Object.create(null);
  headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") output[key.toLowerCase()] = value;
  });

  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getSetCookie === "function" ? getSetCookie.call(headers) : [];
  if (cookies.length > 0) output["set-cookie"] = cookies;
  else {
    const combined = headers.get("set-cookie");
    if (combined !== null) output["set-cookie"] = combined;
  }

  return output;
}
