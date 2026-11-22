/** Cache configuration shared by the cookie jar and empty-body response cache. */
export interface CacheOptions {
  enabled?: boolean;
  maxSize?: number;
  ttl?: number;
}

/**
 * Native Deno HTTP client options.
 *
 * The mTLS branch requires both `cert` and `key`, matching
 * `Deno.createHttpClient()`'s native overload.
 */
export type DenoHttpClientOptions =
  | Deno.CreateHttpClientOptions
  | (Deno.CreateHttpClientOptions & Deno.TlsCertifiedKeyPem);

/**
 * Configuration for DenoTransport.
 *
 * TLS verification remains enabled. Use `httpClient.caCerts` for private CAs;
 * Deno's native HTTP client does not expose Bun's per-request cipher controls.
 */
export interface DenoTransportConfig {
  /** Base URL used to resolve relative request URLs. */
  baseUrl?: string;
  network?: {
    /** Global request timeout in milliseconds. 0 disables the timeout. */
    timeout?: number;
    /** Maximum active requests. 0 means unlimited. */
    maxConcurrent?: number;
    /** Maps to Deno's native connection-pool idle timeout. */
    keepAliveTimeout?: number;
    /** Cookie storage options. Enabled by default. */
    cookieCache?: CacheOptions;
    /** Optional cache for GET/HEAD responses whose body is null. */
    cache?: CacheOptions;
    /** Native options passed directly to Deno.createHttpClient. */
    httpClient?: DenoHttpClientOptions;
  };
}
