# DenoTransport

Native HTTP transport for the Hyperttp ecosystem. It uses Deno's built-in `fetch`,
`Deno.createHttpClient` (only when custom connection/TLS/proxy options are configured),
and `Deno.serve` for server-side requests.

## Features

- Implements the `HyperTransport` contract from `@hyperttp/types`.
- REST protocol support (`protocols: ["rest"]`).
- Raw response bodies: returns the native `ReadableStream` without parsing or buffering.
- Native request and response streaming in `listen()`.
- Request cancellation and global request timeout through `AbortSignal`.
- Optional FIFO concurrency limit.
- Cookie jar with domain matching, TTL and LRU domain eviction.
- Optional response cache for GET/HEAD responses whose body is `null` (one-shot streams are never cached).
- Native Deno connection pooling; optional pool configuration, custom CA certificates, mTLS and proxy through `Deno.createHttpClient`.
- Graceful server shutdown through `Deno.HttpServer.shutdown()` and forced shutdown through an internal abort signal.
- No runtime dependencies.

## Install

```bash
deno add npm:@hyperttp/transport-deno npm:@hyperttp/types
```

Or with Bun:

```bash
bun add @hyperttp/transport-deno @hyperttp/types
bun add -d @types/deno
```

For TypeScript projects compiled with `tsc`, install `@types/deno` and include
`"deno"` in `compilerOptions.types`. Deno itself provides its native `Deno.*`
types when checking code with `deno check`.

## Usage

```ts
import { HyperClient } from "hyperttp";
import { DenoTransport } from "@hyperttp/transport-deno";

const transport = new DenoTransport({
  baseUrl: "https://api.example.com",
  network: {
    timeout: 10_000,
    maxConcurrent: 32,
    cookieCache: { enabled: true, maxSize: 256, ttl: 300_000 },
    httpClient: {
      poolMaxIdlePerHost: 16,
      poolIdleTimeout: 30_000,
    },
  },
});

const client = new HyperClient({}, transport);
const response = await client.rest.get("/health");
console.log(response.status, response.data);

await client.destroy(true);
```

When no custom HTTP client options are supplied, requests use Deno's global Fetch
implementation and its built-in connection pool. `maxConcurrent` is a transport-level
FIFO limit; it is independent of the HTTP connection pool.

## Server

```ts
const transport = new DenoTransport();
const server = await transport.listen({
  host: "127.0.0.1",
  port: 3000,
  onRequest(request) {
    return {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "Hello from Deno",
    };
  },
});

await server.close(); // graceful: lets in-flight requests finish
await transport.destroy(); // forcefully aborts listeners and active requests
```

The transport contract uses `host` in `TransportListenOptions`:

```ts
await transport.listen({
  host: "127.0.0.1",
  port: 3000,
  onRequest: async (request) => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: request.method, url: request.url }),
  }),
});
```

## Configuration

```ts
interface DenoTransportConfig {
  baseUrl?: string;
  network?: {
    timeout?: number;
    maxConcurrent?: number;
    keepAliveTimeout?: number;
    cookieCache?: { enabled?: boolean; maxSize?: number; ttl?: number };
    cache?: { enabled?: boolean; maxSize?: number; ttl?: number };
    httpClient?: Deno.CreateHttpClientOptions
      | (Deno.CreateHttpClientOptions & Deno.TlsCertifiedKeyPem);
  };
}
```

`keepAliveTimeout` maps to Deno's `poolIdleTimeout` when an explicit custom
`Deno.HttpClient` is needed. Deno already pools connections when using native fetch.
`httpClient` is typed directly as Deno's `Deno.CreateHttpClientOptions` (or its
mTLS overload `Deno.CreateHttpClientOptions & Deno.TlsCertifiedKeyPem`) and is
passed to `Deno.createHttpClient`; use `caCerts` for an additional trusted CA,
and provide both `cert` and `key` for mutual TLS.

### TLS verification

Deno's public `Deno.createHttpClient` options expose custom CA certificates and
client certificates, but do not provide a per-client `rejectUnauthorized: false`
setting. This transport intentionally does not emulate Bun's TLS bypass or custom
cipher-suite options. Do not disable certificate verification globally to work
around this limitation.

### Redirects

Redirects are manual by default, matching BunTransport's conservative default.
Set `TransportRequest.followRedirects` to `true` to use Deno Fetch's native redirect
handling. Deno Fetch controls its own redirect limit; the transport does not currently
override that runtime limit with `maxRedirects`.

### Cache limitations

The response cache only stores responses with a `null` body. Streaming bodies are
one-shot resources and are always passed through unchanged. The cookie jar is a small
domain-scoped convenience store; it does not attempt to implement every browser cookie
policy such as path, SameSite, Secure and Expires enforcement.


### Incoming request cancellation

`listen()` forwards the native `Request.signal` to `onRequest`, allowing receivers
to observe client disconnects. Deno documents a legacy behavior where this signal can
also abort after a successful handler return; use Deno's `--unstable-no-legacy-abort`
when the runtime version exposes it and that distinction matters to your application.

## Run the smoke example

From this package directory:

```bash
deno run --minimum-dependency-age=0 --allow-net --sloppy-imports examples/smoke.ts
```

Type-check the source with:

```bash
deno task check
```

For the package's Vitest unit tests, install development dependencies and run `npm test`.

## Permissions

The caller grants network permissions to Deno, for example:

```bash
deno run --allow-net main.ts
```

## Compatibility

- Deno runtime required. Importing the package is safe in other runtimes, but creating
  `DenoTransport` requires `Deno.serve`.
- Requires `@hyperttp/types` `^0.5.4` or compatible.
- No Node.js or Bun runtime APIs are used by the implementation.
