#!/usr/bin/env node
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { log } from "./utils/helpers.js";
import { version } from "./utils/version.js";
import { ACCOUNT_HANDLERS, ACCOUNT_TOOLS } from "./tools/account/index.js";
import {
  SUBSCRIPTIONS_ESSENTIALS_HANDLERS,
  SUBSCRIPTIONS_ESSENTIALS_TOOLS,
} from "./tools/subscriptions/essentials/index.js";
import { TASKS_HANDLERS, TASKS_TOOLS } from "./tools/tasks/index.js";
import {
  SUBSCRIPTIONS_PRO_HANDLERS,
  SUBSCRIPTIONS_PRO_TOOLS,
} from "./tools/subscriptions/pro/index.js";
import {
  DATABASES_PRO_HANDLERS,
  DATABASES_PRO_TOOLS,
} from "./tools/databases/pro/index.js";
import {
  DATABASES_ESSENTIALS_HANDLERS,
  DATABASES_ESSENTIALS_TOOLS,
} from "./tools/databases/essentials/index.js";

process.on("uncaughtException", (error) => {
  log("Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  log("Unhandled rejection:", error);
  process.exit(1);
});

const ALL_TOOLS = [
  ...ACCOUNT_TOOLS,
  ...SUBSCRIPTIONS_PRO_TOOLS,
  ...SUBSCRIPTIONS_ESSENTIALS_TOOLS,
  ...TASKS_TOOLS,
  ...DATABASES_PRO_TOOLS,
  ...DATABASES_ESSENTIALS_TOOLS,
];

const ALL_HANDLERS = {
  ...ACCOUNT_HANDLERS,
  ...SUBSCRIPTIONS_ESSENTIALS_HANDLERS,
  ...SUBSCRIPTIONS_PRO_HANDLERS,
  ...TASKS_HANDLERS,
  ...DATABASES_PRO_HANDLERS,
  ...DATABASES_ESSENTIALS_HANDLERS,
};

function createMcpServer() {
  const server = new Server(
    { name: "mcp-redis-cloud", version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    log("Received list tools request");
    return { tools: ALL_TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    log("Received tool call:", toolName);

    try {
      const handler = ALL_HANDLERS[toolName];
      if (!handler) {
        throw new Error(`Unknown tool: ${toolName}`);
      }
      return await handler(request);
    } catch (error) {
      log("Error handling tool call:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

async function startHttpTransport() {
  const PORT = parseInt(process.env.PORT || "3000", 10);
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || "", `http://localhost:${PORT}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session && req.method === "POST") {
        log("New Streamable HTTP session");
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        const server = createMcpServer();
        await server.connect(transport);

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            sessions.delete(sid);
            log(`Session ${sid} closed`);
          }
        };

        await transport.handleRequest(req, res);

        const sid = transport.sessionId;
        if (sid) {
          sessions.set(sid, { transport, server });
        }
        return;
      }

      if (session) {
        await session.transport.handleRequest(req, res);
        return;
      }

      res.writeHead(400).end("Invalid or missing session");
    } else if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(404).end("Not found");
    }
  });

  httpServer.listen(PORT, () => {
    log(`Streamable HTTP transport listening on port ${PORT}`);
  });
}

async function startStdioTransport() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  log("Created transport");
  await server.connect(transport);
  log("Server connected and running");
}

export async function main() {
  const transportType = process.env.TRANSPORT || "stdio";
  log(`Starting server with ${transportType} transport...`);

  try {
    if (transportType === "http") {
      await startHttpTransport();
    } else {
      await startStdioTransport();
    }
  } catch (error) {
    log("Fatal error:", error);
    process.exit(1);
  }
}

await main();
