# Changelog

## [0.1.3] - 2026-11-24

### Added

- Added the `http2` client-option declaration when the Deno transport entry point is imported.
- Fetch-based `DenoTransport` remains REST-only.

## [0.1.0] - 2026-11-22

### Added

- Initial native Deno transport implementing `HyperTransport`.
- Native Deno namespace typings for `Deno.HttpClient`, `Deno.HttpServer`, `Deno.ServeTcpOptions`, and HTTP client options.
- REST request execution through Deno Fetch with raw response streams.
- HTTP listener through `Deno.serve`, preserving raw request/response bodies and repeated response headers.
- Global timeout, AbortSignal composition and FIFO concurrency limiting.
- Optional Deno `HttpClient` configuration for connection pooling, custom CA certificates, mTLS and proxies.
- Domain cookie storage with TTL/LRU eviction.
- Optional empty-body GET/HEAD response cache.
- Graceful server shutdown and forced request/listener cancellation.
- Vitest unit tests and a Deno runtime smoke example.
