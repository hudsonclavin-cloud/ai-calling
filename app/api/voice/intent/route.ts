import { NextRequest } from "next/server";
import twilio from "twilio";
import OpenAI from "openai";
import { generateTTS } from "@/lib/tts";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const transcript = (formData.get("SpeechResult") as string) || "";

  const twiml = new twilio.twiml.VoiceResponse();

  try {
    if (!transcript.trim()) {
      const g = twiml.gather({
        input: ["speech"],
        speechTimeout: 2,
        timeout: 4,
        action: "/api/voice/intent",
        method: "POST",
      });

      const retry = await generateTTS("Sorry—I didn’t catch that. Can you say it again?", "retry.mp3");
      if (retry) (g as any).play(retry);
      else (g as any).say({ voice: "Polly.Joanna", language: "en-US" }, "Sorry—I didn’t catch that. Can you say it again?");

      twiml.hangup();
      return new Response(twiml.toString(), { headers: { "Content-Type": "text/xml" } });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 120,
      messages: [
        {
          role: "system",
          content:
            "You are a warm, calm law-firm intake assistant. Ask ONE short follow-up question. " +
            "Sound like a real person (simple wording, contractions). No legal advice.",
        },
        { role: "user", content: transcript },
      ],
    });

    const followUp =
      completion.choices[0].message.content?.trim() ||
      "Got it. Quick question—can you tell me a little more about that?";

    const gather = twiml.gather({
      input: ["speech"],
      speechTimeout: 2,
      timeout: 6,
      action: "/api/voice/intent/followup",
      method: "POST",
    });

    const qAudio = await generateTTS(followUp);
    if (qAudio) (gather as any).play(qAudio);
    else (gather as any).say({ voice: "Polly.Joanna", language: "en-US" }, followUp);

    // If they don’t answer:
    const noAnswer = await generateTTS("No worries. We’ll follow up shortly. Take care.", "noanswer.mp3");
    if (noAnswer) twiml.play(noAnswer);
    else twiml.say({ voice: "Polly.Joanna", language: "en-US" }, "No worries. We’ll follow up shortly. Take care.");
    twiml.hangup();
  } catch (e: any) {
    console.error("intent route failed:", e?.message || e);
    twiml.say({ voice: "Polly.Joanna", language: "en-US" }, "Got it. Quick question—when did this happen?");
    twiml.hangup();
  }

  return new Response(twiml.toString(), { headers: { "Content-Type": "text/xml" } });
}
