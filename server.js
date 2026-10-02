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

function getResend() {
  var key = process.env.RESEND_API_KEY || process.env.resend_api_key || process.env.Resend_API_Key;
  if (!key) return null;
  try { return new Resend(key); }
  catch(e) { console.log("Resend init error:", e.message); return null; }
}
const resend = getResend();

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
// IMPORTANT: persistSession/autoRefreshToken must both be false on the server.
// By default supabase-js keeps the session from signInWithPassword in memory
// and refreshes it on a background timer (~hourly). On a server that meant
// every login started a timer that rotated THAT USER'S refresh token without
// their device knowing, so the copy on their phone became "already used" and
// they were forced to log in again. A backend is stateless; it must never hold
// or renew a user's session on their behalf.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const PLANS = {
  free: { limit: 10, maxMinutes: 2 },
  basic: { limit: 100, maxMinutes: 5 },
  pro: { limit: 999999, maxMinutes: 10 }
};

// Plans at or above this limit are presented as "Unlimited" rather than
// showing the raw sentinel number (the "6 / 999999 notes" badge).
const UNLIMITED_THRESHOLD = 9999;

// Fallback for uploads that arrive without a usable filename. Mirrors the
// frontend's extForMime so both ends agree on what Whisper will accept.
function extForMime(mime) {
  var m = String(mime || "").toLowerCase();
  if (m.indexOf("webm") > -1) return "webm";
  if (m.indexOf("ogg") > -1 || m.indexOf("oga") > -1) return "ogg";
  if (m.indexOf("m4a") > -1 || m.indexOf("aac") > -1) return "m4a";
  if (m.indexOf("mp4") > -1) return "mp4";
  if (m.indexOf("mpeg") > -1 || m.indexOf("mp3") > -1) return "mp3";
  if (m.indexOf("wav") > -1) return "wav";
  if (m.indexOf("flac") > -1) return "flac";
  return "webm";
}

// Several tables (notes, subscriptions, user_settings) have RLS requiring
// auth.uid() = user_id. The shared `supabase` client above has no per-user
// identity attached, so RLS checks on it are unreliable — this creates a
// request-scoped client carrying the caller's own token, so Postgres can
// correctly verify auth.uid() for that request.
function userScopedClient(token) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: "Bearer " + token } }
  });
}
function notesClientFor(token) { return userScopedClient(token); }

async function getUserPlan(userId, scopedClient) {
  var client = scopedClient || supabase;
  var { data } = await client
    .from("subscriptions")
    .select("plan")
    .eq("user_id", userId)
    .single();
  return data ? data.plan : "free";
}

async function getNoteCount(userId, notesClient) {
  var client = notesClient || supabase;
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  var { count } = await client
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

// Signup stored nothing about where the person came from, so there was no way
// to tell an organic web signup from a Play-track tester. `display_mode` is the
// decisive one: "standalone" means they were in the installed app, "browser"
// means they found the site. Recorded best-effort - never fail a signup over it.
async function recordSignupSource(userId, source, userAgent) {
  try {
    if (!userId) return;
    var src = source || {};
    var host = null;
    if (src.referrer) {
      try { host = new URL(src.referrer).hostname; } catch (e) { host = null; }
    }
    await supabase.from("signup_sources").insert({
      user_id: userId,
      referrer: src.referrer || null,
      referrer_host: host,
      landing_path: src.landingPath || null,
      display_mode: src.displayMode || null,
      utm: src.utm && Object.keys(src.utm).length ? src.utm : null,
      user_agent: userAgent || null,
      language: src.language || null
    });
  } catch (e) {
    console.log("SIGNUP_SOURCE_LOG_ERROR " + (e && e.message));
  }
}

app.post("/signup", async function(req, res) {
  try {
    var { email, password, source } = req.body;
    var { data, error } = await supabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true
    });
    if (error) return res.status(400).json({ error: error.message });
    await recordSignupSource(data.user.id, source, req.headers["user-agent"]);
    res.json({ user: { id: data.user.id, email: data.user.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/login", async function(req, res) {
  try {
    var { email, password } = req.body;
    // Sign in on a throwaway client. If the shared `supabase` client is used
    // here it keeps this user's session in memory for the life of the process,
    // and supabase-js will silently refresh that session before a later query
    // (e.g. the 1am digest cron) — rotating the user's refresh token behind
    // their back and stranding the copy on their phone.
    var loginClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    var { data, error } = await loginClient.auth.signInWithPassword({
      email: email,
      password: password
    });
    if (error) return res.status(400).json({ error: error.message });
    var scoped = userScopedClient(data.session.access_token);
    var plan = await getUserPlan(data.user.id, scoped);
    var planInfo = PLANS[plan] || PLANS.free;
    var { data: settings } = await scoped
      .from("user_settings")
      .select("daily_email, sheets_url")
      .eq("user_id", data.user.id)
      .single();
    res.json({
      token: data.session.access_token,
      refreshToken: data.session.refresh_token,
      user: { id: data.user.id, email: data.user.email },
      plan: plan,
      maxMinutes: planInfo.maxMinutes,
      dailyEmail: settings ? settings.daily_email : false,
      sheetsUrl: settings ? settings.sheets_url : ""
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/refresh", async function(req, res) {
  try {
    var refreshToken = req.body.refreshToken;
    if (!refreshToken) return res.status(400).json({ error: "No refresh token" });

    var authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    var { data, error } = await authClient.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data || !data.session) {
      console.error("Refresh failed:", error ? (error.message + " | status: " + error.status + " | code: " + error.code) : "no session returned");
      return res.status(401).json({ error: "Session expired" });
    }

    var plan = await getUserPlan(data.user.id, userScopedClient(data.session.access_token));
    var planInfo = PLANS[plan] || PLANS.free;
    var { data: settings } = await userScopedClient(data.session.access_token)
      .from("user_settings")
      .select("daily_email, sheets_url")
      .eq("user_id", data.user.id)
      .single();
    res.json({
      token: data.session.access_token,
      refreshToken: data.session.refresh_token,
      user: { id: data.user.id, email: data.user.email },
      plan: plan,
      maxMinutes: planInfo.maxMinutes,
      dailyEmail: settings ? settings.daily_email : false,
      sheetsUrl: settings ? settings.sheets_url : ""
    });
  } catch (err) {
    console.error("Refresh exception:", err);
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

    await userScopedClient(token).from("user_settings").upsert({
      user_id: user.id,
      daily_email: enabled,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });

    res.json({ daily_email: enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/save-sheets-url", async function(req, res) {
  try {
    var token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "Not logged in" });
    token = token.replace("Bearer ", "");

    var { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid session" });

    var url = req.body.sheetsUrl ? String(req.body.sheetsUrl).trim() : "";

    await userScopedClient(token).from("user_settings").upsert({
      user_id: user.id,
      sheets_url: url,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });

    res.json({ sheetsUrl: url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Until now the digest only reached people who were already active: the
// 48-hour window skipped anyone with no recent notes, so the users most worth
// recovering got nothing at all. It now sends two different things - a digest
// to active users and a nudge to lapsed ones - and writes every send to
// email_log, so what went out is a record rather than an inference.
var MAIL_FROM = "ThinqNote <notes@thinqnote.com>"; // becomes Adnoto once Resend verifies adnoto.app
var DIGEST_WINDOW_HOURS = 48;
var NUDGE_MIN_DAYS_BETWEEN = 7;  // never nag more than weekly
var NUDGE_MAX_LAPSED_DAYS = 30;  // past a month, stop entirely

async function logEmail(userId, kind, notesCount, status, error) {
  try {
    await supabase.from("email_log").insert({
      user_id: userId,
      kind: kind,
      notes_count: (notesCount === null || notesCount === undefined) ? null : notesCount,
      status: status,
      error: error ? String(error).slice(0, 500) : null
    });
  } catch (e) {
    console.log("EMAIL_LOG_ERROR " + (e && e.message));
  }
}

function mailShell(inner) {
  return '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;padding:0 16px">' +
    '<div style="padding:24px 0;text-align:center"><span style="font-size:22px;font-weight:700;color:#1a1a2e">Ad</span><span style="font-size:22px;font-weight:700;color:#7A2E63">noto</span></div>' +
    inner +
    '<div style="padding:24px 0;text-align:center;color:#8891A5;font-size:12px">From <a href="https://adnoto.app" style="color:#7A2E63;text-decoration:none">Adnoto</a> &mdash; turn this off in Settings</div>' +
    '</div>';
}

app.get("/send-daily-emails", async function(req, res) {
  try {
    var debug = {
      resendInitialized: !!resend,
      resendKeyPresent: !!process.env.RESEND_API_KEY
    };

    var { data: settings } = await supabase
      .from("user_settings")
      .select("user_id")
      .eq("daily_email", true);

    debug.usersOptedIn = settings ? settings.length : 0;
    if (!settings || settings.length === 0) {
      console.log("DAILY_EMAIL opted_in=0 digests=0 nudges=0 skipped=0");
      return res.json({ digests: 0, nudges: 0, skipped: 0, debug: debug });
    }

    var now = new Date();
    var cutoff = new Date(now.getTime() - DIGEST_WINDOW_HOURS * 3600 * 1000).toISOString();
    var digests = 0, nudges = 0, skipped = 0;
    var errors = [];
    var skipReasons = {};

    function skip(reason) { skipped++; skipReasons[reason] = (skipReasons[reason] || 0) + 1; }

    for (var i = 0; i < settings.length; i++) {
      var userId = settings[i].user_id;

      var { data: userData, error: userErr } = await supabase.auth.admin.getUserById(userId);
      if (userErr || !userData || !userData.user) { skip("user_fetch_failed"); continue; }
      var email = userData.user.email;

      if (!resend) { errors.push("Resend not initialized"); skip("resend_missing"); continue; }

      var { data: notes, error: notesErr } = await supabase
        .from("notes")
        .select("*")
        .eq("user_id", userId)
        .gte("created_at", cutoff)
        .order("created_at", { ascending: true });
      if (notesErr) { errors.push("notes error: " + notesErr.message); skip("notes_error"); continue; }

      // ---------- active user: the digest ----------
      if (notes && notes.length > 0) {
        var noteRows = notes.map(function(n) {
          var d = new Date(n.created_at);
          var time = d.getHours() + ":" + ("0" + d.getMinutes()).slice(-2);
          var tags = n.tags ? '<span style="color:#7A2E63">[' + n.tags + ']</span> ' : '';
          var priority = n.priority ? '<span style="color:' + (n.priority === 'high' ? '#E5484D' : n.priority === 'medium' ? '#BD5B00' : '#1B873F') + '">(' + n.priority + ')</span> ' : '';
          var actions = n.actions ? '<br><span style="color:#8891A5;font-size:13px">&#10003; ' + n.actions + '</span>' : '';
          return '<tr><td style="padding:12px 16px;border-bottom:1px solid #f0f2f5;vertical-align:top;color:#8891A5;font-size:13px;white-space:nowrap">' + time + '</td><td style="padding:12px 16px;border-bottom:1px solid #f0f2f5;font-size:14px;color:#1a1a2e">' + tags + priority + n.transcript + actions + '</td></tr>';
        }).join("");

        var digestHtml = mailShell(
          '<div style="padding:16px 20px;background:#f7f8fa;border-radius:12px;margin-bottom:20px;text-align:center;color:#5A6478">Your recent notes &mdash; <strong>' + notes.length + ' note' + (notes.length === 1 ? '' : 's') + '</strong></div>' +
          '<table style="width:100%;border-collapse:collapse">' + noteRows + '</table>'
        );

        try {
          var sendResult = await resend.emails.send({
            from: MAIL_FROM,
            to: email,
            subject: "Your Adnoto summary — " + notes.length + " note" + (notes.length === 1 ? "" : "s"),
            html: digestHtml
          });
          if (sendResult.error) {
            errors.push("Resend error: " + JSON.stringify(sendResult.error));
            await logEmail(userId, "digest", notes.length, "failed", JSON.stringify(sendResult.error));
          } else {
            digests++;
            await logEmail(userId, "digest", notes.length, "sent", null);
          }
        } catch (sendErr) {
          errors.push("Send exception: " + sendErr.message);
          await logEmail(userId, "digest", notes.length, "failed", sendErr.message);
        }
        continue;
      }

      // ---------- lapsed user: the nudge ----------
      // Guarded three ways so this can never become a daily nag: they must have
      // actually used the app, must not be long gone, and must not have had a
      // nudge in the last week.
      var { data: lastNotes } = await supabase
        .from("notes")
        .select("created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1);

      if (!lastNotes || lastNotes.length === 0) { skip("never_recorded"); continue; }

      var daysSince = (now - new Date(lastNotes[0].created_at)) / 86400000;
      if (daysSince > NUDGE_MAX_LAPSED_DAYS) { skip("long_gone"); continue; }

      var nudgeCutoff = new Date(now.getTime() - NUDGE_MIN_DAYS_BETWEEN * 86400000).toISOString();
      var { data: recentNudge } = await supabase
        .from("email_log")
        .select("id")
        .eq("user_id", userId)
        .eq("kind", "nudge")
        .eq("status", "sent")
        .gte("created_at", nudgeCutoff)
        .limit(1);

      if (recentNudge && recentNudge.length > 0) { skip("nudged_recently"); continue; }

      var days = Math.floor(daysSince);
      var nudgeHtml = mailShell(
        '<div style="padding:20px;background:#f7f8fa;border-radius:12px;margin-bottom:20px;color:#5A6478;line-height:1.55">' +
        'You haven\'t captured anything for ' + days + ' day' + (days === 1 ? '' : 's') + '. ' +
        'If something has been on your mind today, it takes about ten seconds to get it down.' +
        '</div>' +
        '<div style="text-align:center;padding:4px 0 8px">' +
        '<a href="https://adnoto.app" style="display:inline-block;padding:13px 26px;background:#7A2E63;color:#ffffff;border-radius:12px;text-decoration:none;font-weight:600;font-size:15px">Record a note</a>' +
        '</div>'
      );

      try {
        var nudgeResult = await resend.emails.send({
          from: MAIL_FROM,
          to: email,
          subject: "Anything worth capturing today?",
          html: nudgeHtml
        });
        if (nudgeResult.error) {
          errors.push("Resend error (nudge): " + JSON.stringify(nudgeResult.error));
          await logEmail(userId, "nudge", 0, "failed", JSON.stringify(nudgeResult.error));
        } else {
          nudges++;
          await logEmail(userId, "nudge", 0, "sent", null);
        }
      } catch (sendErr) {
        errors.push("Nudge exception: " + sendErr.message);
        await logEmail(userId, "nudge", 0, "failed", sendErr.message);
      }
    }

    console.log("DAILY_EMAIL opted_in=" + settings.length + " digests=" + digests +
                " nudges=" + nudges + " skipped=" + skipped +
                " reasons=" + JSON.stringify(skipReasons));

    res.json({ digests: digests, nudges: nudges, skipped: skipped, skipReasons: skipReasons, errors: errors, debug: debug });
  } catch (err) {
    console.log("DAILY_EMAIL_FAILED " + err.message);
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

    var scoped = userScopedClient(token);
    var plan = await getUserPlan(user.id, scoped);
    var planInfo = PLANS[plan] || PLANS.free;
    var noteCount = await getNoteCount(user.id, scoped);
    var { data: settings } = await scoped
      .from("user_settings")
      .select("daily_email")
      .eq("user_id", user.id)
      .single();

    res.json({
      plan: plan,
      maxMinutes: planInfo.maxMinutes,
      usage: { count: noteCount, limit: planInfo.limit, unlimited: planInfo.limit >= UNLIMITED_THRESHOLD },
      dailyEmail: settings ? settings.daily_email : false
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recordings can fail in two places and until now both were invisible: in the
// browser before anything is uploaded (mic denied, MediaRecorder error, an
// empty blob), and here when Whisper returns an empty transcript. Both cost us
// a tester and neither left a trace, so record them. Best-effort only - a
// failure to log a failure must never break the response.
async function recordCaptureFailure(fields) {
  try {
    console.log("CAPTURE_FAILURE " + JSON.stringify(fields));
    await supabase.from("capture_failures").insert({
      user_id: fields.userId || null,
      stage: fields.stage,
      message: fields.message || null,
      audio_bytes: fields.audioBytes || null,
      audio_mime: fields.audioMime || null,
      duration_seconds: fields.durationSeconds || null,
      user_agent: fields.userAgent || null,
      detail: fields.detail || null
    });
  } catch (e) {
    console.log("CAPTURE_FAILURE_LOG_ERROR " + (e && e.message));
  }
}

// Called by the frontend when a recording never makes it as far as an upload.
// Deliberately tolerant: it authenticates if it can, but still records the
// failure anonymously rather than rejecting it, because the whole point is to
// capture problems that happen when things are already going wrong.
app.post("/capture-failure", async function(req, res) {
  try {
    var userId = null;
    var token = req.headers.authorization;
    if (token) {
      try {
        var r = await supabase.auth.getUser(token.replace("Bearer ", ""));
        if (r && r.data && r.data.user) userId = r.data.user.id;
      } catch (e) { /* anonymous is fine */ }
    }
    await recordCaptureFailure({
      userId: userId,
      stage: (req.body && req.body.stage) || "unknown",
      message: req.body && req.body.message,
      audioBytes: req.body && req.body.audioBytes,
      audioMime: req.body && req.body.audioMime,
      durationSeconds: req.body && req.body.durationSeconds,
      userAgent: req.headers["user-agent"],
      detail: req.body && req.body.detail
    });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.post("/transcribe", upload.single("audio"), async function(req, res) {
  try {
    var token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "Not logged in" });
    token = token.replace("Bearer ", "");

    var { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid session" });

    var notesClient = notesClientFor(token);

    var plan = await getUserPlan(user.id, notesClient);
    var planInfo = PLANS[plan] || PLANS.free;
    var noteCount = await getNoteCount(user.id, notesClient);

    if (noteCount >= planInfo.limit) {
      return res.status(429).json({
        error: "Monthly limit reached (" + planInfo.limit + " notes). " + (plan === "free" ? "Upgrade for more." : ""),
        count: noteCount,
        limit: planInfo.limit
      });
    }

    if (!req.file) return res.status(400).json({ error: "No audio file" });

    // Whisper picks its decoder from the FILE EXTENSION, not the mime type.
    // The frontend already names the upload after the real format (iOS Safari
    // records mp4/m4a, not webm), so use the name it sent. Hardcoding
    // "audio.webm" here made every iOS recording fail with
    // "400 Invalid file format" even though mp4 is supported.
    var uploadName = req.file.originalname && /\.[a-z0-9]+$/i.test(req.file.originalname)
      ? req.file.originalname
      : "audio." + extForMime(req.file.mimetype);
    var audioFile = new File([req.file.buffer], uploadName, { type: req.file.mimetype });
    var transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      response_format: "text"
    });

    var transcript = transcription.trim();
    if (!transcript) {
      // Whisper got the audio and heard nothing in it. Almost always a silent
      // recording - mic muted, permission granted but no input, or audio routed
      // to a Bluetooth device that never opened its stream. The old message
      // ("Could not transcribe audio") read like an app fault and told the user
      // nothing they could act on, so say what actually happened.
      await recordCaptureFailure({
        userId: user.id,
        stage: "empty_transcript",
        message: "Whisper returned an empty transcript",
        audioBytes: req.file.buffer ? req.file.buffer.length : null,
        audioMime: req.file.mimetype,
        userAgent: req.headers["user-agent"],
        detail: { uploadName: uploadName }
      });
      return res.status(400).json({
        error: "We didn't hear anything. Nothing was saved, so no note is lost. Check your microphone isn't muted — and if you're on Bluetooth headphones, switch them off and try again.",
        reason: "empty_transcript"
      });
    }

    var userTags = req.body && req.body.customTags ? req.body.customTags : "";
    var tagInstruction = "";
    if (userTags) {
      tagInstruction = "IMPORTANT: Only use tags from this list: " + userTags + ". Pick 1-3 that fit. Use the tags exactly as written in the list.";
    } else {
      tagInstruction = "Tags: 1-3 short words like urgent, reminder, task, idea, question, meeting, personal, follow-up. Write the tags in the SAME LANGUAGE as the voice note above.";
    }

    var todayStr = new Date().toISOString().slice(0, 10);

    var prompt = 'Analyse this voice note and return ONLY valid JSON, no markdown:\n\n"' + transcript + '"\n\n' +
      'Return exactly this shape: {"summary":"one sentence","tags":["tag1","tag2"],"priority":"high|medium|low","actions":["action1"],"event":null}\n\n' +
      'SUMMARY: One short sentence (max 20 words) capturing what the note is about. ' +
      'Write it in the SAME LANGUAGE as the voice note. If the note is already very short ' +
      '(under about 15 words), set "summary" to null rather than restating it.\n\n' +
      tagInstruction + ' Write any action items in the SAME LANGUAGE as the voice note. ' +
      'Priority: high=time-sensitive, medium=important, low=general — keep the priority value as the English word high, medium, or low. Actions: concrete to-dos or empty array.\n\n' +
      'EVENT DETECTION: If the note describes a calendar event, appointment, meeting, or something happening on a specific date (for example "add to calendar", "dentist on 28 August", "meeting next Tuesday at 3pm"), set "event" to an object: ' +
      '{"title":"short event title","date":"YYYY-MM-DD","time":"HH:MM or null"}. ' +
      'Today is ' + todayStr + ' — use this to resolve relative dates like "tomorrow" or "next Tuesday" into an actual YYYY-MM-DD date. ' +
      'Use 24-hour time. If no specific time is mentioned, set "time" to null. Keep the title short and in the SAME LANGUAGE as the note. ' +
      'If the note is NOT about a dated event, set "event" to null.';

    var message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 640,
      messages: [{
        role: "user",
        content: prompt
      }]
    });

    var raw = message.content.map(function(c) { return c.text || ""; }).join("").trim();
    raw = raw.replace(/```json|```/g, "").trim();

    var analysis;
    try { analysis = JSON.parse(raw); }
    catch(e) { analysis = { summary: null, tags: ["note"], priority: "medium", actions: [], event: null }; }

    // Only keep a summary that actually adds something - the model is told to
    // return null for very short notes, but guard against it echoing the
    // transcript back anyway.
    var summary = null;
    if (analysis.summary && typeof analysis.summary === "string") {
      var sTrim = analysis.summary.trim();
      if (sTrim && sTrim.toLowerCase() !== transcript.trim().toLowerCase()) summary = sTrim;
    }

    // Validate the event object if present
    var eventData = null;
    if (analysis.event && analysis.event.title && analysis.event.date) {
      eventData = {
        title: String(analysis.event.title),
        date: String(analysis.event.date),
        time: analysis.event.time ? String(analysis.event.time) : null
      };
    }

    var { data: note, error: noteErr } = await notesClient.from("notes").insert({
      user_id: user.id,
      transcript: transcript,
      summary: summary,
      tags: (analysis.tags || []).join(", "),
      priority: analysis.priority || "medium",
      actions: (analysis.actions || []).join(" | ")
    }).select().single();

    if (noteErr) {
      console.error("Note insert failed:", noteErr.message, "| user:", user.id);
      return res.status(500).json({ error: noteErr.message });
    }

    // Attach event to the returned note so the frontend can offer "Add to Calendar"
    if (note && eventData) {
      note.event = eventData;
    }

    res.json({
      note: note,
      usage: { count: noteCount + 1, limit: planInfo.limit, unlimited: planInfo.limit >= UNLIMITED_THRESHOLD }
    });
  } catch (err) {
    console.error("Transcribe error:", err && err.message ? err.message : err, err && err.response && err.response.data ? JSON.stringify(err.response.data) : "");
    res.status(500).json({ error: err.message });
  }
});

// Searching a person's own notes. Two things happen here:
//
//   1. Postgres full-text retrieval via the search_notes() function, which is
//      SECURITY INVOKER and filters on auth.uid(), so a caller can only ever
//      match their own rows. It searches the generated search_doc column -
//      transcript + summary + tags + actions - using the 'simple' config, so
//      notes recorded in any language are matched on the words as spoken.
//
//   2. Optionally, an answer. When the query reads like a question, the top
//      matches are handed to Haiku, which answers from them and nothing else.
//      Retrieval always runs first, so the model only ever sees the caller's
//      own notes and cannot invent one.
app.post("/search", async function(req, res) {
  try {
    var token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "Not logged in" });
    token = token.replace("Bearer ", "");

    var { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid session" });

    var query = req.body && req.body.query ? String(req.body.query).trim() : "";
    if (!query) return res.json({ notes: [], answer: null, query: "" });
    if (query.length > 300) query = query.slice(0, 300);

    var notesClient = notesClientFor(token);

    var { data: notes, error: searchErr } = await notesClient
      .rpc("search_notes", { p_query: query, p_limit: 20 });

    if (searchErr) {
      console.error("Search failed:", searchErr.message, "| user:", user.id);
      return res.status(500).json({ error: searchErr.message });
    }
    notes = notes || [];

    // Only spend a model call when the person is actually asking something.
    var wantsAnswer = req.body && req.body.ask === true;
    if (!wantsAnswer || notes.length === 0) {
      return res.json({ notes: notes, answer: null, query: query });
    }

    var context = notes.slice(0, 12).map(function(n, i) {
      var d = new Date(n.created_at);
      var when = isNaN(d.getTime()) ? "unknown date" : d.toISOString().slice(0, 10);
      return "[" + (i + 1) + "] (" + when + ") " + (n.transcript || "");
    }).join("\n");

    var askPrompt =
      "Below are voice notes belonging to one person, each with the date it was recorded and a number.\n\n" +
      "NOTES:\n" + context + "\n\n" +
      "QUESTION: " + query + "\n\n" +
      "Answer the question using ONLY the notes above. Be brief - one or two sentences. " +
      "Cite the notes you used by their number, like [2]. " +
      "If the notes do not contain the answer, say so plainly rather than guessing. " +
      "Today is " + new Date().toISOString().slice(0, 10) + ", which you can use to resolve relative dates. " +
      "Answer in the same language as the question. Return the answer text only, no preamble.";

    var answer = null;
    try {
      var msg = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 320,
        messages: [{ role: "user", content: askPrompt }]
      });
      answer = msg.content.map(function(c) { return c.text || ""; }).join("").trim() || null;
    } catch (aiErr) {
      // A model failure must not cost the person their search results.
      console.error("Search answer failed:", aiErr && aiErr.message ? aiErr.message : aiErr);
    }

    res.json({ notes: notes, answer: answer, query: query });
  } catch (err) {
    console.error("Search error:", err && err.message ? err.message : err);
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

    var notesClient = notesClientFor(token);
    var plan = await getUserPlan(user.id, notesClient);
    var planInfo = PLANS[plan] || PLANS.free;

    var { data: notes, error: notesErr } = await notesClient
      .from("notes")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (notesErr) {
      console.error("Notes fetch failed:", notesErr.message, "| user:", user.id);
      return res.status(500).json({ error: notesErr.message });
    }

    var noteCount = await getNoteCount(user.id, notesClient);
    res.json({
      notes: notes,
      usage: { count: noteCount, limit: planInfo.limit, unlimited: planInfo.limit >= UNLIMITED_THRESHOLD },
      maxMinutes: planInfo.maxMinutes
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Catches errors thrown by middleware (e.g. multer file upload) that happen
// BEFORE a route's own try/catch runs. Without this, those failures show up
// as a bare 500 with nothing logged, which is exactly what was happening.
app.use(function(err, req, res, next) {
  console.error("Unhandled error on " + req.method + " " + req.path + ":", err && err.message ? err.message : err, err && err.code ? ("| code: " + err.code) : "");
  if (res.headersSent) return next(err);
  res.status(500).json({ error: (err && err.message) ? err.message : "Server error" });
});

var port = process.env.PORT || 3000;
app.listen(port, function() {
  console.log("Adnoto server running on port " + port);
});
