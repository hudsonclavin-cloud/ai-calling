import fs from "fs";
import path from "path";
import crypto from "crypto";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
}

function hashText(text: string) {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
}

export async function generateTTS(text: string, filename?: string): Promise<string | null> {
  try {
    const base = baseUrl();
    if (!base) return null;

    const outDir = path.join(process.cwd(), "public", "tts");
    fs.mkdirSync(outDir, { recursive: true });

    const file = filename || `tts-${hashText(text)}.mp3`;
    const filePath = path.join(outDir, file);

    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
      return `${base}/tts/${file}`;
    }

    const response = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "coral",
      format: "mp3",
      input: text,
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    return `${base}/tts/${file}`;
  } catch (err) {
    console.error("generateTTS failed:", err);
    return null;
  }
}
