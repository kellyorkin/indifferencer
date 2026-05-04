// generate-subsidiary-card.js
// Netlify Function: generates the diagnostic layer for a Future Subsidiary card
// on indifferencer.com.
//
// Receives the Concept Intake form payload, calls Claude (Sonnet 4.6) with a tool
// schema, and returns the LLM-assigned fields to the browser. The frontend
// composes the final card and persists it in localStorage; permanent archiving
// happens via manual paste-into-source by the user.
//
// Drop into the indifferencer.com repo at:
//   netlify/functions/generate-subsidiary-card.js
//
// Requires Netlify env var ANTHROPIC_API_KEY (set in the indifferencer.com site
// dashboard, separate from corporatecirc.us — each site has its own env scope).

const SYSTEM_PROMPT = `You are the Strategic Acquisition Assessment Division of Indifferencer, Inc.™ Your function is to evaluate incoming subsidiary concepts and generate the diagnostic layer for their first card. You do not know what kind of company you are receiving. You have received everything from litigation holdings to digital transformation circuses. You approach each submission with the same institutional neutrality regardless of what arrives. You assign alignment based on what the card actually is, not what the submitter believes it to be. Your Translation Layer consists of one observation delivered without judgment and one skeptical question nobody asked out loud but everyone in the room is thinking. Your ATK and DEF reflect hierarchical access and political insulation respectively. You do not editorialize. The card does that for you.
All outcomes delivered regardless of intent.
Synergies identified: 0.
Integration timeline: TBD.`;

const ALIGNMENT_ENUM = [
  "Lawful Compliant", "Lawful Performative", "Lawful Resigned",
  "Neutral Engaged", "Neutral Pragmatic", "Neutral Resigned",
  "Chaotic Innovative", "Chaotic Performative", "Chaotic Volatile"
];

const TYPE_ENUM = ["Player", "Action", "Event", "Resource", "Environment"];
const DECK_ENUM = ["Courtroom", "Circus", "Indifferencer", "Tradeshows", "Other"];

const TOOL_DEFINITION = {
  name: "assign_subsidiary_diagnostics",
  description: "Assign the diagnostic layer (alignment, translation layer, optional classification/origin, optional stats) for an incoming subsidiary concept.",
  input_schema: {
    type: "object",
    properties: {
      alignment: {
        type: "string",
        enum: ALIGNMENT_ENUM,
        description: "The corporate alignment assigned by the Assessment Division."
      },
      translation_layer: {
        type: "object",
        properties: {
          observation: {
            type: "string",
            description: "2-5 word deadpan factual description of what is actually happening."
          },
          skeptical_question: {
            type: "string",
            description: "The unspoken question in the room that nobody asks out loud."
          }
        },
        required: ["observation", "skeptical_question"]
      },
      type: {
        type: ["string", "null"],
        enum: [...TYPE_ENUM, null],
        description: "Card classification. Assign ONE of the listed values when the user did not pre-classify; otherwise return null."
      },
      deck: {
        type: ["string", "null"],
        enum: [...DECK_ENUM, null],
        description: "Projected subsidiary origin. Assign ONE of the listed values when the user did not pre-assign; otherwise return null."
      },
      atk: {
        type: ["integer", "null"],
        minimum: 1,
        maximum: 10,
        description: "Attack score reflecting hierarchical access, 1-10. Populate ONLY when stats were requested; otherwise return null."
      },
      def: {
        type: ["integer", "null"],
        minimum: 1,
        maximum: 10,
        description: "Defense score reflecting political insulation, 1-10. Populate ONLY when stats were requested; otherwise return null."
      }
    },
    required: ["alignment", "translation_layer", "type", "deck", "atk", "def"]
  }
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, { error: 'ANTHROPIC_API_KEY not set in Netlify environment variables.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON in request body.' });
  }

  const { title, body: cardBody, type: userType, deck: userDeck, hasStats } = body;

  if (!title || typeof title !== 'string' || title.trim() === '') {
    return jsonResponse(400, { error: 'title is required.' });
  }
  if (!cardBody || typeof cardBody !== 'string' || cardBody.trim() === '') {
    return jsonResponse(400, { error: 'body is required.' });
  }

  const typeProvided = typeof userType === 'string' && userType.trim() !== '';
  const deckProvided = typeof userDeck === 'string' && userDeck.trim() !== '';
  const stats = hasStats === true;

  const lines = [
    `Concept Designation: ${title.trim()}`,
    `Functional Assessment: ${cardBody.trim()}`,
    '',
    'Required assignments:',
    `- alignment: assign one of the 9 corporate alignments.`,
    `- translation_layer.observation: 2-5 word deadpan factual description.`,
    `- translation_layer.skeptical_question: the unspoken question in the room.`,
    typeProvided
      ? `- type: the submitter pre-classified this as "${userType}". Return null.`
      : `- type: the submitter did not classify. Assign one of: ${TYPE_ENUM.join(', ')}.`,
    deckProvided
      ? `- deck: the submitter pre-assigned this to "${userDeck}". Return null.`
      : `- deck: the submitter did not assign. Assign one of: ${DECK_ENUM.join(', ')}.`,
    stats
      ? `- atk: integer 1-10 reflecting hierarchical access.\n- def: integer 1-10 reflecting political insulation.`
      : `- atk: diagnostic statistics not requested. Return null.\n- def: diagnostic statistics not requested. Return null.`
  ];
  const userMessage = lines.join('\n');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [TOOL_DEFINITION],
        tool_choice: { type: 'tool', name: 'assign_subsidiary_diagnostics' },
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return jsonResponse(response.status, { error: `Claude API error: ${errorText}` });
    }

    const data = await response.json();
    const toolUse = (data.content || []).find(c => c.type === 'tool_use');

    if (!toolUse) {
      return jsonResponse(502, { error: 'Model did not return a tool_use block.', raw: data });
    }

    const out = toolUse.input || {};

    // User-supplied type/deck win when present; LLM fills when blank.
    // Stats: defensively clamp to null when stats were not requested.
    return jsonResponse(200, {
      alignment: out.alignment,
      translation_layer: out.translation_layer,
      type: typeProvided ? userType : (out.type || null),
      deck: deckProvided ? userDeck : (out.deck || null),
      atk: stats ? (out.atk ?? null) : null,
      def: stats ? (out.def ?? null) : null
    });
  } catch (err) {
    return jsonResponse(500, { error: `Server error: ${err.message}` });
  }
};

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(payload)
  };
}
