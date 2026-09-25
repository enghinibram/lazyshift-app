// =====================================================================
// LAZYSHIFT — Edge Function: send-shift-reminders
// Adaptat din calculator-ture (supabase/functions/send-shift-reminders).
// Rulează orar (pg_cron + pg_net) și trimite o notificare push userilor
// cu acces (is_pro=true SAU trial_ends_at în viitor, din public.users) a
// căror tură începe în următoarele 2-3 ore, conform pattern-ului lor din
// user_settings + ora de start (shift_start_time), calculat în fusul
// orar al fiecărui user (user_settings.timezone).
//
// Deploy: supabase functions deploy send-shift-reminders
// Secrete necesare (supabase secrets set ...):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injectate automat de
//   Supabase), VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (deja
//   setate), PUSH_REMINDER_CRON_SECRET (de adăugat, și în Vault pentru
//   job-ul cron).
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Config VAPID citită și validată la fiecare request (nu la încărcarea
// modulului): dacă lipsește un secret, funcția răspunde cu un mesaj clar
// în loc să crape workerul pentru orice request, inclusiv cele
// neautentificate — mult mai ușor de diagnosticat din afară.
function configureVapidOrThrow() {
  const subject = Deno.env.get("VAPID_SUBJECT");
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!subject || !publicKey || !privateKey) {
    throw new Error(
      "Lipsesc secrete VAPID (VAPID_SUBJECT / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) — rulează `supabase secrets set`."
    );
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

const REMINDER_WINDOW_MIN_HOURS = 2;
const REMINDER_WINDOW_MAX_HOURS = 3;

// -----------------------------------------------------------------
// Identic cu PATTERNS din app.js (LazyShift) — orice modificare acolo
// (tipuri noi de tură) trebuie oglindită aici, altfel reminder-ele ies
// din sincron cu ce vede userul în calendar.
// -----------------------------------------------------------------
type ShiftDay = { type: "zi" | "noapte" | "liber"; label: string };
const PATTERNS: Record<string, { ore: number; zile: ShiftDay[] }> = {
  "12/24-12/48": {
    ore: 12,
    zile: [
      { type: "zi", label: "D" },
      { type: "noapte", label: "N" },
      { type: "liber", label: "" },
      { type: "liber", label: "" },
    ],
  },
  "12/24": {
    ore: 12,
    zile: [
      { type: "zi", label: "D" },
      { type: "liber", label: "" },
      { type: "noapte", label: "N" },
      { type: "liber", label: "" },
    ],
  },
  "12/24-24/72": {
    ore: 12,
    zile: [
      { type: "zi", label: "D" },
      { type: "noapte", label: "N" },
      { type: "liber", label: "" },
      { type: "liber", label: "" },
      { type: "liber", label: "" },
      { type: "liber", label: "" },
    ],
  },
  "8/3-morning": {
    ore: 8,
    zile: [
      { type: "zi", label: "M" },
      { type: "zi", label: "M" },
      { type: "zi", label: "M" },
      { type: "zi", label: "M" },
      { type: "zi", label: "M" },
      { type: "liber", label: "" },
      { type: "liber", label: "" },
    ],
  },
  "8/3-afternoon": {
    ore: 8,
    zile: [
      { type: "noapte", label: "A" },
      { type: "noapte", label: "A" },
      { type: "noapte", label: "A" },
      { type: "noapte", label: "A" },
      { type: "noapte", label: "A" },
      { type: "liber", label: "" },
      { type: "liber", label: "" },
    ],
  },
  "8/3-night": {
    ore: 8,
    zile: [
      { type: "noapte", label: "N" },
      { type: "noapte", label: "N" },
      { type: "noapte", label: "N" },
      { type: "noapte", label: "N" },
      { type: "noapte", label: "N" },
      { type: "liber", label: "" },
      { type: "liber", label: "" },
    ],
  },
  "8/3-rotating": {
    ore: 8,
    zile: [
      { type: "zi", label: "M" },
      { type: "zi", label: "M" },
      { type: "zi", label: "M" },
      { type: "zi", label: "M" },
      { type: "zi", label: "M" },
      { type: "noapte", label: "A" },
      { type: "noapte", label: "A" },
      { type: "noapte", label: "A" },
      { type: "noapte", label: "A" },
      { type: "noapte", label: "A" },
      { type: "noapte", label: "N" },
      { type: "noapte", label: "N" },
      { type: "noapte", label: "N" },
      { type: "noapte", label: "N" },
      { type: "noapte", label: "N" },
      { type: "liber", label: "" },
      { type: "liber", label: "" },
      { type: "liber", label: "" },
      { type: "liber", label: "" },
      { type: "liber", label: "" },
      { type: "liber", label: "" },
    ],
  },
  "24/48": {
    ore: 24,
    zile: [
      { type: "zi", label: "24" },
      { type: "liber", label: "" },
      { type: "liber", label: "" },
    ],
  },
  "24/72": {
    ore: 24,
    zile: [
      { type: "zi", label: "24" },
      { type: "liber", label: "" },
      { type: "liber", label: "" },
      { type: "liber", label: "" },
    ],
  },
};

// Textul notificării după label-ul zilei din pattern. Nu folosim `type`
// pentru text: în LazyShift turele de după-amiază (A) au type "noapte",
// iar "night shift" ar fi greșit pentru ele.
const SHIFT_NAMES: Record<string, string> = {
  D: "day shift",
  M: "morning shift",
  A: "afternoon shift",
  N: "night shift",
  "24": "24h shift",
  W: "shift", // zi de lucru în modul custom
};

type YMD = { y: number; m: number; d: number };

function parseISODateParts(iso: string): YMD {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

function dayDiffYMD(a: YMD, b: YMD): number {
  const ua = Date.UTC(a.y, a.m - 1, a.d);
  const ub = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((ub - ua) / 86400000);
}

function parseSet(raw: string | null): Set<string> | null {
  if (!raw) return null;
  try {
    return new Set(JSON.parse(raw));
  } catch {
    return null;
  }
}

// Zi de concediu (co_days = annual leave, cm_days = sick leave) — nu e
// tură reală, chiar dacă pattern-ul ar indica altfel pentru acea dată.
// Oglindește logica din recalc() (app.js).
function isExemptDay(row: { co_days: string | null; cm_days: string | null }, todayKey: string): boolean {
  const co = parseSet(row.co_days);
  const cm = parseSet(row.cm_days);
  return !!(co && co.has(todayKey)) || !!(cm && cm.has(todayKey));
}

function getShiftDay(
  today: YMD,
  turaType: string,
  startDateStr: string | null,
  customDays: Set<string> | null
): ShiftDay | null {
  if (turaType === "custom") {
    const key = `${today.y}-${today.m}-${today.d}`;
    return customDays && customDays.has(key)
      ? { type: "zi", label: "W" }
      : { type: "liber", label: "" };
  }
  if (!startDateStr) return null;
  const pat = PATTERNS[turaType];
  if (!pat) return null;
  const start = parseISODateParts(startDateStr);
  const diff = dayDiffYMD(start, today);
  const idx = ((diff % pat.zile.length) + pat.zile.length) % pat.zile.length;
  return pat.zile[idx];
}

// -----------------------------------------------------------------
// Utilitare de fus orar — totul calculat explicit prin Intl cu
// timeZone-ul userului, ca rezultatul să nu depindă de fusul orar al
// mediului de rulare (Deno rulează de regulă în UTC, dar nu ne bazăm
// pe asta).
// -----------------------------------------------------------------

// Un nume IANA (ex. "Europe/London") e valid dacă Intl îl acceptă;
// altfel constructorul aruncă RangeError. Rezultatul e ținut în cache,
// fiindcă mulți useri împart același fus orar.
const tzValidity = new Map<string, boolean>();
function isValidTimeZone(tz: string | null): tz is string {
  if (!tz) return false;
  const cached = tzValidity.get(tz);
  if (cached !== undefined) return cached;
  let ok = true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    ok = false;
  }
  tzValidity.set(tz, ok);
  return ok;
}

function getZonedYMD(date: Date, timeZone: string): YMD {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const asUTC = Date.UTC(y, m - 1, d, hh, mm, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(asUTC));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asIfLocal = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offset = asIfLocal - asUTC; // cât de "înainte" de UTC e fusul la acest moment
  return new Date(asUTC - offset);
}

// -----------------------------------------------------------------
// Funcție principală
// -----------------------------------------------------------------
async function runReminders() {
  const now = new Date();

  // Eligibili: Pro plătit SAU trial încă activ — aceeași regulă ca
  // Auth.getUserStatus() din auth.js ('pro' / 'trial').
  const { data: eligibleUsers, error: euErr } = await supabase
    .from("users")
    .select("id")
    .or(`is_pro.eq.true,trial_ends_at.gt.${now.toISOString()}`);
  if (euErr) return { success: false, error: euErr.message };

  const eligibleIds = (eligibleUsers ?? []).map((u: { id: string }) => u.id);
  if (eligibleIds.length === 0) return { success: true, checked: 0, sent: 0, skippedTimezone: 0 };

  const { data: settingsRows, error: usErr } = await supabase
    .from("user_settings")
    .select("user_id, tura_type, start_date, custom_days, co_days, cm_days, shift_start_time, timezone")
    .in("user_id", eligibleIds)
    .not("shift_start_time", "is", null);
  if (usErr) return { success: false, error: usErr.message };
  if (!settingsRows || settingsRows.length === 0) return { success: true, checked: 0, sent: 0, skippedTimezone: 0 };

  const userIds = settingsRows.map((r: { user_id: string }) => r.user_id);
  const { data: subs, error: subErr } = await supabase
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth_key")
    .in("user_id", userIds);
  if (subErr) return { success: false, error: subErr.message };

  type Sub = { id: string; user_id: string; endpoint: string; p256dh: string; auth_key: string };
  const subsByUser = new Map<string, Sub[]>();
  for (const s of (subs ?? []) as Sub[]) {
    const arr = subsByUser.get(s.user_id) ?? [];
    arr.push(s);
    subsByUser.set(s.user_id, arr);
  }

  let checked = 0;
  let sent = 0;
  let skippedTimezone = 0;

  for (const row of settingsRows) {
    checked++;

    const userSubs = subsByUser.get(row.user_id);
    if (!userSubs || userSubs.length === 0) continue; // are ora setată, dar niciun device abonat

    // Fără fus orar valid nu putem ști ce zi e "azi" pentru user și nici
    // când începe tura în UTC — sărim, în loc să ghicim un fus.
    if (!isValidTimeZone(row.timezone)) {
      skippedTimezone++;
      continue;
    }
    const timeZone = row.timezone;

    const today = getZonedYMD(now, timeZone);
    const todayKey = `${today.y}-${today.m}-${today.d}`;
    const todayDateCol = `${today.y}-${String(today.m).padStart(2, "0")}-${String(today.d).padStart(2, "0")}`;

    if (isExemptDay(row, todayKey)) continue; // concediu azi

    const shiftDay = getShiftDay(
      today,
      row.tura_type,
      row.start_date,
      parseSet(row.custom_days)
    );
    if (!shiftDay || (shiftDay.type !== "zi" && shiftDay.type !== "noapte")) continue;

    const [hh, mm] = String(row.shift_start_time).split(":").map(Number);
    const shiftStartUTC = zonedTimeToUtc(today.y, today.m, today.d, hh, mm, timeZone);
    const hoursUntil = (shiftStartUTC.getTime() - now.getTime()) / 3600000;

    if (hoursUntil < REMINDER_WINDOW_MIN_HOURS || hoursUntil >= REMINDER_WINDOW_MAX_HOURS) continue;

    // Dedupe: o singură notificare per user per zi de tură (data locală
    // a userului), indiferent de câte rulări orare "văd" aceeași tură în
    // fereastra de 2-3h. Dacă insert-ul eșuează (conflict SAU orice altă
    // eroare), sărim — nicio eroare tranzitorie nu blochează încercările
    // viitoare, fiindcă niciun rând nu rămâne scris dacă insert-ul nu a
    // reușit.
    const { error: logErr } = await supabase
      .from("push_reminder_log")
      .insert({ user_id: row.user_id, shift_date: todayDateCol });
    if (logErr) continue;

    // Label fără nume = tip de tură nou în app.js neoglindit în
    // SHIFT_NAMES. Trimitem totuși reminder-ul (textul generic e mai bun
    // decât niciunul), dar lăsăm urmă în log ca să fie adăugat.
    let shiftName = SHIFT_NAMES[shiftDay.label];
    if (!shiftName) {
      console.warn(
        `SHIFT_NAMES nu are nume pentru label "${shiftDay.label}" (tura_type "${row.tura_type}") — folosesc "shift". Adaugă-l în SHIFT_NAMES.`
      );
      shiftName = "shift";
    }
    const payload = JSON.stringify({
      title: "LazyShift",
      body: `⏰ Your ${shiftName} starts today at ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}.`,
      url: "/",
    });

    for (const sub of userSubs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
          payload
        );
        sent++;
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Subscripție expirată/invalidă — o ștergem, ca userul să nu
          // rămână cu o intrare moartă în push_subscriptions.
          await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        } else {
          console.error("Push failed for sub", sub.id, statusCode, err);
        }
      }
    }
  }

  return { success: true, checked, sent, skippedTimezone };
}

// -----------------------------------------------------------------
// Handler HTTP (apelat de pg_cron prin pg_net, o dată pe oră)
// -----------------------------------------------------------------
Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  const cronSecret = Deno.env.get("PUSH_REMINDER_CRON_SECRET");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    configureVapidOrThrow();
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: (err as Error).message }), {
      headers: { "Content-Type": "application/json" },
      status: 500,
    });
  }

  const result = await runReminders();
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json" },
    status: result.success ? 200 : 500,
  });
});
