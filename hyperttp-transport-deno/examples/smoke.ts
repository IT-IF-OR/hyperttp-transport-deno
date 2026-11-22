import { DenoTransport } from "../src/index.ts";

const transport = new DenoTransport({ network: { timeout: 5_000 } });
const server = await transport.listen({
  host: "127.0.0.1",
  port: 18_777,
  onRequest(request) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtime: "deno",
        method: request.method,
        path: new URL(request.url).pathname,
      }),
    };
  },
});

try {
  const response = await transport.execute({
    url: "http://127.0.0.1:18777/health",
    method: "GET",
    headers: {},
    protocol: "rest",
  });

  const text = await new Response(response.body as ReadableStream<Uint8Array>).text();
  console.log({ status: response.status, body: JSON.parse(text) });
} finally {
  await server.close();
  await transport.close();
}
