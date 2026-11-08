import { randomUUID } from "node:crypto";

const MAX_HISTORY_TURNS = 6; // user+assistant pairs kept per call
const TURN_TTL_MS = 5 * 60 * 1000;

/** Per-call conversation history, keyed by Twilio CallSid. */
const calls = new Map();

/** Pending answers, keyed by an unguessable turn id used in the <Play> URL. */
const turns = new Map();

export function getHistory(callSid) {
  return calls.get(callSid)?.history ?? [];
}

export function getLastQuestion(callSid) {
  return calls.get(callSid)?.lastQuestion ?? "";
}

export function recordExchange(callSid, question, answer) {
  const call = calls.get(callSid) ?? { history: [], lastQuestion: "" };
  call.history.push({ role: "user", content: question }, { role: "assistant", content: answer });
  call.history = call.history.slice(-MAX_HISTORY_TURNS * 2);
  call.lastQuestion = question;
  calls.set(callSid, call);
}

export function endCall(callSid) {
  calls.delete(callSid);
}

/** Register a pending answer (a Promise<string>) and return its id. */
export function createTurn(answerPromise) {
  const id = randomUUID();
  turns.set(id, { answerPromise, createdAt: Date.now() });
  return id;
}

export function takeTurn(id) {
  const turn = turns.get(id);
  return turn?.answerPromise;
}

// Drop stale turns so memory stays flat on a long-running demo server.
setInterval(() => {
  const cutoff = Date.now() - TURN_TTL_MS;
  for (const [id, turn] of turns) if (turn.createdAt < cutoff) turns.delete(id);
}, 60 * 1000).unref();
