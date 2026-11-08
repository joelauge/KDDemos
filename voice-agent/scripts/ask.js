// Test the brain without a phone:
//   npm run ask -- "What does KnowDrive do?"
//   npm run ask -- --say "What does KnowDrive do?"   (also writes answer.mp3 via ElevenLabs)
import { writeFile } from "node:fs/promises";
import { config, requireEnv } from "../src/config.js";
import { searchKnowDrive } from "../src/knowdrive.js";
import { composeAnswer } from "../src/answer.js";
import { synthesize } from "../src/tts.js";

const args = process.argv.slice(2);
const say = args.includes("--say");
const question = args.filter((a) => a !== "--say").join(" ").trim();

if (!question) {
  console.error('Usage: npm run ask -- [--say] "your question"');
  process.exit(1);
}

requireEnv(["KNOWDRIVE_VECTOR_STORE_ID", ...(say ? ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"] : [])]);

const passages = await searchKnowDrive(question);
console.log(`\nSources from store ${config.knowdrive.vectorStoreId}:`);
for (const p of passages) console.log(`  • ${p.uri}  (score ${p.score.toFixed(4)})`);

const answer = await composeAnswer({ question, passages });
console.log(`\nSpoken answer:\n  ${answer}\n`);

if (say) {
  const audio = await synthesize(answer);
  await writeFile("answer.mp3", audio);
  console.log(`Wrote answer.mp3 (${audio.length} bytes)`);
}
