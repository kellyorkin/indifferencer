// netlify/functions/mcp.mjs
//
// MCP (Model Context Protocol) server endpoint exposing the Subsidiary Card
// Generator as a tool callable by any MCP-aware client (Cowork, Claude Code,
// Claude Desktop, anything that speaks MCP).
//
// All card-generation logic lives in lib/assessment-division.mjs. This file
// owns only the MCP plumbing: bearer-token auth, the Web↔Node transport
// bridge, MCP server registration, and the JSON-RPC error wire format.
//
// Install URL once deployed:
//   https://indifferencer.com/.netlify/functions/mcp
//
// Clients add that URL to their MCP config along with the bearer token
// stored in Netlify's MCP_AUTH_TOKEN env var.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { toReqRes, toFetchResponse } from "fetch-to-node";

import {
  generateCard,
  TYPE_ENUM,
  DECK_ENUM,
} from "./lib/assessment-division.mjs";

// ────────────────────────────────────────────────────────────
// CONFIG
// ────────────────────────────────────────────────────────────
// Shared-secret bearer token. Set MCP_AUTH_TOKEN in Netlify env vars.
// Fails closed if unset — better to break loudly than to silently serve
// as an open Anthropic-bill amplifier.

const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

// ────────────────────────────────────────────────────────────
// MCP SERVER FACTORY
// ────────────────────────────────────────────────────────────
// Built per-request because the transport holds per-request response state
// internally. Sharing one transport across concurrent invocations on a warm
// container would cross response streams.

function getServer() {
  const server = new Server(
    {
      name: "subsidiary-card-generator",
      version: "0.2.0",
    },
    {
      capabilities: { tools: {} },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "generate_subsidiary_card",
        description:
          "Submit a concept to the Indifferencer, Inc.™ Strategic Acquisition Assessment Division. Returns alignment, translation layer, and optionally ATK/DEF stats.",
        inputSchema: {
          type: "object",
          required: ["title", "body"],
          properties: {
            title: {
              type: "string",
              description: "Concept Designation — the card title",
            },
            body: {
              type: "string",
              description: "Functional Assessment — what the card does",
            },
            type: {
              type: "string",
              enum: TYPE_ENUM,
              description: "Classification (omit to let the Assessment Division assign)",
            },
            deck: {
              type: "string",
              enum: DECK_ENUM,
              description: "Projected Subsidiary Origin (omit to let the Assessment Division assign)",
            },
            hasStats: {
              type: "boolean",
              description: "If true, generate ATK and DEF integer values 1-10",
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name !== "generate_subsidiary_card") {
      throw new Error(`Unknown tool: ${name}`);
    }

    const card = await generateCard(args);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(card, null, 2),
        },
      ],
    };
  });

  return server;
}

// ────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────

function jsonRpcError(status, code, message) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    {
      status,
      headers: { "content-type": "application/json" },
    }
  );
}

function isAuthorized(req) {
  if (!MCP_AUTH_TOKEN) return false;
  const header = req.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return false;
  return header.slice(7) === MCP_AUTH_TOKEN;
}

// ────────────────────────────────────────────────────────────
// NETLIFY FUNCTION HANDLER
// ────────────────────────────────────────────────────────────

export default async (req) => {
  if (req.method !== "POST") {
    return jsonRpcError(405, -32000, "Method not allowed.");
  }

  if (!isAuthorized(req)) {
    return jsonRpcError(401, -32001, "Unauthorized.");
  }

  let body;
  try {
    body = await req.clone().json();
  } catch {
    return jsonRpcError(400, -32700, "Parse error: body must be JSON.");
  }

  const { req: nodeReq, res: nodeRes } = toReqRes(req);
  const server = getServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(nodeReq, nodeRes, body);

    nodeRes.on("close", () => {
      transport.close();
      server.close();
    });

    return toFetchResponse(nodeRes);
  } catch (err) {
    console.error("MCP handler error:", err);
    return jsonRpcError(500, -32603, "Internal server error.");
  }
};
