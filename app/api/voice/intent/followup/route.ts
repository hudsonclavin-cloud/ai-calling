import { NextRequest } from "next/server";
import twilio from "twilio";
import { generateTTS } from "@/lib/tts";

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const answer = (formData.get("SpeechResult") as string) || "";
  console.log("FOLLOWUP ANSWER:", answer);

  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const a1 = await generateTTS("Perfect. Thank you.", "thanks.mp3");
    if (a1) twiml.play(a1);
    else twiml.say({ voice: "Polly.Joanna", language: "en-US" }, "Perfect. Thank you.");

    const a2 = await generateTTS("We’ll reach out shortly to schedule your consultation.", "nextstep.mp3");
    if (a2) twiml.play(a2);
    else twiml.say({ voice: "Polly.Joanna", language: "en-US" }, "We’ll reach out shortly to schedule your consultation.");

    twiml.hangup();
  } catch (e: any) {
    console.error("followup route failed:", e?.message || e);
    twiml.say({ voice: "Polly.Joanna", language: "en-US" }, "Perfect. Thank you. We’ll reach out shortly to schedule.");
    twiml.hangup();
  }

  return new Response(twiml.toString(), { headers: { "Content-Type": "text/xml" } });
}
