const express = require("express");
const cors = require("cors");
const multer = require("multer");
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk").default;
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const FREE_LIMIT = 10;
const BASIC_LIMIT = 100;

async function getNoteCount(userId) {
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  var { count } = await supabase
    .from("notes")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", start);
  return count || 0;
}

app.get("/health", function(req, res) {
  res.json({ status: "ok" });
});

app.post("/signup", async function(req, res) {
  try {
    var { email, password } = req.body;
    var { data, error } = await supabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ user: { id: data.user.id, email: data.user.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/login", async function(req, res) {
  try {
    var { email, password } = req.body;
    var { data, error } = await supabase.auth.signInWithPassword({
      email: email,
      password: password
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json({
      token: data.session.access_token,
      user: { id: data.user.id, email: data.user.email }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/transcribe", upload.single("audio"), async function(req, res) {
  try {
    var token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "Not logged in" });
    token = token.replace("Bearer ", "");

    var { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid session" });

    var noteCount = await getNoteCount(user.id);
    var limit = FREE_LIMIT;
    if (noteCount >= limit) {
      return res.status(429).json({
        error: "Monthly limit reached (" + limit + " notes). Upgrade for more.",
        count: noteCount,
        limit: limit
      });
    }

    if (!req.file) return res.status(400).json({ error: "No audio file" });

    var audioFile = new
