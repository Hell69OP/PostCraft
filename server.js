
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Database from "better-sqlite3";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "llama-3.3-70b-versatile"; // free tier, no card required
const FREE_DAILY_LIMIT = parseInt(process.env.FREE_DAILY_LIMIT || "5", 10);

// ---------- DATABASE ----------
// No user accounts — each browser gets an anonymous device ID (generated
// client-side, sent as a header) so free-tier usage can still be limited.
const db = new Database("postcraft.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    plan TEXT NOT NULL DEFAULT 'free',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    date TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(device_id, date)
  );
`);

// ---------- HELPERS ----------
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function deviceMiddleware(req, res, next) {
  const deviceId = req.headers["x-device-id"];
  if (!deviceId) return res.status(400).json({ error: "Missing device id" });
  req.deviceId = deviceId;

  const existing = db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId);
  if (!existing) {
    db.prepare("INSERT INTO devices (device_id) VALUES (?)").run(deviceId);
  }
  next();
}

function getUsageToday(deviceId) {
  const row = db
    .prepare("SELECT count FROM usage WHERE device_id = ? AND date = ?")
    .get(deviceId, todayStr());
  return row ? row.count : 0;
}

function incrementUsage(deviceId) {
  const date = todayStr();
  db.prepare(
    `INSERT INTO usage (device_id, date, count) VALUES (?, ?, 1)
     ON CONFLICT(device_id, date) DO UPDATE SET count = count + 1`
  ).run(deviceId, date);
}

// ---------- USAGE STATUS ----------
app.get("/api/usage", deviceMiddleware, (req, res) => {
  const device = db.prepare("SELECT plan FROM devices WHERE device_id = ?").get(req.deviceId);
  const used = getUsageToday(req.deviceId);
  const limit = device.plan === "pro" ? null : FREE_DAILY_LIMIT;
  res.json({ plan: device.plan, usedToday: used, dailyLimit: limit });
});

// ---------- GENERATE (the core feature — no login required) ----------
app.post("/api/generate", deviceMiddleware, async (req, res) => {
  const device = db.prepare("SELECT * FROM devices WHERE device_id = ?").get(req.deviceId);
  const usedToday = getUsageToday(req.deviceId);

  if (device.plan !== "pro" && usedToday >= FREE_DAILY_LIMIT) {
    return res.status(403).json({
      error: `Free daily limit reached (${FREE_DAILY_LIMIT}/day). Upgrade to Pro for unlimited posts.`,
      upgradeRequired: true,
    });
  }

  const { topic, niche, vibeLabel } = req.body;
  if (!topic) return res.status(400).json({ error: "Missing topic" });

  const prompt = `You are a social media content assistant for a creator in the "${niche || "general lifestyle"}" niche.
Their post idea: "${topic}"
Desired vibe/tone: "${vibeLabel || "aesthetic"}"

Generate:
1. Three distinct caption variants (each 1-3 sentences, natural creator voice, no generic corporate tone)
2. 8 relevant hashtags (mix of niche-specific and broader reach tags, no # symbol needed, just the words)
3. One short punchy line (max 8 words) suitable as bold text overlay on a graphic

Respond ONLY with valid JSON, nothing else — no markdown fences, no preamble, no explanation before or after. Your entire response must be parseable JSON in this exact shape:
{"captions":["...","...","..."],"hashtags":["...","...","..."],"cardline":"..."}`;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Groq API error:", errText);
      return res.status(502).json({ error: "AI provider error, please try again" });
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || "";
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    incrementUsage(req.deviceId);
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong generating your post" });
  }
});

// ---------- UPGRADE (stub — wire to Razorpay/Stripe later) ----------
app.post("/api/upgrade", deviceMiddleware, (req, res) => {
  // TODO: verify a real payment (Razorpay/Stripe webhook) before doing this.
  // Right now anyone can click Upgrade and get Pro for free — fine for testing
  // the flow, but replace this before you promote the app publicly.
  db.prepare("UPDATE devices SET plan = 'pro' WHERE device_id = ?").run(req.deviceId);
  res.json({ plan: "pro" });
});

app.listen(PORT, () => {
  console.log(`Postcraft server running on port ${PORT}`);
});
