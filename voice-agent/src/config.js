import "dotenv/config";

const env = process.env;

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
}

export const config = {
  port: Number(env.PORT || 3000),
  publicBaseUrl: (env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""),

  knowdrive: {
    baseUrl: (env.KNOWDRIVE_BASE_URL || "https://knowdrive.ai").replace(/\/+$/, ""),
    // KNOWDRIVE_API_KEY is accepted too, the name a developer key is often stored under.
    apiToken: env.KNOWDRIVE_API_TOKEN || env.KNOWDRIVE_API_KEY || "",
    vectorStoreId: env.KNOWDRIVE_VECTOR_STORE_ID || "",
    tagQuery: env.KNOWDRIVE_TAG_QUERY || "",
    topK: Number(env.KNOWDRIVE_TOP_K || 6),
  },

  claude: {
    model: env.CLAUDE_MODEL || "claude-opus-5-5",
    effort: env.CLAUDE_EFFORT || "low",
  },

  // "gemini": voice-to-voice through Gemini Live over Twilio Media Streams.
  // "classic": Twilio speech recognition -> KnowDrive -> Claude -> ElevenLabs.
  voiceEngine: (env.VOICE_ENGINE || "classic").toLowerCase(),

  gemini: {
    apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "",
    model: env.GEMINI_LIVE_MODEL || "gemini-3.8-live",
    voice: env.GEMINI_VOICE || "Kore",
  },

  // Texted product links (voice-to-voice engine). Links are Shopify cart
  // permalinks that add the item and open checkout, tagged for attribution.
  shop: {
    domain: (env.SHOP_DOMAIN || "").replace(/\/+$/, ""),
    utmSource: env.LINK_UTM_SOURCE || "ai-assistant",
    utmMedium: env.LINK_UTM_MEDIUM || "sms",
    utmCampaign: env.LINK_UTM_CAMPAIGN || "voice-agent",
    ref: env.LINK_REF || "ai-voice-agent",
  },

  elevenlabs: {
    apiKey: env.ELEVENLABS_API_KEY || "",
    voiceId: env.ELEVENLABS_VOICE_ID || "",
    modelId: env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5",
    outputFormat: env.ELEVENLABS_OUTPUT_FORMAT || "mp3_22050_32",
  },

  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID || "",
    authToken: env.TWILIO_AUTH_TOKEN || "",
    phoneNumber: env.TWILIO_PHONE_NUMBER || "",
    validateSignature: bool(env.TWILIO_VALIDATE_SIGNATURE, true),
    speechModel: env.TWILIO_SPEECH_MODEL || "phone_call",
    language: env.TWILIO_LANGUAGE || "en-US",
  },

  persona: {
    agentName: env.AGENT_NAME || "Kay",
    orgName: env.ORG_NAME || "KnowDrive",
    greeting:
      env.GREETING ||
      "Hi, this is Kay from KnowDrive. I answer straight from our knowledge base. What would you like to know?",
  },
};

/** Throws a readable error naming every missing variable in `names`. */
export function requireEnv(names) {
  const missing = names.filter((n) => !env[n]);
  if (!env.KNOWDRIVE_API_TOKEN && !env.KNOWDRIVE_API_KEY) missing.unshift("KNOWDRIVE_API_TOKEN (or KNOWDRIVE_API_KEY)");
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")} (see .env.example)`);
  }
}
