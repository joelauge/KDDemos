// Have the agent call a phone (handy for live demos):
//   npm run call -- +15551234567
import twilio from "twilio";
import { config, requireEnv } from "../src/config.js";

requireEnv(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "PUBLIC_BASE_URL"]);

const to = process.argv[2];
if (!/^\+\d{8,15}$/.test(to || "")) {
  console.error("Usage: npm run call -- +15551234567   (E.164 format)");
  process.exit(1);
}

const client = twilio(config.twilio.accountSid, config.twilio.authToken);
const call = await client.calls.create({
  to,
  from: config.twilio.phoneNumber,
  url: `${config.publicBaseUrl}/voice/incoming`,
  method: "POST",
  statusCallback: `${config.publicBaseUrl}/voice/status`,
  statusCallbackMethod: "POST",
  statusCallbackEvent: ["completed"],
});

console.log(`Calling ${to} — call ${call.sid}`);
