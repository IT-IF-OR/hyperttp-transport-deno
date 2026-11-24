import type { HyperTransport, TransportListenOptions, TransportRequest, TransportResponse, TransportServer } from "@hyperttp/types";
import type { DenoTransportConfig } from "./types/index.js";
/**
 * HTTP transport for Deno, implemented on top of Deno's native Fetch API,
 * Deno.createHttpClient and Deno.serve.
 *
 * The transport only performs network I/O. Response bodies are returned as raw
 * ReadableStreams and are never parsed here.
 */
export declare class DenoTransport implements HyperTransport {
    readonly protocols: readonly ["rest"];
    readonly config: DenoTransportConfig;
    private readonly httpClient?;
    private readonly servers;
    private readonly lifecycle;
    private readonly cookieDomains;
    private readonly cookieHeaderCache;
    private readonly responseCache;
    private readonly waiters;
    private readonly idleWaiters;
    private readonly maxConcurrent;
    private readonly timeout;
    private readonly cookieCacheEnabled;
    private readonly cookieCacheMaxSize;
    private readonly cookieCacheTtl;
    private readonly responseCacheEnabled;
    private readonly responseCacheMaxSize;
    private readonly responseCacheTtl;
    private hasCookies;
    private activeRequests;
    private closing;
    private shutdownPromise?;
    constructor(config?: DenoTransportConfig);
    supports(protocol: string): boolean;
    /** Starts a native Deno HTTP server and forwards raw request/response streams. */
    listen(options: TransportListenOptions): Promise<TransportServer>;
    /** Executes one HTTP request and returns the unconsumed native response body. */
    execute(request: TransportRequest): Promise<TransportResponse>;
    /** Gracefully stops listeners, drains requests, and releases the native HTTP client. */
    close(): Promise<void>;
    /** Aborts active requests/listeners before releasing resources. */
    destroy(): Promise<void>;
    private resolveHttpClientOptions;
    private acquireSlot;
    private releaseSlot;
    private waitForIdle;
    private getCache;
    private setCache;
    private getCookiesForDomain;
    private storeCookies;
    private shutdown;
}
//# sourceMappingURL=deno.d.ts.map