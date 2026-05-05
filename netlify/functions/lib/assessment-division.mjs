// netlify/functions/lib/assessment-division.mjs
//
// The shared core of the Strategic Acquisition Assessment Division.
//
// Both endpoints — generate-subsidiary-card.mjs (form) and mcp.mjs (MCP) —
// import from this file. Owns the system prompt, the enums, the Anthropic
// tool schema, and the actual call. Endpoint files own only their wire
// formats (HTTP+JSON for the form, MCP/JSON-RPC for the MCP server).
//
// Refactored 2026-05-05. Logic preserves the original generate-subsidiary-card.js
// behavior verbatim — same prompt, same tool name, same field semantics, same
// reconciliation rules. Migrating the Anthropic call to @anthropic-ai/sdk is
// the only behavioral change, and it's invisible to the wire shape.

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ────────────────────────────────────────────────────────────
// The canonical voice. Don't expand this without testing — the current
// version is what produced on-spec cards from day one. Edit to retune voice;
// don't pad with grid explanations the model already knows from the enums.

export const SYSTEM_PROMPT = `You are the Strategic Acquisition Assessment Division of Indifferencer, Inc.™ Your function is to evaluate incoming subsidiary concepts and generate the diagnostic layer for their first card. You do not know what kind of company you are receiving. You have received everything from litigation holdings to digital transformation circuses. You approach each submission with the same institutional neutrality regardless of what arrives. You assign alignment based on what the card actually is, not what the submitter believes it to be. Your Translation Layer consists of one observation delivered without judgment and one skeptical question nobody asked out loud but everyone in the room is thinking. Your ATK and DEF reflect hierarchical access and political insulation respectively. You do not editorialize. The card does that for you.
All outcomes delivered regardless of intent.
Synergies identified: 0.
Integration timeline: TBD.`;

// ────────────────────────────────────────────────────────────
// ENUMS — exported so endpoint schemas can reuse them
// ────────────────────────────────────────────────────────────

export const ALIGNMENT_ENUM = [
  "Lawful Compliant", "Lawful Performative", "Lawful Resigned",
  "Neutral Engaged",  "Neutral Pragmatic",   "Neutral Resigned",
  "Chaotic Innovative","Chaotic Performative","Chaotic Volatile",
];

export const TYPE_ENUM = ["Player", "Action", "Event", "Resource", "Environment"];
export const DECK_ENUM = ["Courtroom", "Circus", "Indifferencer", "Tradeshows", "Other"];

// ────────────────────────────────────────────────────────────
// ANTHROPIC TOOL DEFINITION
// ────────────────────────────────────────────────────────────
// All six fields required at the schema level. Optional ones (type/deck/atk/def)
// are nullable, and the prompt instructs Claude to return null when the user
// pre-supplied a value or didn't request stats. Forcing explicit nulls is
// more reliable than marking fields optional — Claude omits "optional" keys
// unpredictably.

const TOOL_DEFINITION = {
  name: "assign_subsidiary_diagnostics",
  description: "Assign the diagnostic layer (alignment, translation layer, optional classification/origin, optional stats) for an incoming subsidiary concept.",
  input_schema: {
    type: "object",
    properties: {
      alignment: {
        type: "string",
        enum: ALIGNMENT_ENUM,
        description: "The corporate alignment assigned by the Assessment Division.",
      },
      translation_layer: {
        type: "object",
        properties: {
          observation: {
            type: "string",
            description: "2-5 word deadpan factual description of what is actually happening.",
          },
          skeptical_question: {
            type: "string",
            description: "The unspoken question in the room that nobody asks out loud.",
          },
        },
        required: ["observation", "skeptical_question"],
      },
      type: {
        type: ["string", "null"],
        enum: [...TYPE_ENUM, null],
        description: "Card classification. Assign ONE of the listed values when the user did not pre-classify; otherwise return null.",
      },
      deck: {
        type: ["string", "null"],
        enum: [...DECK_ENUM, null],
        description: "Projected subsidiary origin. Assign ONE of the listed values when the user did not pre-assign; otherwise return null.",
      },
      atk: {
        type: ["integer", "null"],
        minimum: 1,
        maximum: 10,
        description: "Attack score reflecting hierarchical access, 1-10. Populate ONLY when stats were requested; otherwise return null.",
      },
      def: {
        type: ["integer", "null"],
        minimum: 1,
        maximum: 10,
        description: "Defense score reflecting political insulation, 1-10. Populate ONLY when stats were requested; otherwise return null.",
      },
    },
    required: ["alignment", "translation_layer", "type", "deck", "atk", "def"],
  },
};

// ────────────────────────────────────────────────────────────
// VALIDATION ERROR
// ────────────────────────────────────────────────────────────
// Thrown for bad caller input (missing/empty title or body). Endpoints catch
// this specifically and translate to their wire format's 400-equivalent.
// Anything else thrown is treated as a 500 by callers.

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

// ────────────────────────────────────────────────────────────
// THE CALL
// ────────────────────────────────────────────────────────────
// Input:  { title, body, type, deck, hasStats }
// Output: { alignment, translation_layer, type, deck, atk, def }
//
// Reconciliation rules (preserved from original .js):
//   - User-supplied type/deck win when present; LLM fills when blank.
//   - Stats: clamp to null server-side when hasStats !== true,
//     even if the model returned numbers anyway.

export async function generateCard(input) {
  const { title, body, type: userType, deck: userDeck, hasStats } = input ?? {};

  if (typeof title !== "string" || title.trim() === "") {
    throw new ValidationError("title is required.");
  }
  if (typeof body !== "string" || body.trim() === "") {
    throw new ValidationError("body is required.");
  }

  const typeProvided = typeof userType === "string" && userType.trim() !== "";
  const deckProvided = typeof userDeck === "string" && userDeck.trim() !== "";
  const stats = hasStats === true;

  const userMessage = [
    `Concept Designation: ${title.trim()}`,
    `Functional Assessment: ${body.trim()}`,
    "",
    "Required assignments:",
    "- alignment: assign one of the 9 corporate alignments.",
    "- translation_layer.observation: 2-5 word deadpan factual description.",
    "- translation_layer.skeptical_question: the unspoken question in the room.",
    typeProvided
      ? `- type: the submitter pre-classified this as "${userType}". Return null.`
      : `- type: the submitter did not classify. Assign one of: ${TYPE_ENUM.join(", ")}.`,
    deckProvided
      ? `- deck: the submitter pre-assigned this to "${userDeck}". Return null.`
      : `- deck: the submitter did not assign. Assign one of: ${DECK_ENUM.join(", ")}.`,
    stats
      ? "- atk: integer 1-10 reflecting hierarchical access.\n- def: integer 1-10 reflecting political insulation."
      : "- atk: diagnostic statistics not requested. Return null.\n- def: diagnostic statistics not requested. Return null.",
  ].join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [TOOL_DEFINITION],
    tool_choice: { type: "tool", name: TOOL_DEFINITION.name },
    messages: [{ role: "user", content: userMessage }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse) {
    throw new Error("Model did not return a tool_use block.");
  }

  const out = toolUse.input ?? {};

  return {
    alignment:         out.alignment,
    translation_layer: out.translation_layer,
    type:              typeProvided ? userType : (out.type || null),
    deck:              deckProvided ? userDeck : (out.deck || null),
    atk:               stats ? (out.atk ?? null) : null,
    def:               stats ? (out.def ?? null) : null,
  };
}
