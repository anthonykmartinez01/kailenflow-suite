// Shared call-analysis logic (download recording → transcribe → coach) used by
// the background function so long calls never hit the request time limit.
// Returns the same shapes the frontend already understands:
//   { transcript, analysis }                        — a real coached call
//   { notConversation:true, callType, transcript }  — voicemail / no-answer
//   { error }                                        — something went wrong

const GHL = "https://services.leadconnectorhq.com";
const GHL_V = "2021-07-28";

async function transcribe(audio: ArrayBuffer, contentType: string, dgKey: string) {
  const url = "https://api.deepgram.com/v1/listen?model=nova-2-phonecall&diarize=true&punctuate=true&utterances=true&smart_format=true";
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Token ${dgKey}`, "Content-Type": contentType || "audio/wav" },
    body: audio,
  });
  if (!r.ok) throw new Error(`Deepgram error ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const d = await r.json();
  const utts = d.results?.utterances || [];
  if (utts.length) {
    const transcript = utts.map((u: any) => `Speaker ${u.speaker}: ${u.transcript}`).join("\n");
    const wordsBy: Record<string, number> = {};
    for (const u of utts) {
      const w = (u.transcript || "").split(/\s+/).filter(Boolean).length;
      wordsBy[u.speaker] = (wordsBy[u.speaker] || 0) + w;
    }
    const counts = Object.values(wordsBy).sort((a, b) => b - a);
    return { transcript, speakers: counts.length, totalWords: counts.reduce((a, b) => a + b, 0), secondSpeakerWords: counts[1] || 0 };
  }
  const flat = d.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
  return { transcript: flat, speakers: flat ? 1 : 0, totalWords: flat.split(/\s+/).filter(Boolean).length, secondSpeakerWords: 0 };
}

async function coach(transcript: string, anthropicKey: string) {
  const prompt = `You are an elite cold-calling coach. Below is a diarized transcript of a phone call. The sales rep was cold-calling local businesses to offer local SEO / marketing services.

FIRST, classify the call honestly:
- "real conversation": a genuine two-way talk between the rep and a live person (prospect or gatekeeper who engaged).
- "voicemail": the rep reached/left a voicemail, or it's a voicemail greeting — NOT a live two-way talk.
- "no answer": ringing, silence, or no real human exchange.
Set isRealConversation=false for voicemail/no answer, and in that case leave the coaching arrays empty.

Return ONLY valid JSON (no markdown, no commentary) with exactly this shape:
{
  "isRealConversation": true,
  "callType": "real conversation",
  "repSpeaker": "Speaker 0",
  "score": 7,
  "summary": "2-3 sentence honest read (for voicemail/no-answer, just say what it was)",
  "wentWell": ["specific things the rep did well"],
  "mistakes": ["specific mistakes, quoting moments"],
  "missedOpportunities": ["openings/objections the rep missed"],
  "nextTime": ["concrete, specific things to do differently next time"]
}

Transcript:
${transcript}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Claude error ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const d = await r.json();
  const text = (d.content?.[0]?.text || "").trim();
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(cleaned); } catch { return { summary: text, score: null, wentWell: [], mistakes: [], missedOpportunities: [], nextTime: [] }; }
}

export async function analyzeCall(messageId: string): Promise<any> {
  const token = Netlify.env.get("GHL_API_TOKEN");
  const loc = Netlify.env.get("GHL_LOCATION_ID");
  const dgKey = Netlify.env.get("DEEPGRAM_API_KEY");
  const anthropicKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!token || !loc) return { error: "GHL is not configured." };
  if (!dgKey) return { error: "Transcription isn't set up yet — add DEEPGRAM_API_KEY in Netlify to enable Call Coach." };
  if (!anthropicKey) return { error: "Missing ANTHROPIC_API_KEY for the AI coaching." };

  const rec = await fetch(`${GHL}/conversations/messages/${messageId}/locations/${encodeURIComponent(loc)}/recording`, {
    headers: { Authorization: `Bearer ${token}`, Version: GHL_V },
  });
  if (!rec.ok) return { error: `Couldn't download the recording (${rec.status}).` };
  const audio = await rec.arrayBuffer();
  const ct = rec.headers.get("content-type") || "audio/wav";

  const { transcript, speakers, totalWords, secondSpeakerWords } = await transcribe(audio, ct, dgKey);
  if (!transcript.trim() || totalWords < 10 || speakers < 2 || secondSpeakerWords < 10) {
    return { notConversation: true, callType: speakers < 2 ? "no answer / one-sided" : "voicemail / no real exchange", transcript };
  }
  const analysis = await coach(transcript, anthropicKey);
  if (analysis && analysis.isRealConversation === false) {
    return { notConversation: true, callType: analysis.callType || "voicemail / no answer", summary: analysis.summary, transcript };
  }
  return { transcript, analysis };
}
