import { Http2Transport, type Http2TransportConfig } from "@hyperttp/transport-node";
/**
 * @ru Полноценный HTTP/2 транспорт Deno через совместимый `node:http2` API.
 * Нужен для gRPC trailers; `DenoTransport` на Fetch API предназначен для REST.
 * @en Full HTTP/2 Deno transport through the compatible `node:http2` API.
 * It supports gRPC trailers; Fetch-based `DenoTransport` remains for REST.
 */
export declare class DenoHttp2Transport extends Http2Transport {
    constructor(config?: Http2TransportConfig);
}
//# sourceMappingURL=http2.d.ts.map