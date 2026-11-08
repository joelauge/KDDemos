// Point your Twilio number at this server:
//   npm run twilio:configure
import twilio from "twilio";
import { config, requireEnv } from "../src/config.js";

requireEnv(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "PUBLIC_BASE_URL"]);

const client = twilio(config.twilio.accountSid, config.twilio.authToken);
const [number] = await client.incomingPhoneNumbers.list({ phoneNumber: config.twilio.phoneNumber, limit: 1 });
if (!number) {
  console.error(`No number ${config.twilio.phoneNumber} on account ${config.twilio.accountSid}.`);
  process.exit(1);
}

await client.incomingPhoneNumbers(number.sid).update({
  voiceUrl: `${config.publicBaseUrl}/voice/incoming`,
  voiceMethod: "POST",
  statusCallback: `${config.publicBaseUrl}/voice/status`,
  statusCallbackMethod: "POST",
});

console.log(`${number.phoneNumber} now sends calls to ${config.publicBaseUrl}/voice/incoming`);
