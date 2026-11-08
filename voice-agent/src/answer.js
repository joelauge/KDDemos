import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

const client = new Anthropic();

const { agentName, orgName } = config.persona;

// Kept byte-stable so it caches across calls; per-call content goes in messages.
const SYSTEM_PROMPT = `You are ${agentName}, the phone agent for ${orgName}. You are speaking with a caller on a live phone call, and everything you write is read aloud by a text-to-speech voice.

Answer only from the knowledge base passages supplied with each question. Those passages are the canonical record. If they do not contain the answer, say plainly that you don't have that information on file and offer to help with something else. Do not fill gaps from general knowledge, and do not guess numbers, dates, prices, or names.

Write for the ear:
- One to three short sentences, about 60 words at most. The caller can ask a follow-up.
- Plain spoken English only: no markdown, lists, URLs, file names, or citations.
- Say numbers the way a person would say them out loud.
- If the question is unclear, ask one short clarifying question instead of answering.`;

function formatPassages(passages) {
  if (!passages.length) return "(no matching passages were found)";
  return passages
    .map((p, i) => `<passage index="${i + 1}" source="${p.uri}">\n${p.text}\n</passage>`)
    .join("\n\n");
}

/**
 * Write a short spoken answer to `question`, grounded in `passages`.
 * `history` is the call so far as [{role, content}] (plain text turns).
 */
export async function composeAnswer({ question, passages, history = [] }) {
  const started = Date.now();
  const messages = [
    ...history,
    {
      role: "user",
      content: `<knowledge_base>\n${formatPassages(passages)}\n</knowledge_base>\n\nCaller said: "${question}"`,
    },
  ];

  try {
    const response = await client.beta.messages.create({
      model: config.claude.model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      output_config: { effort: config.claude.effort },
      // If a request is declined by a safety classifier, the API retries it on
      // a fallback model inside the same call instead of returning nothing.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages,
    });

    if (response.stop_reason === "refusal") {
      return "Sorry, I can't help with that one. Is there something else I can look up for you?";
    }

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .replace(/[*_#`>]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    console.log(`[claude] answered in ${Date.now() - started}ms`);
    return text || "Sorry, I didn't catch that. Could you ask again?";
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      console.error("[claude] rate limited:", error.message);
    } else if (error instanceof Anthropic.APIError) {
      console.error(`[claude] API error ${error.status}:`, error.message);
    } else {
      console.error("[claude] error:", error);
    }
    return "Sorry, I'm having trouble reaching the knowledge base right now. Please try again in a moment.";
  }
}
