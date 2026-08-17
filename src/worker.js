const DEFAULT_SITE_URL = "https://eticket.railway.uz";
const MAX_TRACK_DATES = 30;
const DEFAULT_CHECK_LIMIT = 20;

const HELP_TEXT = `I can watch eticket.railway.uz and message you when matching train tickets appear.

Commands:
/newtracker - create a tracker step by step
/track FROM -> TO [DATE] [days=N] [dates=D1,D2] [types=TYPE1,TYPE2]
/list - show active trackers
/stop ID - stop one tracker
/stop_all - stop all trackers
/stations QUERY - find station codes
/types - common ticket type names
/cancel - cancel setup

Examples:
/track Tashkent -> Samarkand 2026-08-18 days=3 types=Kupe,SV
/track Toshkent -> Buxoro dates=2026-08-18,2026-08-20 types=O'rindiqli,Kupe
/track 2900000 -> 2900700 tomorrow types=Сидячий

Use /newtracker for the normal guided flow.`;

const TYPE_HELP = `Common type filters you can use:
O'rindiqli / Сидячий / seated
Kupe / Купе / coupe
Plaskartli / Плацкартный / platskart
SV / СВ

You can choose multiple types by separating them with commas, or type any to match all available tickets.`;

const POPULAR_STATIONS = [
  "Toshkent", "Samarqand", "Buxoro", "Urganch",
  "Nukus", "Xiva", "Farg'ona", "Andijon",
  "Namangan", "Qarshi", "Termiz", "Navoiy",
  "Jizzax", "Guliston", "Marg'ilon", "Qo'ng'irot",
];

const CAR_TYPE_ALIASES = {
  seated: new Set(["сидячий", "сидячие", "сидячий вагон", "o'rindiqli", "orindiqli", "ўриндиқли", "seat", "seated", "sitting"]),
  coupe: new Set(["купе", "kupe", "coupe", "compartment"]),
  platskart: new Set(["плацкарт", "плацкартный", "plaskart", "plaskartli", "platskart", "platzkart"]),
  sv: new Set(["св", "sv", "lux", "люкс"]),
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") return text("ticket tracker worker ok");
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/setup-webhook") return setupWebhook(request, env);
    if (url.pathname === webhookPath(env)) return telegramWebhook(request, env, ctx);
    return text("not found", 404);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(checkTrackers(env));
  },
};

async function telegramWebhook(request, env, ctx) {
  if (request.method !== "POST") return text("method not allowed", 405);
  const update = await request.json();
  try {
    await handleUpdate(update, env);
    console.log("update handled ok:", update.message && update.message.text);
  } catch (err) {
    console.error("handleUpdate failed:", (err && err.stack) || String(err));
  }
  return json({ ok: true });
}

async function setupWebhook(request, env) {
  if (request.method !== "POST") return text("method not allowed", 405);
  const url = new URL(request.url);
  const expected = env.ADMIN_SECRET || env.WEBHOOK_SECRET;
  if (expected && url.searchParams.get("secret") !== expected) return text("forbidden", 403);
  const webhookUrl = `${url.origin}${webhookPath(env)}`;
  const result = await telegramApi(env, "setWebhook", {
    url: webhookUrl,
    allowed_updates: JSON.stringify(["message"]),
  });
  return json({ ok: true, webhookUrl, result });
}

function webhookPath(env) {
  return `/telegram/${env.WEBHOOK_SECRET || "webhook"}`;
}

async function handleUpdate(update, env) {
  const message = update.message;
  if (!message || !message.chat || !message.text) return;
  const chatId = String(message.chat.id);
  const textValue = message.text.trim();
  const command = textValue.startsWith("/") ? textValue.split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase() : "";

  try {
    if (command === "/cancel") {
      await clearState(env, chatId);
      await sendMessage(env, chatId, "Setup cancelled.", mainKeyboard());
      return;
    }

    const state = await getState(env, chatId);
    if (state && !command) {
      await handleWizardMessage(env, chatId, textValue, state);
      return;
    }

    if (command === "/start" || command === "/help") {
      await sendMessage(env, chatId, HELP_TEXT, mainKeyboard());
    } else if (command === "/newtracker" || command === "/new") {
      await setState(env, chatId, "awaiting_from", {});
      await sendMessage(env, chatId, "Pick the departure station below, or type its name:", stationKeyboard());
    } else if (command === "/types") {
      await sendMessage(env, chatId, TYPE_HELP, mainKeyboard());
    } else if (command === "/stations") {
      const query = textValue.replace(/^\/stations(?:@\w+)?\s*/i, "").trim();
      if (!query) return sendMessage(env, chatId, "Use: /stations QUERY");
      const stations = await searchStations(env, query);
      const lines = stations.slice(0, 20).map((s) => `${escapeHtml(s.code)} - ${escapeHtml(s.name)}`);
      await sendMessage(env, chatId, lines.length ? lines.join("\n") : "No stations found.");
    } else if (command === "/track") {
      const parsed = parseTrackCommand(textValue);
      await addTrackerFromParsed(env, chatId, parsed);
    } else if (command === "/list") {
      const rows = await env.DB.prepare("SELECT * FROM trackers WHERE chat_id = ? AND active = 1 ORDER BY id").bind(chatId).all();
      if (!rows.results.length) return sendMessage(env, chatId, "No active trackers.", mainKeyboard());
      await sendMessage(env, chatId, rows.results.map(formatTracker).join("\n"), mainKeyboard());
    } else if (command === "/stop") {
      const parts = textValue.split(/\s+/);
      if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return sendMessage(env, chatId, "Use: /stop ID");
      const result = await env.DB.prepare("UPDATE trackers SET active = 0 WHERE chat_id = ? AND id = ? AND active = 1").bind(chatId, Number(parts[1])).run();
      await sendMessage(env, chatId, result.meta.changes ? "Stopped." : "Tracker not found.", mainKeyboard());
    } else if (command === "/stop_all") {
      const result = await env.DB.prepare("UPDATE trackers SET active = 0 WHERE chat_id = ? AND active = 1").bind(chatId).run();
      await sendMessage(env, chatId, `Stopped ${result.meta.changes || 0} tracker(s).`, mainKeyboard());
    } else if (state) {
      await sendMessage(env, chatId, "Continue setup by answering the current question, or use /cancel.");
    } else {
      await sendMessage(env, chatId, HELP_TEXT, mainKeyboard());
    }
  } catch (err) {
    await sendMessage(env, chatId, `Error: ${escapeHtml(err.message || String(err))}`);
  }
}

async function handleWizardMessage(env, chatId, textValue, row) {
  const data = JSON.parse(row.data_json || "{}");
  if (row.state === "awaiting_from" || row.state === "awaiting_to") {
    const isFrom = row.state === "awaiting_from";
    const picked = await pickStation(env, textValue);
    if (!picked) {
      await sendMessage(env, chatId, `No stations found for "${escapeHtml(textValue)}". Try a different spelling or tap a button:`, stationKeyboard());
      return;
    }
    if (picked.matches) {
      await sendMessage(env, chatId, "Several stations match. Tap the right one:", stationKeyboard(picked.matches.map((s) => `${s.code} - ${s.name}`)));
      return;
    }
    data[isFrom ? "fromStation" : "toStation"] = { code: String(picked.code), name: String(picked.name) };
    if (isFrom) {
      await setState(env, chatId, "awaiting_to", data);
      await sendMessage(env, chatId, `From: ${escapeHtml(picked.name)}\nNow pick the arrival station, or type its name:`, stationKeyboard());
    } else {
      await setState(env, chatId, "awaiting_dates", data);
      await sendMessage(env, chatId, `To: ${escapeHtml(picked.name)}\nSend one or more dates. Examples:\n2026-08-18\n2026-08-18, 2026-08-20\n2026-08-18..2026-08-21\ntomorrow`, dateKeyboard());
    }
    return;
  }
  if (row.state === "awaiting_dates") {
    data.dates = parseDatesSpec(textValue);
    await setState(env, chatId, "awaiting_types", data);
    await sendMessage(env, chatId, `Send ticket types separated by commas, or any.\n\n${TYPE_HELP}`, typeKeyboard());
    return;
  }
  if (row.state === "awaiting_types") {
    data.types = parseTypes(textValue);
    await addTrackerFromParsed(env, chatId, data);
    await clearState(env, chatId);
    return;
  }
  await clearState(env, chatId);
}

async function addTrackerFromParsed(env, chatId, parsed) {
  const fromStation = parsed.fromStation || (await resolveStation(env, parsed.from));
  const toStation = parsed.toStation || (await resolveStation(env, parsed.to));
  const createdAt = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO trackers (chat_id, from_name, from_code, to_name, to_code, dates_json, types_json, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).bind(
    chatId,
    fromStation.name,
    fromStation.code,
    toStation.name,
    toStation.code,
    JSON.stringify(parsed.dates),
    JSON.stringify(parsed.types || []),
    createdAt,
  ).run();
  const row = await env.DB.prepare("SELECT * FROM trackers WHERE chat_id = ? AND active = 1 ORDER BY id DESC LIMIT 1").bind(chatId).first();
  await sendMessage(env, chatId, `Tracking added:\n${formatTracker(row)}`, mainKeyboard());
}

async function checkTrackers(env) {
  const limit = Number(env.CHECK_LIMIT || DEFAULT_CHECK_LIMIT);
  const rows = await env.DB.prepare("SELECT * FROM trackers WHERE active = 1 ORDER BY COALESCE(last_checked_at, '') ASC, id ASC LIMIT ?").bind(limit).all();
  if (!rows.results.length) return;

  const session = await createEticketSession(env);
  for (const row of rows.results) {
    try {
      const dates = trackerDates(row);
      const types = trackerTypes(row);
      const byDate = new Map();
      for (const travelDate of dates) {
        const trains = await findTrains(env, session, row.from_code, row.to_code, travelDate);
        const matches = collectAvailability(trains, types);
        const unseen = [];
        for (const match of matches) {
          const inserted = await markAlertSeen(env, row.id, travelDate, match.key);
          if (inserted) unseen.push(match);
        }
        if (unseen.length) byDate.set(travelDate, unseen);
      }
      for (const [travelDate, matches] of byDate) {
        await sendMessage(env, row.chat_id, formatAlert(row, travelDate, matches));
      }
      await env.DB.prepare("UPDATE trackers SET last_checked_at = ?, last_error = NULL WHERE id = ?").bind(new Date().toISOString(), row.id).run();
    } catch (err) {
      const message = String(err.message || err).slice(0, 500);
      if (message !== row.last_error) {
        await sendMessage(env, row.chat_id, `Tracker #${row.id} error: ${escapeHtml(message)}`);
      }
      await env.DB.prepare("UPDATE trackers SET last_checked_at = ?, last_error = ? WHERE id = ?").bind(new Date().toISOString(), message, row.id).run();
    }
  }
}

async function createEticketSession(env) {
  const siteUrl = env.ETICKET_SITE_URL || DEFAULT_SITE_URL;
  const res = await fetch(`${siteUrl}/api/v1/csrf-token`, {
    headers: {
      Accept: "application/json",
      "Accept-Language": env.ETICKET_LANGUAGE || "ru",
      "device-type": "BROWSER",
      "User-Agent": "tickettracker-worker/1.0",
    },
  });
  const setCookie = getSetCookieHeaders(res.headers);
  const cookies = parseSetCookies(setCookie);
  const xsrf = cookies.get("XSRF-TOKEN");
  if (!xsrf) throw new Error("eticket did not return XSRF-TOKEN");
  const cookie = Array.from(cookies.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
  return { xsrf, cookie };
}

async function eticketPost(env, session, path, payload, extraHeaders = {}) {
  const siteUrl = env.ETICKET_SITE_URL || DEFAULT_SITE_URL;
  const res = await fetch(`${siteUrl}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Language": env.ETICKET_LANGUAGE || "ru",
      "Content-Type": "application/json",
      "device-type": "BROWSER",
      "User-Agent": "tickettracker-worker/1.0",
      "X-XSRF-TOKEN": session.xsrf,
      Cookie: session.cookie,
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
  const textValue = await res.text();
  if (!res.ok) throw new Error(`eticket ${res.status}: ${textValue.slice(0, 300)}`);
  return JSON.parse(textValue);
}

async function searchStations(env, name) {
  const session = await createEticketSession(env);
  const result = await eticketPost(env, session, "/api/v1/handbook/stations/list", { name });
  if (result.error) throw new Error(`station lookup failed: ${JSON.stringify(result.error)}`);
  return result.data?.stations || [];
}

async function resolveStation(env, value) {
  const cleaned = String(value || "").trim();
  if (/^\d{7}$/.test(cleaned)) return { code: cleaned, name: cleaned };
  const stations = await searchStations(env, cleaned);
  if (!stations.length) throw new Error(`station not found: ${cleaned}`);
  return stations[0];
}

// Wizard station picking: returns a station {code, name}, {matches: [...]}
// when the input is ambiguous, or null when nothing matches.
async function pickStation(env, value) {
  const cleaned = String(value || "").trim();
  const buttonMatch = cleaned.match(/^(\d{7})\s*-\s*(.+)$/);
  if (buttonMatch) return { code: buttonMatch[1], name: buttonMatch[2].trim() };
  if (/^\d{7}$/.test(cleaned)) return { code: cleaned, name: cleaned };
  const stations = await searchStations(env, cleaned);
  if (!stations.length) return null;
  if (stations.length === 1) return stations[0];
  return { matches: stations.slice(0, 12) };
}

async function findTrains(env, session, fromCode, toCode, travelDate) {
  const result = await eticketPost(env, session, "/api/v3/handbook/trains/list", {
    directions: {
      forward: {
        date: travelDate,
        depStationCode: fromCode,
        arvStationCode: toCode,
      },
    },
  }, { "X-Custom-Language": env.ETICKET_LANGUAGE || "ru" });
  if (result.error) throw new Error(`train lookup failed: ${JSON.stringify(result.error)}`);
  return result.data?.directions?.forward?.trains || [];
}

function collectAvailability(trains, wantedTypes) {
  const normalized = (wantedTypes || []).filter(Boolean).map(canonicalCarType);
  const matches = [];
  for (const train of trains || []) {
    for (const car of train.cars || []) {
      const carType = String(car.type || "");
      if (normalized.length && !normalized.includes(canonicalCarType(carType))) continue;
      const freeSeats = Number(car.freeSeats || 0);
      if (freeSeats <= 0) continue;
      matches.push({
        trainNumber: String(train.number || ""),
        brand: String(train.brand || ""),
        departure: String(train.departureDate || ""),
        arrival: String(train.arrivalDate || ""),
        carType,
        freeSeats,
        tariffs: car.tariffs || [],
        comment: train.comment || "",
        key: `${train.number || ""}|${train.departureDate || ""}|${carType}`,
      });
    }
  }
  return matches;
}

async function markAlertSeen(env, trackerId, travelDate, fingerprint) {
  try {
    await env.DB.prepare("INSERT INTO alerts (tracker_id, travel_date, fingerprint, first_seen_at) VALUES (?, ?, ?, ?)")
      .bind(trackerId, travelDate, fingerprint, new Date().toISOString())
      .run();
    return true;
  } catch (err) {
    if (String(err.message || err).includes("UNIQUE")) return false;
    throw err;
  }
}

function parseTrackCommand(textValue) {
  const body = textValue.replace(/^\/track(?:@\w+)?\s*/i, "").trim();
  if (!body) throw new Error("use /newtracker for guided setup, or /track FROM -> TO ...");
  const args = splitArgs(body);
  const bodyWithoutArgs = body.replace(/\s+\w+=("[^"]+"|'[^']+'|\S+)/g, "").trim();
  let left;
  let right;
  if (bodyWithoutArgs.includes("->")) {
    [left, right] = bodyWithoutArgs.split("->", 2);
  } else {
    const parts = bodyWithoutArgs.split(/\s+to\s+/i);
    if (parts.length < 2) throw new Error("use: /track FROM -> TO [DATE] [days=N] [dates=D1,D2] [types=...]");
    left = parts[0];
    right = parts.slice(1).join(" to ");
  }
  const from = left.trim();
  const rightParts = right.trim().split(/\s+/).filter(Boolean);
  if (!from || !rightParts.length) throw new Error("both FROM and TO are required");

  let dates;
  if (args.dates) {
    dates = parseDatesSpec(args.dates);
  } else {
    let baseDate = todayIso();
    const last = rightParts[rightParts.length - 1];
    if (args.date) {
      baseDate = parseDateToken(args.date);
    } else {
      try {
        baseDate = parseDateToken(last);
        rightParts.pop();
      } catch (_err) {}
    }
    const days = clamp(Number(args.days || 1), 1, MAX_TRACK_DATES);
    dates = Array.from({ length: days }, (_, index) => addDays(baseDate, index));
  }

  const to = rightParts.join(" ").trim();
  if (!to) throw new Error("TO station is required");
  return { from, to, dates, types: parseTypes(args.types || "") };
}

function splitArgs(textValue) {
  const args = {};
  for (const match of textValue.matchAll(/(\w+)=("[^"]+"|'[^']+'|\S+)/g)) {
    args[match[1].toLowerCase()] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return args;
}

function parseDatesSpec(value) {
  const dates = new Set();
  for (const raw of String(value || "").split(/[,;]/)) {
    const token = raw.trim();
    if (!token) continue;
    if (token.includes("..")) {
      const [left, right] = token.split("..", 2);
      const start = parseDateToken(left);
      const end = parseDateToken(right);
      if (end < start) throw new Error("date range end must be after start");
      let current = start;
      while (current <= end) {
        dates.add(current);
        current = addDays(current, 1);
      }
    } else {
      dates.add(parseDateToken(token));
    }
  }
  const result = Array.from(dates).sort();
  if (!result.length) throw new Error("at least one date is required");
  if (result.length > MAX_TRACK_DATES) throw new Error(`track at most ${MAX_TRACK_DATES} dates per tracker`);
  return result;
}

function parseDateToken(value) {
  const token = String(value || "").trim().toLowerCase();
  if (token === "today") return todayIso();
  if (token === "tomorrow") return addDays(todayIso(), 1);
  const iso = token.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dotted = token.match(/^(\d{2})[.-](\d{2})[.-](\d{4})$/);
  if (dotted) return `${dotted[3]}-${dotted[2]}-${dotted[1]}`;
  throw new Error("date must be YYYY-MM-DD, DD.MM.YYYY, DD-MM-YYYY, today, or tomorrow");
}

function parseTypes(value) {
  const normalized = normalizeType(value || "");
  if (!normalized || ["any", "all", "любые", "hammasi"].includes(normalized)) return [];
  return String(value).split(/[,;]/).map((item) => item.trim()).filter(Boolean);
}

function trackerTypes(row) {
  return JSON.parse(row.types_json || "[]");
}

function trackerDates(row) {
  return JSON.parse(row.dates_json || "[]");
}

function formatTracker(row) {
  const dates = trackerDates(row);
  const types = trackerTypes(row);
  return `#${row.id} ${escapeHtml(row.from_name)} -> ${escapeHtml(row.to_name)} dates: ${escapeHtml(formatDates(dates))}, types: ${escapeHtml(types.join(", ") || "any")}`;
}

function formatDates(dates) {
  if (dates.length === 1) return dates[0];
  const contiguous = dates.every((value, index) => value === addDays(dates[0], index));
  if (contiguous) return `${dates[0]}..${dates[dates.length - 1]}`;
  return dates.join(", ");
}

function formatAlert(row, travelDate, matches) {
  const lines = [
    "Tickets available",
    `${escapeHtml(row.from_name)} -> ${escapeHtml(row.to_name)}`,
    `Date: ${travelDate}`,
    "",
  ];
  for (const item of matches.slice(0, 12)) {
    const tariffs = (item.tariffs || []).slice(0, 4).map((tariff) => {
      let textValue = String(tariff.classServiceType || "class");
      if (tariff.freeSeats !== undefined) textValue += `: ${tariff.freeSeats} seats`;
      if (tariff.tariff !== undefined) textValue += `, ${tariff.tariff} UZS`;
      return textValue;
    });
    lines.push(`${escapeHtml(item.trainNumber)} ${escapeHtml(item.brand)} | ${escapeHtml(item.departure)} -> ${escapeHtml(item.arrival)}`);
    lines.push(`${escapeHtml(item.carType)}: ${item.freeSeats} free`);
    if (tariffs.length) lines.push(escapeHtml(tariffs.join("; ")));
    if (item.comment) lines.push(escapeHtml(item.comment));
    lines.push("");
  }
  if (matches.length > 12) lines.push(`...and ${matches.length - 12} more matches.`);
  return lines.join("\n").trim();
}

async function getState(env, chatId) {
  return env.DB.prepare("SELECT * FROM user_states WHERE chat_id = ?").bind(chatId).first();
}

async function setState(env, chatId, state, data) {
  await env.DB.prepare(`
    INSERT INTO user_states (chat_id, state, data_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET state = excluded.state, data_json = excluded.data_json, updated_at = excluded.updated_at
  `).bind(chatId, state, JSON.stringify(data), new Date().toISOString()).run();
}

async function clearState(env, chatId) {
  await env.DB.prepare("DELETE FROM user_states WHERE chat_id = ?").bind(chatId).run();
}

async function telegramApi(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Telegram ${method} API error:`, JSON.stringify(data));
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  }
  return data.result;
}

async function sendMessage(env, chatId, textValue, replyMarkup) {
  return telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: textValue,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function mainKeyboard() {
  return { keyboard: [[{ text: "/newtracker" }, { text: "/list" }], [{ text: "/types" }, { text: "/cancel" }]], resize_keyboard: true };
}

function stationKeyboard(labels) {
  const buttons = labels && labels.length ? labels : POPULAR_STATIONS;
  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2).map((label) => ({ text: label })));
  }
  rows.push([{ text: "/cancel" }]);
  return { keyboard: rows, resize_keyboard: true };
}

function dateKeyboard() {
  return {
    keyboard: [[{ text: "today" }, { text: "tomorrow" }], [{ text: "/cancel" }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

function typeKeyboard() {
  return {
    keyboard: [[{ text: "any" }], [{ text: "O'rindiqli,Kupe" }], [{ text: "Kupe,Plaskartli,SV" }], [{ text: "/cancel" }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

function canonicalCarType(value) {
  const normalized = normalizeType(value);
  for (const [canonical, aliases] of Object.entries(CAR_TYPE_ALIASES)) {
    if (aliases.has(normalized)) return canonical;
  }
  return normalized;
}

function normalizeType(value) {
  return String(value || "").trim().toLowerCase().replace(/[ʼ‘`]/g, "'").replace(/\s+/g, " ");
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const value = new Date(`${isoDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

function parseSetCookies(headers) {
  const cookies = new Map();
  for (const header of headers) {
    for (const segment of splitCombinedSetCookie(header)) {
      const pair = segment.split(";", 1)[0].trim();
      const index = pair.indexOf("=");
      if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
  return cookies;
}

function splitCombinedSetCookie(value) {
  const input = String(value || "");
  const parts = [];
  let start = 0;
  let inExpires = false;
  for (let index = 0; index < input.length; index++) {
    const tail = input.slice(index).toLowerCase();
    if (tail.startsWith("expires=")) inExpires = true;
    if (inExpires && input[index] === ";") inExpires = false;
    if (!inExpires && input[index] === ",") {
      const rest = input.slice(index + 1);
      if (/^\s*[^=;,\s]+=/.test(rest)) {
        parts.push(input.slice(start, index).trim());
        start = index + 1;
      }
    }
  }
  parts.push(input.slice(start).trim());
  return parts.filter(Boolean);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function text(value, status = 200) {
  return new Response(value, { status, headers: { "Content-Type": "text/plain;charset=utf-8" } });
}
