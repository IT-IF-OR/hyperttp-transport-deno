import type {
  HyperTransport,
  TransportListenOptions,
  TransportRequest,
  TransportResponse,
  TransportServer,
} from "@hyperttp/types";
import type { DenoHttpClientOptions, DenoTransportConfig } from "./types/index.js";
import {
  combineSignals,
  EMPTY_HEADERS,
  getAbortError,
  normalizeHeaders,
  normalizeResponseHeaders,
  resolveUrl,
} from "./utils/helpers.js";

interface Waiter {
  signal?: AbortSignal;
  resolve: () => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
}

interface CookieDomainEntry {
  readonly cookies: Map<string, string>;
  expiresAt: number;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

interface RunningServer {
  readonly server: Deno.HttpServer;
  readonly controller: AbortController;
  readonly stop: (force?: boolean) => Promise<void>;
}

type DenoFetchInit = RequestInit & { client?: Deno.HttpClient };

function assertDenoAvailable(): void {
  if (typeof Deno === "undefined" || typeof Deno.serve !== "function") {
    throw new Error("DenoTransport requires the Deno runtime (Deno.serve is unavailable).");
  }
}

function mergeCookieHeaders(current: string | undefined, stored: string): string {
  if (!current) return stored;
  if (!stored) return current;
  return `${current}; ${stored}`;
}

/**
 * HTTP transport for Deno, implemented on top of Deno's native Fetch API,
 * Deno.createHttpClient and Deno.serve.
 *
 * The transport only performs network I/O. Response bodies are returned as raw
 * ReadableStreams and are never parsed here.
 */
export class DenoTransport implements HyperTransport {
  public readonly protocols = ["rest"] as const;
  public readonly config: DenoTransportConfig;

  private readonly httpClient?: Deno.HttpClient;
  private readonly servers = new Set<RunningServer>();
  private readonly lifecycle = new AbortController();
  private readonly cookieDomains = new Map<string, CookieDomainEntry>();
  private readonly cookieHeaderCache = new Map<string, CacheEntry<string>>();
  private readonly responseCache = new Map<string, CacheEntry<TransportResponse>>();
  private readonly waiters: Waiter[] = [];
  private readonly idleWaiters: Array<() => void> = [];

  private readonly maxConcurrent: number;
  private readonly timeout: number;
  private readonly cookieCacheEnabled: boolean;
  private readonly cookieCacheMaxSize: number;
  private readonly cookieCacheTtl: number;
  private readonly responseCacheEnabled: boolean;
  private readonly responseCacheMaxSize: number;
  private readonly responseCacheTtl: number;

  private hasCookies = false;
  private activeRequests = 0;
  private closing = false;
  private shutdownPromise?: Promise<void>;

  public constructor(config: DenoTransportConfig = {}) {
    assertDenoAvailable();
    this.config = config;

    const network = config.network;
    this.maxConcurrent = Number.isFinite(network?.maxConcurrent)
      ? Math.max(0, Math.floor(network?.maxConcurrent ?? 0))
      : 0;
    this.timeout = Number.isFinite(network?.timeout) ? Math.max(0, network?.timeout ?? 0) : 0;

    const cookieConfig = network?.cookieCache;
    this.cookieCacheEnabled = cookieConfig?.enabled ?? true;
    this.cookieCacheMaxSize = Math.max(1, Math.floor(cookieConfig?.maxSize ?? 256));
    this.cookieCacheTtl = Math.max(0, cookieConfig?.ttl ?? 300_000);

    const responseCacheConfig = network?.cache;
    this.responseCacheEnabled =
      responseCacheConfig?.enabled ??
      Boolean(
        responseCacheConfig &&
        (responseCacheConfig.maxSize !== undefined || responseCacheConfig.ttl !== undefined),
      );
    this.responseCacheMaxSize = Math.max(1, Math.floor(responseCacheConfig?.maxSize ?? 256));
    this.responseCacheTtl = Math.max(0, responseCacheConfig?.ttl ?? 30_000);

    const clientOptions = this.resolveHttpClientOptions(
      network?.httpClient,
      network?.keepAliveTimeout,
    );
    if (Object.keys(clientOptions).length > 0) {
      if (typeof Deno.createHttpClient !== "function") {
        throw new Error("This Deno runtime does not expose Deno.createHttpClient().");
      }
      this.httpClient = Deno.createHttpClient(clientOptions);
    }
  }

  public supports(protocol: string): boolean {
    return protocol === "rest";
  }

  /** Starts a native Deno HTTP server and forwards raw request/response streams. */
  public async listen(options: TransportListenOptions): Promise<TransportServer> {
    if (this.closing) throw new Error("DenoTransport is closing and cannot start a server.");
    if (options.signal?.aborted) throw getAbortError(options.signal);

    const controller = new AbortController();
    let stopServer: ((force?: boolean) => Promise<void>) | undefined;
    const onExternalAbort = (): void => {
      if (!controller.signal.aborted) controller.abort(options.signal?.reason);
      void stopServer?.(true).catch(() => {});
    };

    if (options.signal?.aborted) {
      options.signal.removeEventListener("abort", onExternalAbort);
      throw getAbortError(options.signal);
    }

    const serveOptions: Deno.ServeTcpOptions = {
      ...(options.host !== undefined ? { hostname: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      signal: controller.signal,
      // Suppress Deno.serve's default startup log; the host application owns logging.
      onListen: () => {},
    };

    let server: Deno.HttpServer;
    try {
      server = Deno.serve(serveOptions, async (request) => {
        if (!options.onRequest) return new Response(null, { status: 503 });

        const headers: Record<string, string> = Object.create(null);
        request.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });

        const incoming: TransportRequest = {
          method: request.method,
          url: request.url,
          headers,
          body: request.body,
          signal: request.signal,
          protocol: "rest",
        };
        const outgoing = await options.onRequest(incoming);
        const responseHeaders = new Headers();

        for (const [name, value] of Object.entries(outgoing.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item);
          } else {
            responseHeaders.set(name, value);
          }
        }

        return new Response(outgoing.body as BodyInit | null | undefined, {
          status: outgoing.status,
          ...(outgoing.statusText !== undefined ? { statusText: outgoing.statusText } : {}),
          headers: responseHeaders,
        });
      });
    } catch (error) {
      options.signal?.removeEventListener("abort", onExternalAbort);
      throw error;
    }

    let stopPromise: Promise<void> | undefined;
    const stop = (force = false): Promise<void> => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        try {
          if (force) {
            if (!controller.signal.aborted) controller.abort();
            await server.finished;
          } else {
            await server.shutdown();
          }
        } finally {
          options.signal?.removeEventListener("abort", onExternalAbort);
          this.servers.delete(runningServer);
        }
      })();
      return stopPromise;
    };
    const runningServer: RunningServer = { server, controller, stop };
    stopServer = stop;

    this.servers.add(runningServer);
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal?.aborted) {
      await stop(true);
      throw getAbortError(options.signal);
    }

    return { close: () => stop(false) };
  }

  /** Executes one HTTP request and returns the unconsumed native response body. */
  public async execute(request: TransportRequest): Promise<TransportResponse> {
    if (this.closing) throw new Error("DenoTransport is closed and cannot execute new requests.");

    const url = resolveUrl(this.config.baseUrl ?? "", request.url);
    const signal = combineSignals([
      request.signal,
      this.lifecycle.signal,
      this.timeout > 0 ? AbortSignal.timeout(this.timeout) : undefined,
    ]);

    await this.acquireSlot(signal);

    try {
      const cacheKey = `${request.method.toUpperCase()}:${url}`;
      if (
        this.responseCacheEnabled &&
        request.stream !== true &&
        (request.method === "GET" || request.method === "HEAD") &&
        request.body == null
      ) {
        const cached = this.getCache(this.responseCache, cacheKey);
        if (cached !== undefined) return cached;
      }

      let headers = normalizeHeaders(request.headers);
      if (this.hasCookies && this.cookieCacheEnabled) {
        const storedCookies = this.getCookiesForDomain(new URL(url).hostname);
        if (storedCookies) {
          if (headers === EMPTY_HEADERS) headers = Object.create(null);
          headers.cookie = mergeCookieHeaders(headers.cookie, storedCookies);
        }
      }

      const init: DenoFetchInit = {
        method: request.method,
        redirect: request.followRedirects === true ? "follow" : "manual",
      };
      if (headers !== EMPTY_HEADERS) init.headers = headers;
      if (request.body !== undefined) init.body = request.body as BodyInit | null;
      if (signal !== undefined) init.signal = signal;
      if (this.httpClient) init.client = this.httpClient;

      const nativeResponse = await fetch(url, init);
      if (this.cookieCacheEnabled) this.storeCookies(url, nativeResponse.headers);

      const response: TransportResponse = {
        status: nativeResponse.status,
        statusText: nativeResponse.statusText,
        url: nativeResponse.url,
        headers: normalizeResponseHeaders(nativeResponse.headers),
        body: nativeResponse.body,
      };

      // A one-shot response stream must not be cached. Only bodyless responses are safe.
      if (
        this.responseCacheEnabled &&
        request.stream !== true &&
        (request.method === "GET" || request.method === "HEAD") &&
        request.body == null &&
        nativeResponse.body === null
      ) {
        this.setCache(
          this.responseCache,
          cacheKey,
          response,
          this.responseCacheMaxSize,
          this.responseCacheTtl,
        );
      }

      return response;
    } finally {
      this.releaseSlot();
    }
  }

  /** Gracefully stops listeners, drains requests, and releases the native HTTP client. */
  public close(): Promise<void> {
    return this.shutdown(false);
  }

  /** Aborts active requests/listeners before releasing resources. */
  public destroy(): Promise<void> {
    return this.shutdown(true);
  }

  private resolveHttpClientOptions(
    configured: DenoHttpClientOptions | undefined,
    keepAliveTimeout: number | undefined,
  ): DenoHttpClientOptions {
    const options: DenoHttpClientOptions = { ...configured };
    const cert = "cert" in options ? options.cert : undefined;
    const key = "key" in options ? options.key : undefined;
    if ((cert && !key) || (!cert && key)) {
      throw new TypeError("Deno HttpClient mTLS requires both `cert` and `key`.");
    }
    if (keepAliveTimeout !== undefined && options.poolIdleTimeout === undefined) {
      options.poolIdleTimeout = keepAliveTimeout;
    }
    if (this.config.network?.http2 !== undefined && options.http2 === undefined) {
      options.http2 = this.config.network.http2;
    }
    return options;
  }

  private acquireSlot(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(getAbortError(signal));
    if (this.closing) return Promise.reject(new Error("DenoTransport is closed."));

    if (this.maxConcurrent === 0 || this.activeRequests < this.maxConcurrent) {
      this.activeRequests++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort!);
          reject(getAbortError(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
        if (signal.aborted) {
          waiter.onAbort();
          return;
        }
      }
      this.waiters.push(waiter);
    });
  }

  private releaseSlot(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(getAbortError(waiter.signal));
        continue;
      }
      // Hand the current active slot directly to the next FIFO waiter.
      waiter.resolve();
      return;
    }

    this.activeRequests = Math.max(0, this.activeRequests - 1);
    if (this.activeRequests === 0) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private waitForIdle(): Promise<void> {
    if (this.activeRequests === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private getCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return undefined;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry.value;
  }

  private setCache<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    value: T,
    maxSize: number,
    ttl: number,
  ): void {
    if (ttl <= 0) return;
    cache.delete(key);
    cache.set(key, { value, expiresAt: Date.now() + ttl });
    while (cache.size > maxSize) cache.delete(cache.keys().next().value!);
  }

  private getCookiesForDomain(hostname: string): string {
    const now = Date.now();
    const cached = this.cookieHeaderCache.get(hostname);
    if (cached && cached.expiresAt > now) {
      this.cookieHeaderCache.delete(hostname);
      this.cookieHeaderCache.set(hostname, cached);
      return cached.value;
    }
    if (cached) this.cookieHeaderCache.delete(hostname);

    const matching: Array<[string, CookieDomainEntry]> = [];
    for (const [domain, entry] of this.cookieDomains) {
      if (entry.expiresAt <= now) {
        this.cookieDomains.delete(domain);
        continue;
      }
      if (hostname === domain || hostname.endsWith(`.${domain}`)) matching.push([domain, entry]);
    }

    let result = "";
    let cacheExpiresAt = now + 60_000;
    for (const [domain, entry] of matching) {
      cacheExpiresAt = Math.min(cacheExpiresAt, entry.expiresAt);
      this.cookieDomains.delete(domain);
      this.cookieDomains.set(domain, entry);
      for (const [name, value] of entry.cookies) {
        if (result) result += "; ";
        result += `${name}=${value}`;
      }
    }

    this.cookieHeaderCache.set(hostname, { value: result, expiresAt: cacheExpiresAt });
    if (this.cookieHeaderCache.size > this.cookieCacheMaxSize * 4) {
      const oldest = this.cookieHeaderCache.keys().next().value;
      if (oldest !== undefined) this.cookieHeaderCache.delete(oldest);
    }
    if (this.cookieDomains.size === 0) this.hasCookies = false;
    return result;
  }

  private storeCookies(requestUrl: string, headers: Headers): void {
    if (!this.cookieCacheEnabled) return;
    const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    if (typeof getSetCookie !== "function") return;

    const setCookies = getSetCookie.call(headers);
    if (setCookies.length === 0) return;

    const defaultDomain = new URL(requestUrl).hostname.toLowerCase();
    const now = Date.now();
    if (this.cookieCacheTtl === 0) return;

    for (const rawCookie of setCookies) {
      const separator = rawCookie.indexOf(";");
      const pair = separator === -1 ? rawCookie : rawCookie.slice(0, separator);
      const equals = pair.indexOf("=");
      if (equals <= 0) continue;

      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1).trim();
      let domain = defaultDomain;
      if (separator !== -1) {
        for (const attribute of rawCookie.slice(separator + 1).split(";")) {
          const trimmed = attribute.trim();
          if (trimmed.toLowerCase().startsWith("domain=")) {
            const supplied = trimmed.slice(7).trim().replace(/^\./, "").toLowerCase();
            if (
              supplied &&
              (defaultDomain === supplied || defaultDomain.endsWith(`.${supplied}`))
            ) {
              domain = supplied;
            } else {
              domain = "";
            }
            break;
          }
        }
      }

      if (!domain) continue;

      let entry = this.cookieDomains.get(domain);
      if (!entry) {
        entry = { cookies: new Map(), expiresAt: now + this.cookieCacheTtl };
        this.cookieDomains.set(domain, entry);
      }
      entry.cookies.set(name, value);
      entry.expiresAt = now + this.cookieCacheTtl;
      this.cookieDomains.delete(domain);
      this.cookieDomains.set(domain, entry);
      while (this.cookieDomains.size > this.cookieCacheMaxSize) {
        this.cookieDomains.delete(this.cookieDomains.keys().next().value!);
      }

      this.hasCookies = this.cookieDomains.size > 0;
      this.cookieHeaderCache.clear();
    }
  }

  private shutdown(force: boolean): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;

    this.shutdownPromise = (async () => {
      if (force && !this.lifecycle.signal.aborted) this.lifecycle.abort();

      await Promise.all(Array.from(this.servers, ({ stop }) => stop(force)));
      await this.waitForIdle();

      this.httpClient?.close();
      this.cookieDomains.clear();
      this.cookieHeaderCache.clear();
      this.responseCache.clear();
      this.hasCookies = false;
    })();

    return this.shutdownPromise;
  }
}
