// netlify/functions/generate-subsidiary-card.mjs
//
// Form endpoint for the Concept Intake form on subsidiaries.html.
// Receives { title, body, type, deck, hasStats } and returns the diagnostic
// layer { alignment, translation_layer, type, deck, atk, def }.
//
// Card-generation logic lives in lib/assessment-division.mjs; this file owns
// only the HTTP wire format and CORS.
//
// Migrated from CommonJS (.js, Netlify Functions v1, exports.handler with
// event/context) to ESM (.mjs, Netlify Functions v2, default export with Web
// Request/Response) on 2026-05-05 to share code with mcp.mjs. Wire shape and
// route unchanged — the frontend's POST URL still works without modification.

import { generateCard, ValidationError } from "./lib/assessment-division.mjs";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return jsonResponse(500, {
      error: "ANTHROPIC_API_KEY not set in Netlify environment variables.",
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON in request body." });
  }

  try {
    const card = await generateCard(body);
    return jsonResponse(200, card);
  } catch (err) {
    if (err instanceof ValidationError) {
      return jsonResponse(400, { error: err.message });
    }
    console.error("Card generation error:", err);
    return jsonResponse(500, { error: `Server error: ${err.message}` });
  }
};
