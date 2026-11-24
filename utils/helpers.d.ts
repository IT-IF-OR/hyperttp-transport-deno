import type { TransportRequest } from "@hyperttp/types";
export declare const EMPTY_HEADERS: Record<string, string>;
export declare const ABORT_ERROR: DOMException;
export declare function getAbortError(signal?: AbortSignal): unknown;
export declare function normalizeHeaders(headers: TransportRequest["headers"] | Headers | undefined): Record<string, string>;
export declare function resolveUrl(baseUrl: string, value: string): string;
export declare function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined;
export declare function normalizeResponseHeaders(headers: Headers): Record<string, string | string[]>;
//# sourceMappingURL=helpers.d.ts.map