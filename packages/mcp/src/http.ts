/**
 * The server over Streamable HTTP on 127.0.0.1, for agents that are given a URL rather than a command:
 * one MCP session per client, all on the same workspace, so the game files are read once.
 *
 * The SDK's web-standard transport, with the requests and responses converted here: its Node.js wrapper
 * (through @hono/node-server 2.1) announces chunked encoding and then writes the body unframed, which
 * clients cannot read.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import { createServer } from './tools';
import type { Workspace } from './workspace';

/** The address the server listens on: this machine only, as its tools read the files on it. */
export const httpHost = '127.0.0.1';

/** The path of the MCP endpoint. */
export const httpPath = '/mcp';

/** The most a request body may hold: a `check` with the text of a large script. */
const bodyLimit = 32 * 1024 * 1024;

/** True for a Host header naming this machine at the port: a page elsewhere cannot rebind its name to it. */
function localHost(host: string | undefined, port: number): boolean {
  return host !== undefined && [`${httpHost}:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase());
}

/** True when there is no Origin header, as agents send none, or it is a page on this machine. */
function localOrigin(origin: string | undefined): boolean {
  if (origin === undefined) {
    return true;
  }
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function reply(response: http.ServerResponse, status: number, message: string): void {
  if (!response.headersSent) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
  }
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/** The body of a request. */
async function bodyOf(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > bodyLimit) {
      throw new Error('The request is too large.');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** The body as JSON, or undefined when it is not JSON. */
function parsed(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Hands a request to the transport and writes its response, streamed as it comes, until either side stops. */
async function forward(
  transport: WebStandardStreamableHTTPServerTransport,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  body: Buffer,
  json: unknown
): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      value.forEach((each) => headers.append(name, each));
    }
  }
  const aborted = new AbortController();
  response.on('close', () => aborted.abort());
  const answer = await transport.handleRequest(
    new Request(`http://${request.headers.host}${request.url ?? httpPath}`, {
      method: request.method,
      headers,
      body: body.length > 0 ? body : undefined,
      signal: aborted.signal,
    }),
    json === undefined ? undefined : { parsedBody: json }
  );
  const outgoing: Record<string, string> = {};
  // Node.js frames the body itself.
  answer.headers.forEach((value, name) => {
    if (name !== 'transfer-encoding' && name !== 'content-length') {
      outgoing[name] = value;
    }
  });
  response.writeHead(answer.status, outgoing);
  if (!answer.body) {
    response.end();
    return;
  }
  // Headers first: an event stream may stay quiet for long.
  response.flushHeaders();
  const reader = answer.body.getReader();
  aborted.signal.addEventListener('abort', () => void reader.cancel().catch(() => undefined));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || response.destroyed) {
        break;
      }
      response.write(value);
    }
  } catch {
    // The client went away.
  }
  response.end();
}

/** Serves the tools on http://127.0.0.1:<port>/mcp; resolves with the port, the one given or, for 0, the one chosen. */
export function serveHttp(workspace: Workspace, version: string | undefined, port: number): Promise<{ server: http.Server; port: number }> {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let listening = port;

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    if (!localHost(request.headers.host, listening) || !localOrigin(request.headers.origin)) {
      reply(response, 403, 'Only clients on this machine are served.');
      return;
    }
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== httpPath) {
      reply(response, 404, `Not found: the MCP endpoint is ${httpPath}`);
      return;
    }
    const sessionHeader = request.headers['mcp-session-id'];
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    const body = await bodyOf(request);
    const json = request.method === 'POST' ? parsed(body) : undefined;
    const known = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (known) {
      await forward(known, request, response, body, json);
      return;
    }
    if (sessionId !== undefined) {
      reply(response, 404, 'Unknown session: start a new one.');
      return;
    }
    if (request.method !== 'POST' || !isInitializeRequest(json)) {
      reply(response, 400, 'No session: initialize one first.');
      return;
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
        console.error(`x4-script-mcp: session ${id} opened (${sessions.size} open)`);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined && sessions.delete(transport.sessionId)) {
        console.error(`x4-script-mcp: session ${transport.sessionId} closed (${sessions.size} open)`);
      }
    };
    await createServer(workspace, version).connect(transport);
    await forward(transport, request, response, body, json);
  };

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => reply(response, 500, error instanceof Error ? error.message : String(error)));
  });
  server.on('close', () => {
    for (const transport of sessions.values()) {
      void transport.close();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, httpHost, () => {
      server.off('error', reject);
      const address = server.address();
      listening = typeof address === 'object' && address !== null ? address.port : port;
      resolve({ server, port: listening });
    });
  });
}
