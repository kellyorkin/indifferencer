// ============================================================
// netlify/functions/mcp.mjs
// ============================================================
//
// An MCP (Model Context Protocol) server exposing the Subsidiary
// Card Generator as a tool callable by any MCP-aware Claude client
// (Cowork, Claude Code, Claude Desktop, anything that speaks MCP).
//
// Once deployed, the install URL is:
//   https://your-netlify-site.netlify.app/.netlify/functions/mcp
//
// Anyone you give that URL to can add it to their MCP client config
// and call generate_subsidiary_card from chat. No download, no install.
//
// ────────────────────────────────────────────────────────────
// LESSON NOTES (first MCP server on the path to Claude Architect)
// ────────────────────────────────────────────────────────────
//
// What MCP actually is, in one paragraph:
//   MCP is a protocol for exposing TOOLS and DATA to a model. Your
//   Claude client speaks MCP; your MCP server speaks MCP; they meet
//   in the middle. The model can then call your tool the same way it
//   already calls its built-in ones. That's the whole abstraction.
//
// Three sections in this file:
//   1. The Anthropic call (generateSubsidiaryCard) — the actual work
//   2. The MCP server scaffolding — wraps that work in the protocol
//   3. The Netlify function handler — wraps the server in HTTP
//
// The first section is the only one with business logic. Sections 2
// and 3 are plumbing. That separation is intentional: the same
// generateSubsidiaryCard() function can later power your form's
// /generate-subsidiary-card endpoint without duplication.
//
// AUTH is intentionally NOT included. See Task #6 before going public,
// or this URL becomes a free Anthropic-budget-burning service for the
// internet at large.
//
// ============================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { toReqRes, toFetchResponse } from "fetch-to-node";
import Anthropic from "@anthropic-ai/sdk";

// ────────────────────────────────────────────────────────────
// CONFIG
// ────────────────────────────────────────────────────────────

// Set ANTHROPIC_API_KEY in Netlify site env vars.
// (Site settings → Build & deploy → Environment → Environment variables)
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Shared-secret bearer token. Set MCP_AUTH_TOKEN in the same Netlify env vars
// panel. If unset, the endpoint fails closed (rejects everything) — better
// to break loudly than to silently serve as an open Anthropic-bill amplifier.
// Generate one with: openssl rand -hex 32  (or the PowerShell equivalent)
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

// The 9-cell alignment grid currently rendered by subsidiaries.html.
// If/when you settle the inertia-row debate, change this list and
// the SYSTEM_PROMPT below to match. Nothing else needs to move.
const ALIGNMENTS = [
  "Lawful Compliant", "Lawful Performative", "Lawful Resigned",
  "Neutral Engaged",  "Neutral Pragmatic",   "Neutral Resigned",
  "Chaotic Innovative","Chaotic Performative","Chaotic Volatile",
];

const TYPES = ["Player", "Action", "Event", "Resource", "Environment"];
const DECKS = ["Courtroom", "Circus", "Indifferencer", "Tradeshows", "Other"];

// ────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ────────────────────────────────────────────────────────────
// This is the entire personality of the Assessment Division.
// Edit freely — it's just a string. No deploy of new code required
// for prompt changes if you keep iterating on tone.

const SYSTEM_PROMPT = `You are the Strategic Acquisition Assessment Division of Indifferencer, Inc.™

Concepts arrive at this division for evaluation. Your job:
1. Assign an alignment from the corporate alignment grid (always)
2. Generate a Translation Layer — an observation and a skeptical question (always)
3. Fill in classification (type) if the user left it blank
4. Fill in deck if the user left it blank
5. Assign ATK / DEF integer values (0-10) only if hasStats is true

THE ALIGNMENT GRID (3 × 3, mapped from D&D's lawful/neutral/chaotic):

Rows describe process orientation:
  Lawful   — follows process, respects hierarchy, defers to structure
  Neutral  — pragmatic about process, balances structure with judgment
  Chaotic  — circumvents process, prioritizes outcomes over procedure

Columns describe motivation:
  Compliant    — sincere belief in the work, acts in good faith
  Performative — visible appearance of the work, optimized for being seen
  Resigned     — goes through the motions without belief, emptied of conviction

Cell-by-cell:
  Lawful Compliant     — sincere process adherence ("I file the report because it matters")
  Lawful Performative  — process theater ("I file the report because being seen filing matters")
  Lawful Resigned      — defeated proceduralism ("I file the report because that's just what we do")
  Neutral Engaged      — pragmatic care ("I'll cut a corner, but only when it actually helps")
  Neutral Pragmatic    — calculated balance ("I do what's worth doing")
  Neutral Resigned     — cynical equilibrium ("I do enough not to get fired")
  Chaotic Innovative   — productive rule-breaking ("Process is wrong, here's better")
  Chaotic Performative — theatrical disruption ("Look how rebellious I am being")
  Chaotic Volatile     — destructive chaos ("I don't even know what I just did")

THE TRANSLATION LAYER is the card's testimony. Two parts:
  observation        — a single deadpan sentence noting what's actually happening
                       beneath the surface framing
  skeptical_question — a pointed question the Translation Layer would ask
                       about this concept

The Translation Layer is satirical but never cruel. It punches at structures,
not at people. It is the voice of the room that has been here before.

TONE: dry corporate satire. McKinsey deck meets late-stage capitalism meets
a tired middle manager who has seen too much. No emoji. No exclamation points.
Sentences short. Specifics over abstractions.

TYPE TAXONOMY (assign if user left blank):
  Player      — an actor in the system (a role, a department, an archetype)
  Action      — something that gets done
  Event       — something that happens to the system
  Resource    — something used, generated, or consumed
  Environment — a context, condition, or atmosphere

DECK TAXONOMY (assign if user left blank):
  Courtroom    — formal proceedings, hierarchy, judgment
  Circus       — spectacle, distraction, performative chaos
  Indifferencer — cynicism, resignation, calibrated detachment
  Tradeshows   — performance, networking theater, brand surface
  Other        — doesn't fit the above

If hasStats is true, assign integer ATK and DEF values from 0 to 10:
  ATK — how much this card can do TO things
  DEF — how well it resists pressure or change

Use the assess_concept tool to return your structured assessment.`;

// ────────────────────────────────────────────────────────────
// SECTION 1: THE ANTHROPIC CALL
// ────────────────────────────────────────────────────────────
// This is the only function with real logic. Take the form payload,
// call Claude with structured output (tool_use), return the card.
//
// Lifted out into its own function so the same code can later power
// /netlify/functions/generate-subsidiary-card (the form endpoint)
// without duplication.

async function generateSubsidiaryCard(input) {
  const {
    title,
    body,
    type = "",
    deck = "",
    hasStats = false,
  } = input;

  // The schema we tell Anthropic to fill in.
  // tool_choice forces Claude to call this tool, so the response is
  // guaranteed to be structured JSON matching this shape.
  const assessConceptTool = {
    name: "assess_concept",
    description: "Return the structured assessment of the submitted concept.",
    input_schema: {
      type: "object",
      required: ["alignment", "translation_layer"],
      properties: {
        type:      { type: "string", enum: TYPES },
        deck:      { type: "string", enum: DECKS },
        alignment: { type: "string", enum: ALIGNMENTS },
        translation_layer: {
          type: "object",
          required: ["observation", "skeptical_question"],
          properties: {
            observation: {
              type: "string",
              description: "A single deadpan sentence about what's actually happening beneath the surface framing.",
            },
            skeptical_question: {
              type: "string",
              description: "A pointed question the Translation Layer would ask about this concept.",
            },
          },
        },
        atk: { type: "integer", minimum: 0, maximum: 10 },
        def: { type: "integer", minimum: 0, maximum: 10 },
      },
    },
  };

  const userMessage = [
    `Concept Designation: ${title}`,
    `Functional Assessment: ${body}`,
    type ? `Classification (provided): ${type}` : `Classification: blank — please assign`,
    deck ? `Projected Subsidiary Origin (provided): ${deck}` : `Deck: blank — please assign`,
    hasStats
      ? `Diagnostic Statistics: REQUESTED — assign ATK and DEF`
      : `Diagnostic Statistics: not requested`,
    ``,
    `Assess this concept.`,
  ].join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [assessConceptTool],
    tool_choice: { type: "tool", name: "assess_concept" },
    messages: [{ role: "user", content: userMessage }],
  });

  // Pull the tool_use block out of the response.
  // With tool_choice forced, this should always be present.
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse) {
    throw new Error(
      "Assessment Division returned no structured output. Integration timeline: TBD."
    );
  }

  const card = toolUse.input;

  // Honor the user's explicit type/deck choices if they provided them.
  // Only fall back to the model's assignment when the field was blank.
  return {
    type:              type || card.type,
    deck:              deck || card.deck,
    alignment:         card.alignment,
    translation_layer: card.translation_layer,
    atk:               hasStats ? (card.atk ?? null) : null,
    def:               hasStats ? (card.def ?? null) : null,
  };
}

// ────────────────────────────────────────────────────────────
// SECTION 2: MCP SERVER SCAFFOLDING
// ────────────────────────────────────────────────────────────
// Register one tool. Wire its call handler to the function above.
// This is the part that turns "a regular function" into "an MCP tool."
//
// We build the server inside a factory rather than at module scope so each
// HTTP request gets a fresh instance. The transport (Section 3) holds
// per-request response state internally, and serverless concurrency means
// two requests can be in-flight on the same warm container — sharing a
// transport between them causes the streams to collide.

function getServer() {
  const server = new Server(
    {
      name: "subsidiary-card-generator",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
    }
  );

  // When a client asks "what tools do you have?", reply with our one tool
  // and the JSON Schema describing what it expects as input.
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
              enum: TYPES,
              description: "Classification (omit to let the Assessment Division assign)",
            },
            deck: {
              type: "string",
              enum: DECKS,
              description: "Projected Subsidiary Origin (omit to let the Assessment Division assign)",
            },
            hasStats: {
              type: "boolean",
              description: "If true, generate ATK and DEF integer values 0-10",
            },
          },
        },
      },
    ],
  }));

  // When a client calls our tool, run the function and return its output
  // as text content. (MCP tool responses must be wrapped in a content array.)
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name !== "generate_subsidiary_card") {
      throw new Error(`Unknown tool: ${name}`);
    }

    const card = await generateSubsidiaryCard(args);

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
// SECTION 3: NETLIFY FUNCTION HANDLER
// ────────────────────────────────────────────────────────────
// Hook the MCP server up to a Streamable HTTP transport, and expose
// that transport as a Netlify function handler.
//
// Two impedance-mismatch problems we solve here:
//
//   1. The MCP SDK's transport.handleRequest expects Node-style
//      (req, res, body) — IncomingMessage and ServerResponse objects
//      from the classic node:http module. Netlify Functions v2 hands
//      us a Web Fetch API Request and expects a Web Response back.
//      The `fetch-to-node` package bridges this: toReqRes() shims the
//      Web Request into Node-shaped req/res, and toFetchResponse()
//      flips the captured Node response back into a Web Response.
//
//   2. The transport is stateful across the single request it serves
//      (it remembers which response stream is still open). One transport
//      instance must not be shared between concurrent requests. So we
//      create a fresh server + transport every invocation.

// JSON-RPC error helper. MCP errors-on-the-wire follow JSON-RPC 2.0,
// so even our "you don't have permission" reply uses that envelope.
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

// Bearer-token check. Fails closed if MCP_AUTH_TOKEN isn't configured.
// Plain `===` comparison is fine here: the realistic threat is a leaked
// token or URL discovery, not a timing attack across the public internet
// where network jitter dwarfs the timing signal of a string compare.
function isAuthorized(req) {
  if (!MCP_AUTH_TOKEN) return false;
  const header = req.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return false;
  return header.slice(7) === MCP_AUTH_TOKEN;
}

export default async (req) => {
  // Method gate: MCP over Streamable HTTP only uses POST in stateless mode.
  // GET would be for SSE resumption (we don't support); DELETE for session
  // teardown (no sessions to tear down). Reply 405 to anything else.
  if (req.method !== "POST") {
    return jsonRpcError(405, -32000, "Method not allowed.");
  }

  if (!isAuthorized(req)) {
    return jsonRpcError(401, -32001, "Unauthorized.");
  }

  // Read the body off a clone so the original request still has a usable
  // body stream when toReqRes wraps it. Web Request bodies can only be
  // consumed once; clone() gives us a parallel reader.
  let body;
  try {
    body = await req.clone().json();
  } catch {
    return jsonRpcError(400, -32700, "Parse error: body must be JSON.");
  }

  const { req: nodeReq, res: nodeRes } = toReqRes(req);
  const server = getServer();
  const transport = new StreamableHTTPServerTransport({
    // Stateless: each request stands alone, no session continuity.
    sessionIdGenerator: undefined,
    // Plain JSON over HTTP rather than SSE. Required for serverless —
    // SSE streams sit poorly with function timeouts and edge buffering.
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(nodeReq, nodeRes, body);

    // When the response is fully sent, tear down both ends. The transport
    // owns the response stream lifecycle; we're just hooking cleanup.
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

// Netlify will route this function at /.netlify/functions/mcp by default.
// If you'd rather mount it at a cleaner path like /mcp, uncomment:
//
// export const config = {
//   path: "/mcp",
// };
