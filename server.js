const express = require("express");
const cors = require("cors");
const multer = require("multer");
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk").default;
const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");
const { Resend } = require("resend");

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

app.post("/stripe-webhook", express.raw({ type: "application/json" }), async function(req, res) {
  try {
    var event = JSON.parse(req.body);
    if (event.type === "checkout.session.completed") {
      var session = event.data.object;
      var userId = session.metadata.user_id;
      var plan = session.metadata.plan || "basic";
      if (userId) {
        await supabase.from("subscriptions").upsert({
          user_id: userId,
          plan: plan,
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

const PLANS = {
  free: { limit: 10, maxMinutes: 2 },
  basic: { limit: 100, maxMinutes: 5 },
  pro: { limit: 999999, maxMinutes: 10 }
};

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

app.post("/update-password", async function(req, res) {
  try {
    var { access_token, new_password } = req.body;
    if (!access_token || !new_password) {
      return res.status(400).json({ error: "Missing token or password" });
    }
    var { data: { user }, error: authErr } = await supabase.auth.getUser(access_token);
    if (authErr || !user) {
      return res.status(400).json({ error: "Invalid or expired reset link" });
    }
    var { error } = await supabase.auth.admin.updateUserById(user.id, {
      password: new_password
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: "Password updated" });
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
    var planInfo = PLANS[plan] || PLANS.free;
    var { data: settings } = await supabase
      .from("user_settings")
      .select("daily_email")
      .eq("user_id", data.user.id)
      .single();
    res.json({
      token: data.session.access_token,
      user: { id: data.user.id, email: data.user.email },
      plan: plan,
      maxMinutes: planInfo.maxMinutes,
      dailyEmail: settings ? settings.daily_email : false
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/toggle-daily-email", async function(req, res) {
  try {
    var token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "Not logged in" });
    token = token.replace("Bearer ", "");

    var { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid session" });

    var enabled = req.body.enabled ? true : false;

    await supabase.from("user_settings").upsert({
      user_id: user.id,
      daily_email: enabled,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });

    res.json({ daily_email: enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/send-daily-emails", async function(req, res) {
  try {
    var { data: settings } = await supabase
      .from("user_settings")
      .select("user_id")
      .eq("daily_email", true);

    if (!settings || settings.length === 0) {
      return res.json({ sent: 0 });
    }

    var now = new Date();
    var yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    var sent = 0;

    for (var i = 0; i < settings.length; i++) {
      var userId = settings[i].user_id;

      var { data: userData } = await supabase.auth.admin.getUserById(userId);
      if (!userData || !userData.user || !userData.user.email) continue;

      var { data: notes } = await supabase
        .from("notes")
        .select("*")
        .eq("user_id", userId)
        .gte("created_at", yesterday)
        .order("created_at", { ascending: true });

      if (!notes || notes.length === 0) continue;

      var noteRows = notes.map(function(n) {
        var d = new Date(n.created_at);
        var time = d.getHours() + ":" + ("0" + d.getMinutes()).slice(-2);
        var tags = n.tags ? '<span style="color:#4F6DF5">[' + n.tags + ']</span>' : '';
        var priority = n.priority ? '<span style="color:' + (n.priority === 'high' ? '#E5484D' : n.priority === 'medium' ? '#BD5B00' : '#1B873F') + '">' + n.priority + '</span>' : '';
        var actions = n.actions ? '<br><span style="color:#8891A5;font-size:13px">Actions: ' + n.actions + '</span>' : '';
        return '<tr><td style="padding:12px 16px;border-bottom:1px solid #f0f2f5;vertical-align:top;color:#8891A5;font-size:13px;white-space:nowrap">' + time + '</td><td style="padding:12px 16px;border-bottom:1px solid #f0f2f5">' + tags + ' ' + priority + '<br>' + n.transcript + actions + '</td></tr>';
      }).join("");

      var html = '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto">';
      html += '<div style="padding:24px 0;text-align:center"><span style="font-size:22px;font-weight:700;color:#1a1a2e">Thinq</span><span style="font-size:22px;font-weight:700;color:#4F6DF5">Note</span></div>';
      html += '<div style="padding:16px 20px;background:#f7f8fa;border-radius:12px;margin-bottom:20px;text-align:center;color:#5A6478">Your notes from the last 24 hours — <strong>' + notes.length + ' note' + (notes.length === 1 ? '' : 's') + '</strong></div>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:14px;color:#1a1a2e">';
      html += noteRows;
      html += '</table>';
      html += '<div style="padding:24px 0;text-align:center;color:#8891A5;font-size:12px">Sent from <a href="https://thinqnote.com" style="color:#4F6DF5;text-decoration:none">ThinqNote</a> — you can turn this off in Settings</div>';
      html += '</div>';

      await resend.emails.send({
        from: "ThinqNote <notes@thinqnote.com>",
        to: userData.user.email,
        subject: "Your ThinqNote summary — " + notes.length + " note" + (notes.length === 1 ? "" : "s") + " today",
        html: html
      });

      sent++;
    }

    res.json({ sent: sent });
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

    var selectedPlan = req.body.plan || "basic";
    var priceId = selectedPlan === "pro" ? process.env.STRIPE_PRICE_ID_PRO : process.env.STRIPE_PRICE_ID;
    var appUrl = req.headers.origin || req.headers.referer || "https://example.com";

    var session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { user_id: user.id, plan: selectedPlan },
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
    var planInfo = PLANS[plan] || PLANS.free;
    var noteCount = await getNoteCount(user.id);
    var { data: settings } = await supabase
      .from("user_settings")
      .select("daily_email")
      .eq("user_id", user.id)
      .single();

    res.json({
      plan: plan,
      maxMinutes: planInfo.maxMinutes,
      usage: { count: noteCount, limit: planInfo.limit },
      dailyEmail: settings ? settings.daily_email : false
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

    var plan = await getUserPlan(user.id);
    var planInfo = PLANS[plan] || PLANS.free;
    var noteCount = await getNoteCount(user.id);

    if (noteCount >= planInfo.limit) {
      return res.status(429).json({
        error: "Monthly limit reached (" + planInfo.limit + " notes). " + (plan === "free" ? "Upgrade for more." : ""),
        count: noteCount,
        limit: planInfo.limit
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
      usage: { count: noteCount + 1, limit: planInfo.limit }
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
    var planInfo = PLANS[plan] || PLANS.free;

    var { data: notes, error: notesErr } = await supabase
      .from("notes")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (notesErr) return res.status(500).json({ error: notesErr.message });

    var noteCount = await getNoteCount(user.id);
    res.json({
      notes: notes,
      usage: { count: noteCount, limit: planInfo.limit },
      maxMinutes: planInfo.maxMinutes
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

var port = process.env.PORT || 3000;
app.listen(port, function() {
  console.log("ThinqNote server running on port " + port);
});
