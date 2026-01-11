import { NextRequest } from "next/server";
import twilio from "twilio";
import { generateTTS } from "@/lib/tts";

export async function POST(_req: NextRequest) {
  const twiml = new twilio.twiml.VoiceResponse();

  const intro = await generateTTS(
    "Hi—thanks for calling. I’m the intake assistant for the firm. I can’t give legal advice, but I can get a few details and help you schedule.",
    "intro.mp3"
  );

  if (intro) twiml.play(intro);
  else twiml.say({ voice: "Polly.Joanna", language: "en-US" }, "Hi—thanks for calling. I’m the intake assistant for the firm.");

  const gather = twiml.gather({
    input: ["speech"],
    speechTimeout: 2,
    timeout: 4,
    action: "/api/voice/intent",
    method: "POST",
  });

  const q1 = await generateTTS("What’s going on today? Just a short summary.", "q1.mp3");
  if (q1) (gather as any).play(q1);
  else (gather as any).say({ voice: "Polly.Joanna", language: "en-US" }, "What’s going on today? Just a short summary.");

  // Only runs if they don't respond
  twiml.hangup();

  return new Response(twiml.toString(), { headers: { "Content-Type": "text/xml" } });
}
