import { afterEach, describe, expect, it, vi } from "vitest";
import { DenoTransport } from "../src/index.ts";

interface FakeDenoServer {
  finished: Promise<void>;
  shutdown: () => Promise<void>;
}

interface FakeDenoApi {
  createHttpClient?: (options: Record<string, unknown>) => { close(): void };
  serve: (
    options: Record<string, unknown>,
    handler: (request: Request) => Response | Promise<Response>,
  ) => FakeDenoServer;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

function stubDeno(api: FakeDenoApi): void {
  vi.stubGlobal("Deno", api);
}

describe("DenoTransport", () => {
  it("executes REST and returns the raw response stream", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;
    stubDeno({ serve: () => ({ finished: Promise.resolve(), shutdown: async () => {} }) });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calledUrl = String(input);
      calledInit = init;
      return new Response("raw-body", {
        status: 202,
        headers: { "content-type": "text/plain" },
      });
    });

    const transport = new DenoTransport({ baseUrl: "https://example.test/api" });
    expect(transport.protocols).toEqual(["rest"]);
    expect(transport.supports("rest")).toBe(true);
    expect(transport.supports("grpc")).toBe(false);

    const result = await transport.execute({
      url: "/health",
      method: "GET",
      headers: {},
      protocol: "rest",
    });

    expect(calledUrl).toBe("https://example.test/health");
    expect(calledInit?.redirect).toBe("manual");
    expect(result.status).toBe(202);
    expect(result.headers["content-type"]).toBe("text/plain");
    expect(await new Response(result.body as ReadableStream<Uint8Array>).text()).toBe("raw-body");
    await transport.close();
  });

  it("uses native redirect handling and combines cancellation signals", async () => {
    let calledInit: RequestInit | undefined;
    stubDeno({ serve: () => ({ finished: Promise.resolve(), shutdown: async () => {} }) });
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      calledInit = init;
      return new Response(null, { status: 204 });
    });

    const transport = new DenoTransport();
    const controller = new AbortController();
    await transport.execute({
      url: "https://example.test/",
      method: "GET",
      headers: {},
      protocol: "rest",
      followRedirects: true,
      signal: controller.signal,
    });

    expect(calledInit?.redirect).toBe("follow");
    expect(calledInit?.signal).toBeInstanceOf(AbortSignal);
    await transport.close();
  });

  it("stores response cookies and sends them on subsequent requests", async () => {
    let requestCount = 0;
    let secondCookie = "";
    stubDeno({ serve: () => ({ finished: Promise.resolve(), shutdown: async () => {} }) });
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestCount++;
      if (requestCount === 1) {
        return new Response(null, {
          status: 204,
          headers: { "set-cookie": "session=abc; Path=/" },
        });
      }
      secondCookie = new Headers(init?.headers).get("cookie") ?? "";
      return new Response(null, { status: 204 });
    });

    const transport = new DenoTransport();
    await transport.execute({
      url: "https://example.test/login",
      method: "POST",
      headers: {},
      protocol: "rest",
    });
    await transport.execute({
      url: "https://example.test/profile",
      method: "GET",
      headers: {},
      protocol: "rest",
    });

    expect(requestCount).toBe(2);
    expect(secondCookie).toBe("session=abc");
    await transport.close();
  });

  it("caches bodyless GET responses but never caches streams", async () => {
    let requestCount = 0;
    stubDeno({ serve: () => ({ finished: Promise.resolve(), shutdown: async () => {} }) });
    vi.stubGlobal("fetch", async () => {
      requestCount++;
      return new Response(null, { status: 204 });
    });

    const transport = new DenoTransport({ network: { cache: { enabled: true, maxSize: 8 } } });
    const request = {
      url: "https://example.test/empty",
      method: "GET",
      headers: {},
      protocol: "rest" as const,
    };
    await transport.execute(request);
    await transport.execute(request);
    expect(requestCount).toBe(1);

    await transport.execute({ ...request, url: "https://example.test/stream", stream: true });
    await transport.execute({ ...request, url: "https://example.test/stream", stream: true });
    expect(requestCount).toBe(3);
    await transport.close();
  });

  it("uses and closes a configured native Deno HttpClient", async () => {
    let clientClosed = false;
    let clientOptions: Record<string, unknown> | undefined;
    let fetchInit: (RequestInit & { client?: unknown }) | undefined;
    const client = {
      close: () => {
        clientClosed = true;
      },
    };

    stubDeno({
      createHttpClient(options) {
        clientOptions = options;
        return client;
      },
      serve: () => ({ finished: Promise.resolve(), shutdown: async () => {} }),
    });
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchInit = init as RequestInit & { client?: unknown };
      return new Response(null, { status: 204 });
    });

    const transport = new DenoTransport({
      network: {
        keepAliveTimeout: 12_000,
        httpClient: { poolMaxIdlePerHost: 8 },
      },
    });
    await transport.execute({
      url: "https://example.test/",
      method: "GET",
      headers: {},
      protocol: "rest",
    });

    expect(clientOptions?.poolMaxIdlePerHost).toBe(8);
    expect(clientOptions?.poolIdleTimeout).toBe(12_000);
    expect(fetchInit?.client).toBe(client);
    await transport.close();
    expect(clientClosed).toBe(true);
  });

  it("forwards raw server requests and preserves repeated response headers", async () => {
    let handler: ((request: Request) => Response | Promise<Response>) | undefined;
    let shutdownCalls = 0;
    let serverOptions: Record<string, unknown> | undefined;

    stubDeno({
      serve(options, callback) {
        serverOptions = options;
        handler = callback;
        return {
          finished: Promise.resolve(),
          shutdown: async () => {
            shutdownCalls++;
          },
        };
      },
    });

    const transport = new DenoTransport();
    let receivedUrl = "";
    let receivedBody: ReadableStream<Uint8Array> | null = null;
    const server = await transport.listen({
      host: "127.0.0.1",
      port: 9010,
      onRequest(request) {
        receivedUrl = request.url;
        receivedBody = request.body as ReadableStream<Uint8Array> | null;
        return {
          status: 201,
          statusText: "Created",
          headers: { "set-cookie": ["a=1; Path=/", "b=2; Path=/"] },
          body: "server-response",
        };
      },
    });

    expect(serverOptions?.hostname).toBe("127.0.0.1");
    expect(serverOptions?.port).toBe(9010);
    expect(handler).toBeDefined();

    const incoming = new Request("http://localhost/upload", { method: "POST", body: "payload" });
    const response = await handler!(incoming);
    expect(receivedUrl).toBe(incoming.url);
    expect(receivedBody).not.toBeNull();
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(await response.text()).toBe("server-response");

    await server.close();
    expect(shutdownCalls).toBe(1);
    await transport.close();
  });

  it("returns 503 from a listener without an onRequest handler", async () => {
    let handler: ((request: Request) => Response | Promise<Response>) | undefined;
    stubDeno({
      serve(_options, callback) {
        handler = callback;
        return { finished: Promise.resolve(), shutdown: async () => {} };
      },
    });

    const transport = new DenoTransport();
    await transport.listen({ port: 9011 });
    expect(handler).toBeDefined();
    const response = await handler!(new Request("http://localhost/"));
    expect(response.status).toBe(503);
    await transport.close();
  });

  it("enforces the configured FIFO concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];

    stubDeno({ serve: () => ({ finished: Promise.resolve(), shutdown: async () => {} }) });
    vi.stubGlobal("fetch", async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return new Response(null, { status: 204 });
    });

    const transport = new DenoTransport({ network: { maxConcurrent: 2 } });
    const requests = Array.from({ length: 5 }, (_, index) =>
      transport.execute({
        url: `https://example.test/${index}`,
        method: "GET",
        headers: {},
        protocol: "rest",
      }),
    );

    for (let completed = 0; completed < 5; completed++) {
      while (releases.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      releases.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await Promise.all(requests);
    expect(peak).toBe(2);
    await transport.close();
  });

  it("aborts active fetch requests when destroyed", async () => {
    let observedSignal: AbortSignal | undefined;
    stubDeno({ serve: () => ({ finished: Promise.resolve(), shutdown: async () => {} }) });
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), {
          once: true,
        });
      });
    });

    const transport = new DenoTransport();
    const request = transport
      .execute({
        url: "https://example.test/slow",
        method: "GET",
        headers: {},
        protocol: "rest",
      })
      .then(
        () => false,
        () => true,
      );

    while (!observedSignal) await new Promise((resolve) => setTimeout(resolve, 0));
    await transport.destroy();
    expect(await request).toBe(true);
    expect(observedSignal.aborted).toBe(true);
  });
});
