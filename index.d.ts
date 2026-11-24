declare module "@hyperttp/types" {
    interface HyperClientOptions {
        /** Prefer HTTP/2 transport selection for REST and gRPC without modifying global fetch. */
        http2?: boolean;
    }
}
export { DenoTransport } from "./deno.js";
export type { CacheOptions, DenoHttpClientOptions, DenoTransportConfig } from "./types/index.js";
//# sourceMappingURL=index.d.ts.map