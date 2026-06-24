const express = require("express");
const cors = require("cors");
const multer = require("multer");
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk").default;
const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.post("/stripe-webhook", express.raw({ type: "application/json" }), async function(req, res) {
  try {
    var event = JSON.parse(req.body);
    if (event.type === "checkout.session.completed") {
      var session = event.data.object;
      var userId = session.metadata.user_id;
      if (userId) {
        await supabase.from("subscriptions").upsert({
          user_id: userId,
          plan: "basic",
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          updated_at: new Date().toISOString()
        }, { onConflict: "user_id" });
      }
    }
    res.json({ received: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const FREE_LIMIT = 10;
const BASIC_LIMIT = 100;

async function getUserPlan(userId) {
  var { data } = await supabase
    .from("subscriptions")
    .select("plan")
    .eq("user_id", userId)
    .single();
  return data ? data.plan : "free";
}

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

app.post("/forgot-password", async function(req, res) {
  try {
    var { email } = req.body;
    var { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: "Reset link sent" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    var plan = await getUserPlan(data.user.id);
    res.json({
      token: data.session.access_token,
      user: { id: data.user.id, email: data.user.email },
      plan: plan
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/create-checkout", async function(req, res) {
  try {
    var token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "Not logged in" });
    token = token.replace("Bearer ", "");

    var { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid session" });

    var appUrl = req.headers.origin || req.headers.referer || "https://example.com";

    var session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      metadata: { user_id: user.id },
      customer_email: user.email,
      success_url: appUrl + "?upgraded=true",
      cancel_url: appUrl + "?cancelled=true"
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/subscription", async function(req, res) {
  try {
    var token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "Not logged in" });
    token = token.replace("Bearer ", "");

    var { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid session" });

    var plan = await getUserPlan(user.id);
    var noteCount = await getNoteCount(user.id);
    var limit = plan === "basic" ? BASIC_LIMIT : FREE_LIMIT;

    res.json({ plan: plan, usage: { count: noteCount, limit: limit } });
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

    var plan = await getUserPlan(user.id);
    var noteCount = await getNoteCount(user.id);
    var limit = plan === "basic" ? BASIC_LIMIT : FREE_LIMIT;

    if (noteCount >= limit) {
      return res.status(429).json({
        error: "Monthly limit reached (" + limit + " notes). " + (plan === "free" ? "Upgrade for more." : ""),
        count: noteCount,
        limit: limit
      });
    }

    if (!req.file) return res.status(400).json({ error: "No audio file" });

    var audioFile = new File([req.file.buffer], "audio.webm", { type: req.file.mimetype });
    var transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      language: "en",
      response_format: "text"
    });

    var transcript = transcription.trim();
    if (!transcript) return res.status(400).json({ error: "Could not transcribe audio" });

    var userTags = req.body && req.body.customTags ? req.body.customTags : "";
    var tagInstruction = "";
    if (userTags) {
      tagInstruction = "IMPORTANT: Only use tags from this list: " + userTags + ". Pick 1-3 that fit.";
    } else {
      tagInstruction = "Tags: 1-3 short words like urgent, reminder, task, idea, question, meeting, personal, follow-up.";
    }

    var prompt = 'Analyse this voice note and return ONLY valid JSON, no markdown:\n\n"' + transcript + '"\n\nReturn: {"tags":["tag1","tag2"],"priority":"high|medium|low","actions":["action1"]}\n\n' + tagInstruction + ' Priority: high=time-sensitive, medium=important, low=general. Actions: concrete to-dos or empty array.';

    var message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{
        role: "user",
        content: prompt
      }]
    });

    var raw = message.content.map(function(c) { return c.text || ""; }).join("").trim();
    raw = raw.replace(/```json|```/g, "").trim();

    var analysis;
    try { analysis = JSON.parse(raw); }
    catch(e) { analysis = { tags: ["note"], priority: "medium", actions: [] }; }

    var { data: note, error: noteErr } = await supabase.from("notes").insert({
      user_id: user.id,
      transcript: transcript,
      tags: (analysis.tags || []).join(", "),
      priority: analysis.priority || "medium",
      actions: (analysis.actions || []).join(" | ")
    }).select().single();

    if (noteErr) return res.status(500).json({ error: noteErr.message });

    res.json({
      note: note,
      usage: { count: noteCount + 1, limit: limit }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/notes", async function(req, res) {
  try {
    var token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "Not logged in" });
    token = token.replace("Bearer ", "");

    var { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid session" });

    var plan = await getUserPlan(user.id);
    var limit = plan === "basic" ? BASIC_LIMIT : FREE_LIMIT;

    var { data: notes, error: notesErr } = await supabase
      .from("notes")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (notesErr) return res.status(500).json({ error: notesErr.message });

    var noteCount = await getNoteCount(user.id);
    res.json({ notes: notes, usage: { count: noteCount, limit: limit } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

var port = process.env.PORT || 3000;
app.listen(port, function() {
  console.log("VoiceTag server running on port " + port);
});
