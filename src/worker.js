const DEFAULT_SITE_URL = "https://eticket.railway.uz";
const MAX_TRACK_DATES = 30;
const DEFAULT_CHECK_LIMIT = 20;
const ERROR_NOTIFY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const ALERT_REFRESH_MS = 24 * 60 * 60 * 1000;

const HELP_TEXT = `🚂 <b>Ticket Tracker</b>

I watch <b>eticket.railway.uz</b> and message you when matching train tickets appear.

<b>Commands</b>
/newtracker — create a tracker (guided step by step)
/list — your trackers (edit/delete via buttons)
/track — quick create:
<code>/track Tashkent -> Samarkand 2026-08-18 days=3 types=Kupe,SV</code>
/stations QUERY — find station codes
/types — common ticket type names
/stop ID — pause a tracker
/stop_all — pause all trackers
/cancel — cancel current setup

Notifications update in place — no spam.
Tap 🔄 Refresh on any alert to re-check instantly.`;

const TYPE_HELP = `<b>Ticket types you can filter on:</b>

🪑 O'rindiqli / Сидячий / seated
🛏 Kupe / Купе / coupe
🛋 Plaskartli / Плацкартный / platskart
👑 SV / СВ

Separate multiple types with commas, or type <b>any</b> for all.`;

const POPULAR_STATIONS = [
  "Toshkent", "Samarqand", "Buxoro", "Urgench",
  "Nukus", "Xiva", "Фергана", "Andijon",
  "Namangan", "Qarshi", "Termiz", "Navoiy",
  "Jizzax", "Guliston", "Margilan", "Kungrad",
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
  if (update.callback_query) {
    try {
      await handleCallback(update.callback_query, env);
      console.log("callback handled:", update.callback_query.data);
    } catch (err) {
      console.error("handleCallback failed:", (err && err.stack) || String(err));
    }
    return json({ ok: true });
  }
  try {
    await handleUpdate(update, env);
    console.log("update handled:", update.message && update.message.text);
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
    allowed_updates: JSON.stringify(["message", "callback_query"]),
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
      await sendMessage(env, chatId, "Cancelled.", mainKeyboard());
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
      const lines = stations.slice(0, 20).map((s) => `${escapeHtml(s.code)} — ${escapeHtml(s.name)}`);
      await sendMessage(env, chatId, lines.length ? `📍 <b>Stations matching "${escapeHtml(query)}"</b>\n\n` + lines.join("\n") : "No stations found.", mainKeyboard());
    } else if (command === "/track") {
      const parsed = parseTrackCommand(textValue);
      await addTrackerFromParsed(env, chatId, parsed);
    } else if (command === "/list") {
      await sendTrackerList(env, chatId);
    } else if (command === "/stop") {
      const parts = textValue.split(/\s+/);
      if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return sendMessage(env, chatId, "Use: /stop ID");
      const result = await env.DB.prepare("UPDATE trackers SET active = 0 WHERE chat_id = ? AND id = ? AND active = 1").bind(chatId, Number(parts[1])).run();
      await sendMessage(env, chatId, result.meta.changes ? `⏸ Tracker #${parts[1]} paused.` : "Tracker not found.", mainKeyboard());
    } else if (command === "/stop_all") {
      const result = await env.DB.prepare("UPDATE trackers SET active = 0 WHERE chat_id = ? AND active = 1").bind(chatId).run();
      await sendMessage(env, chatId, `⏸ Paused ${result.meta.changes || 0} tracker(s).`, mainKeyboard());
    } else if (state) {
      await sendMessage(env, chatId, "Continue by answering the current step, or /cancel to abort.", stateKeyboard());
    } else {
      await sendMessage(env, chatId, HELP_TEXT, mainKeyboard());
    }
  } catch (err) {
    await sendMessage(env, chatId, `⚠️ ${escapeHtml(err.message || String(err))}`);
  }
}

async function handleWizardMessage(env, chatId, textValue, row) {
  const data = JSON.parse(row.data_json || "{}");
  if (row.state === "awaiting_from" || row.state === "awaiting_to") {
    const isFrom = row.state === "awaiting_from";
    const excludeLabel = isFrom ? null : data.fromLabel;
    const picked = await pickStation(env, textValue);
    if (!picked) {
      await sendMessage(env, chatId, `❌ No stations found for "${escapeHtml(textValue)}". Try another spelling or tap a button:`, stationKeyboard(null, excludeLabel));
      return;
    }
    if (picked.matches) {
      let matches = picked.matches;
      if (!isFrom && data.fromStation) matches = matches.filter((s) => String(s.code) !== String(data.fromStation.code));
      if (!matches.length) {
        await sendMessage(env, chatId, "That only matches the departure station. Pick a different arrival:", stationKeyboard(null, excludeLabel));
        return;
      }
      await sendMessage(env, chatId, "Several stations match — tap the right one:", stationKeyboard(matches.map((s) => `${s.code} - ${s.name}`)));
      return;
    }
    if (!isFrom && data.fromStation && String(picked.code) === String(data.fromStation.code)) {
      await sendMessage(env, chatId, "⚠️ Arrival can't be the same as departure. Pick a different station:", stationKeyboard(null, excludeLabel));
      return;
    }
    data[isFrom ? "fromStation" : "toStation"] = { code: String(picked.code), name: String(picked.name) };
    if (isFrom) {
      data.fromLabel = textValue.trim();
      await setState(env, chatId, "awaiting_to", data);
      await sendMessage(env, chatId, `✅ From: <b>${escapeHtml(picked.name)}</b>\n\nNow pick the arrival station:`, stationKeyboard(null, data.fromLabel));
    } else {
      await setState(env, chatId, "awaiting_dates", data);
      await sendMessage(env, chatId, `✅ To: <b>${escapeHtml(picked.name)}</b>\n\nSend one or more dates:`, dateKeyboard());
    }
    return;
  }
  if (row.state === "awaiting_dates") {
    data.dates = parseDatesSpec(textValue);
    await setState(env, chatId, "awaiting_types", data);
    await sendMessage(env, chatId, `✅ Dates: <b>${escapeHtml(formatDates(data.dates))}</b>\n\nSend ticket types separated by commas, or <b>any</b> for all:`, typeKeyboard());
    return;
  }
  if (row.state === "awaiting_types") {
    data.types = parseTypes(textValue);
    await addTrackerFromParsed(env, chatId, data);
    await clearState(env, chatId);
    return;
  }
  if (row.state === "awaiting_edit_dates") {
    const trackerId = Number(data.trackerId);
    const tracker = await env.DB.prepare("SELECT * FROM trackers WHERE id = ? AND chat_id = ?").bind(trackerId, chatId).first();
    if (!tracker) { await clearState(env, chatId); return sendMessage(env, chatId, "⚠️ Tracker not found.", mainKeyboard()); }
    const dates = parseDatesSpec(textValue);
    await env.DB.prepare("UPDATE trackers SET dates_json = ?, active = 1, archived = 0 WHERE id = ?").bind(JSON.stringify(dates), trackerId).run();
    const updated = await env.DB.prepare("SELECT * FROM trackers WHERE id = ?").bind(trackerId).first();
    await clearState(env, chatId);
    await sendMessage(env, chatId, `✅ Dates updated!\n\n${formatTracker(updated)}`, mainKeyboard());
    return;
  }
  if (row.state === "awaiting_edit_types") {
    const trackerId = Number(data.trackerId);
    const tracker = await env.DB.prepare("SELECT * FROM trackers WHERE id = ? AND chat_id = ?").bind(trackerId, chatId).first();
    if (!tracker) { await clearState(env, chatId); return sendMessage(env, chatId, "⚠️ Tracker not found.", mainKeyboard()); }
    const types = parseTypes(textValue);
    await env.DB.prepare("UPDATE trackers SET types_json = ? WHERE id = ?").bind(JSON.stringify(types), trackerId).run();
    const updated = await env.DB.prepare("SELECT * FROM trackers WHERE id = ?").bind(trackerId).first();
    await clearState(env, chatId);
    await sendMessage(env, chatId, `✅ Types updated!\n\n${formatTracker(updated)}`, mainKeyboard());
    return;
  }
  await clearState(env, chatId);
}

async function handleCallback(cb, env) {
  const chatId = String(cb.message.chat.id);
  const messageId = cb.message.message_id;
  const [action, a1, a2] = String(cb.data || "").split("|");

  try {
    if (action === "v") {
      await refreshAlert(env, cb, chatId, Number(a1));
      return;
    }
    if (action === "d") {
      const result = await env.DB.prepare("DELETE FROM trackers WHERE id = ? AND chat_id = ?").bind(Number(a1), chatId).run();
      await env.DB.prepare("DELETE FROM alert_messages WHERE tracker_id = ?").bind(Number(a1)).run();
      await answerCallback(env, cb.id, result.meta.changes ? `🗑 Tracker #${a1} deleted` : "Not found");
      await sendTrackerList(env, chatId, messageId);
      return;
    }
    if (action === "e") {
      await answerCallback(env, cb.id);
      await editMessage(env, chatId, messageId, `✏️ <b>Edit tracker #${a1}</b>\nWhat would you like to change?`, {
        inline_keyboard: [[{ text: "📅 Dates", callback_data: `ed|${a1}` }, { text: "🎫 Types", callback_data: `et|${a1}` }], [{ text: "⬅️ Back", callback_data: "l" }]],
      });
      return;
    }
    if (action === "ed" || action === "et") {
      const tracker = await env.DB.prepare("SELECT * FROM trackers WHERE id = ? AND chat_id = ?").bind(Number(a1), chatId).first();
      if (!tracker) { await answerCallback(env, cb.id, "Tracker not found"); return; }
      if (action === "ed") {
        await setState(env, chatId, "awaiting_edit_dates", { trackerId: tracker.id });
        await answerCallback(env, cb.id);
        await sendMessage(env, chatId, `📅 Send the new dates for tracker <b>#${tracker.id}</b>.\n\nExamples:\n2026-08-18\n2026-08-18, 2026-08-20\n2026-08-18..2026-08-21\ntomorrow`, dateKeyboard());
      } else {
        await setState(env, chatId, "awaiting_edit_types", { trackerId: tracker.id });
        await answerCallback(env, cb.id);
        await sendMessage(env, chatId, `🎫 Send the new ticket types for tracker <b>#${tracker.id}</b>, or <b>any</b>.\n\n${TYPE_HELP}`, typeKeyboard());
      }
      return;
    }
    if (action === "l") {
      await answerCallback(env, cb.id);
      await sendTrackerList(env, chatId, messageId);
      return;
    }
    await answerCallback(env, cb.id);
  } catch (err) {
    console.error("callback failed:", (err && err.stack) || String(err));
    await answerCallback(env, cb.id, `⚠️ ${String(err.message || err).slice(0, 150)}`).catch(() => {});
  }
}

async function sendTrackerList(env, chatId, editMessageId) {
  const rows = await env.DB.prepare("SELECT * FROM trackers WHERE chat_id = ? ORDER BY archived ASC, active DESC, id ASC").bind(chatId).all();
  const all = rows.results;
  const active = all.filter((r) => r.active && !r.archived);
  const paused = all.filter((r) => !r.active && !r.archived);
  const archived = all.filter((r) => r.archived);

  if (!all.length) {
    const msg = "📋 No trackers yet.\nTap /newtracker to create one.";
    if (editMessageId) return editMessage(env, chatId, editMessageId, msg);
    return sendMessage(env, chatId, msg, mainKeyboard());
  }

  const parts = ["📋 <b>Your Trackers</b>"];
  if (active.length) {
    parts.push("\n<b>🟢 Active</b>", active.map((r) => formatTracker(r)).join("\n\n"));
  }
  if (paused.length) {
    parts.push("\n<b>⏸ Paused</b>", paused.map((r) => formatTracker(r)).join("\n\n"));
  }
  if (archived.length) {
    parts.push("\n<b>🗄 Archived</b>", archived.map((r) => formatTracker(r)).join("\n\n"));
  }

  const keyboard = active.map((r) => ([
    { text: `🔍 View #${r.id}`, callback_data: `v|${r.id}` },
    { text: `✏️ Edit #${r.id}`, callback_data: `e|${r.id}` },
    { text: `🗑 Delete #${r.id}`, callback_data: `d|${r.id}` },
  ]));

  const markup = keyboard.length ? { inline_keyboard: keyboard } : undefined;
  const msg = parts.join("\n");
  if (editMessageId) return editMessage(env, chatId, editMessageId, msg, markup);
  return sendMessage(env, chatId, msg, markup);
}

async function refreshAlert(env, cb, chatId, trackerId) {
  const tracker = await env.DB.prepare("SELECT * FROM trackers WHERE id = ? AND chat_id = ?").bind(trackerId, chatId).first();
  if (!tracker) return answerCallback(env, cb.id, "⚠️ Tracker not found");
  if (tracker.archived) return answerCallback(env, cb.id, "🗄 Tracker is archived");
  const session = await createEticketSession(env);
  const dates = trackerDates(tracker);
  const types = trackerTypes(tracker);
  const rendered = await renderConsolidated(env, session, tracker, dates, types);
  const hasTickets = rendered.fingerprint.length > 0;
  const stored = await env.DB.prepare("SELECT * FROM alert_messages WHERE tracker_id = ? AND travel_date = ''").bind(trackerId).first();
  if (stored && stored.content === rendered.text) {
    await answerCallback(env, cb.id, "✅ Already up to date");
    return;
  }
  try {
    await editMessage(env, chatId, cb.message.message_id, rendered.text, refreshKeyboard(trackerId));
  } catch (editErr) {
    if (/not modified/i.test(editErr.message)) { await answerCallback(env, cb.id, "✅ Already up to date"); return; }
    throw editErr;
  }
  await saveAlertMessage(env, trackerId, "", cb.message.message_id, rendered, hasTickets);
  await answerCallback(env, cb.id, hasTickets ? "✅ Updated — tickets available" : "✅ Updated — no tickets right now");
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
  await sendMessage(env, chatId, `✅ Tracker added!\n\n${formatTracker(row)}`, mainKeyboard());
}

async function checkTrackers(env) {
  const nowIso = new Date().toISOString();
  const today = todayIso();

  await env.DB.prepare("UPDATE trackers SET archived = 1, active = 0 WHERE archived = 0 AND active = 1 AND (SELECT MAX(value) FROM json_each(trackers.dates_json)) < ?").bind(today).run();

  const limit = Number(env.CHECK_LIMIT || DEFAULT_CHECK_LIMIT);
  const rows = await env.DB.prepare("SELECT * FROM trackers WHERE active = 1 AND archived = 0 ORDER BY COALESCE(last_checked_at, '') ASC, id ASC LIMIT ?").bind(limit).all();
  if (!rows.results.length) return;

  const session = await createEticketSession(env);
  for (const row of rows.results) {
    try {
      const dates = trackerDates(row);
      const types = trackerTypes(row);
      const rendered = await renderConsolidated(env, session, row, dates, types);
      const hasTickets = rendered.fingerprint.length > 0;
      const stored = await env.DB.prepare("SELECT * FROM alert_messages WHERE tracker_id = ? AND travel_date = ''").bind(row.id).first();
      const prevHadTickets = stored ? Boolean(stored.has_tickets) : null;
      if (prevHadTickets === null) {
        try {
          const sent = await sendMessage(env, row.chat_id, rendered.text, refreshKeyboard(row.id));
          await saveAlertMessage(env, row.id, "", sent.message_id, rendered, hasTickets);
        } catch (sendErr) {
          console.error("first alert send failed:", sendErr.message);
        }
      } else if (prevHadTickets !== hasTickets) {
        try {
          const sent = await sendMessage(env, row.chat_id, rendered.text, refreshKeyboard(row.id));
          await saveAlertMessage(env, row.id, "", sent.message_id, rendered, hasTickets);
        } catch (sendErr) {
          console.error("status change notify failed:", sendErr.message);
        }
      }
      await env.DB.prepare("UPDATE trackers SET last_checked_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ?").bind(nowIso, row.id).run();
    } catch (err) {
      const message = String(err.message || err).slice(0, 500);
      const maintenance = /техническ|technical break|eticket 424/i.test(message);
      if (maintenance) {
        await env.DB.prepare("UPDATE trackers SET last_checked_at = ? WHERE id = ?").bind(nowIso, row.id).run();
      } else {
        const lastAt = row.last_error_at ? Date.parse(row.last_error_at) : 0;
        if (!lastAt || Date.now() - lastAt > ERROR_NOTIFY_COOLDOWN_MS) {
          await sendMessage(env, row.chat_id, `⚠️ <b>Tracker #${row.id}</b>\n${escapeHtml(prettifyError(message))}`);
          await env.DB.prepare("UPDATE trackers SET last_checked_at = ?, last_error = ?, last_error_at = ? WHERE id = ?").bind(nowIso, message, nowIso, row.id).run();
        } else {
          await env.DB.prepare("UPDATE trackers SET last_checked_at = ?, last_error = ? WHERE id = ?").bind(nowIso, message, row.id).run();
        }
      }
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
  if (!textValue) return null;
  return JSON.parse(textValue);
}

async function searchStations(env, name) {
  const session = await createEticketSession(env);
  const result = await eticketPost(env, session, "/api/v1/handbook/stations/list", { name });
  if (!result) return [];
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
  if (!result) return [];
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
  const statusIcon = row.archived ? "🗄" : row.active ? "🟢" : "⏸";
  return `${statusIcon} <b>#${row.id}</b> ${escapeHtml(row.from_name)} → ${escapeHtml(row.to_name)}\n📅 ${escapeHtml(formatDates(dates))}  🪑 ${escapeHtml(types.join(", ") || "any")}`;
}

function formatDates(dates) {
  if (dates.length === 1) return dates[0];
  const contiguous = dates.every((value, index) => value === addDays(dates[0], index));
  if (contiguous) return `${dates[0]}..${dates[dates.length - 1]}`;
  return dates.join(", ");
}

function renderAlert(row, travelDate, matches) {
  const fingerprint = matches.map((m) => `${m.key}#${m.freeSeats}`).join(";");
  const stamp = new Date().toISOString().slice(11, 16);
  const header = matches.length ? "🟢 <b>Tickets available</b>" : "🔴 <b>No tickets right now</b>";
  const lines = [header, `🚂 ${escapeHtml(row.from_name)} → ${escapeHtml(row.to_name)}`, `📅 ${travelDate}`, ""];

  for (const item of matches.slice(0, 10)) {
    const tariffLines = (item.tariffs || []).slice(0, 3).map((t) => {
      let s = String(t.classServiceType || "class");
      if (t.freeSeats !== undefined) s += `: ${t.freeSeats}`;
      if (t.tariff !== undefined && Number.isFinite(Number(t.tariff))) s += ` • ${Number(t.tariff).toLocaleString("en-US")} UZS`;
      return s;
    });
    lines.push(`<b>${escapeHtml(item.trainNumber)}</b>${item.brand ? ` • ${escapeHtml(item.brand)}` : ""}`);
    lines.push(`🪑 ${escapeHtml(item.carType)} — <b>${item.freeSeats}</b> free`);
    if (tariffLines.length) lines.push(`💰 ${escapeHtml(tariffLines.join("  ·  "))}`);
    if (item.comment) lines.push(escapeHtml(item.comment));
    lines.push("");
  }
  if (matches.length > 10) lines.push(`…and ${matches.length - 10} more`, "");
  lines.push(`🔄 Updated ${stamp} UTC · Tracker #${row.id}`);
  const text = lines.join("\n").trim();
  return { text, fingerprint };
}

async function renderConsolidated(env, session, tracker, dates, types) {
  const sections = [];
  let totalMatches = 0;
  const byDate = new Map();
  for (const travelDate of dates) {
    const trains = await findTrains(env, session, tracker.from_code, tracker.to_code, travelDate);
    const matches = collectAvailability(trains, types);
    if (matches.length) byDate.set(travelDate, matches);
    totalMatches += matches.length;
  }
  const stamp = new Date().toISOString().slice(11, 16);
  const header = totalMatches ? "🟢 <b>Tickets available</b>" : "🔴 <b>No tickets right now</b>";
  sections.push(header, `🚂 ${escapeHtml(tracker.from_name)} → ${escapeHtml(tracker.to_name)}`, "");
  for (const travelDate of dates) {
    const matches = byDate.get(travelDate);
    sections.push(`<b>📅 ${travelDate}</b>`);
    if (!matches) {
      sections.push("  ❌ No tickets", "");
      continue;
    }
    for (const item of matches.slice(0, 8)) {
      const tariffLines = (item.tariffs || []).slice(0, 3).map((t) => {
        let s = String(t.classServiceType || "class");
        if (t.freeSeats !== undefined) s += `: ${t.freeSeats}`;
        if (t.tariff !== undefined && Number.isFinite(Number(t.tariff))) s += ` • ${Number(t.tariff).toLocaleString("en-US")} UZS`;
        return s;
      });
      sections.push(`  <b>${escapeHtml(item.trainNumber)}</b>${item.brand ? ` • ${escapeHtml(item.brand)}` : ""}`);
      sections.push(`  🪑 ${escapeHtml(item.carType)} — <b>${item.freeSeats}</b> free`);
      if (tariffLines.length) sections.push(`  💰 ${escapeHtml(tariffLines.join("  ·  "))}`);
    }
    if (matches.length > 8) sections.push(`  …and ${matches.length - 8} more`);
    sections.push("");
  }
  sections.push(`🔄 Updated ${stamp} UTC · Tracker #${tracker.id}`);
  const fingerprint = dates.map((d) => {
    const m = byDate.get(d);
    return m ? m.map((x) => `${x.key}#${x.freeSeats}`).join(";") : "";
  }).join("|");
  const text = sections.join("\n").trim();
  return { text, fingerprint };
}

function prettifyError(message) {
  const jsonStart = message.indexOf("{");
  if (jsonStart > 0) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart));
      if (parsed.messageEn) return `Eticket maintenance (${parsed.startTime}–${parsed.endTime})`;
      if (parsed.error) return `Eticket error: ${JSON.stringify(parsed.error).slice(0, 200)}`;
    } catch (_err) {}
  }
  return message;
}

function shortTime(value) {
  const m = String(value || "").match(/(\d{2}:\d{2})/);
  return m ? m[1] : String(value || "");
}

async function saveAlertMessage(env, trackerId, travelDate, messageId, rendered, hasTickets) {
  await env.DB.prepare(`
    INSERT INTO alert_messages (tracker_id, travel_date, message_id, fingerprint, content, updated_at, has_tickets)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tracker_id, travel_date) DO UPDATE SET message_id = excluded.message_id, fingerprint = excluded.fingerprint, content = excluded.content, updated_at = excluded.updated_at, has_tickets = excluded.has_tickets
  `).bind(trackerId, travelDate, messageId, rendered.fingerprint, rendered.text, new Date().toISOString(), hasTickets ? 1 : 0).run();
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

async function editMessage(env, chatId, messageId, textValue, replyMarkup) {
  return telegramApi(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: textValue,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function answerCallback(env, callbackId, textValue) {
  return telegramApi(env, "answerCallbackQuery", {
    callback_query_id: callbackId,
    ...(textValue ? { text: textValue, show_alert: false } : {}),
  });
}

function refreshKeyboard(trackerId, travelDate) {
  return { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `v|${trackerId}` }]] };
}

function mainKeyboard() {
  return { keyboard: [[{ text: "/newtracker" }, { text: "/list" }], [{ text: "/types" }, { text: "/cancel" }]], resize_keyboard: true };
}

function stateKeyboard() {
  return { keyboard: [[{ text: "/cancel" }]], resize_keyboard: true, one_time_keyboard: true };
}

function stationKeyboard(labels, excludeLabel) {
  let buttons = labels && labels.length ? labels : POPULAR_STATIONS;
  if (excludeLabel) {
    const excluded = normalizeType(excludeLabel);
    buttons = buttons.filter((label) => normalizeType(label) !== excluded);
  }
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
  return String(value || "").trim().toLowerCase().replace(/[ʼ'`]/g, "'").replace(/\s+/g, " ");
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
