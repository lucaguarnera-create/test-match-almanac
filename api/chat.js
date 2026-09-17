const fs = require("fs");
const path = require("path");

const MATCHES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "matches.json"), "utf8")
);

const TEAMS = ["England", "France", "Ireland", "Scotland", "Wales", "Italy", "Argentina", "Australia", "New Zealand", "South Africa"];
const CATEGORIES = ["Six Nations", "Rugby Championship", "Rugby World Cup", "Tour match", "Autumn internationals", "Other test match"];

const MODEL = "gemini-3.5-flash-lite";
const API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

const SYSTEM_PROMPT = `You are the data assistant embedded in "Test Match Almanac", a dashboard of international rugby test match results.

Dataset: ${MATCHES.length} matches among rugby's ten tier-one nations (${TEAMS.join(", ")}), spanning 1871-2024. Competition categories: ${CATEGORIES.join(", ")}.

You have two tools to look up real data - always use them rather than guessing or relying on general rugby knowledge, since the user is asking about THIS specific dataset.
- get_team_record: aggregate win/draw/loss and points for a team, optionally head-to-head vs one opponent, optionally within a year range.
- search_matches: find specific matches matching filters (team, opponent, competition category, year range, venue). Returns up to a limit plus a total count.
- find_extreme_match: find the single most extreme match for a team by a metric (biggest win, biggest loss, or highest combined score) - use this directly for "biggest/best/worst/highest-scoring" questions instead of guessing or searching opponent by opponent.

Known upcoming tournaments (static, not in the historical dataset, today's context only):
- Nations Championship: 4 Jul - 29 Nov 2026 (underway; next round begins 1 Nov). Replaced this year's Rugby Championship and Autumn Internationals.
- Six Nations 2027: 5 Feb - 13 Mar 2027.
- Rugby World Cup 2027: 1 Oct - 13 Nov 2027, hosted by Australia.
You may answer questions about these directly without a tool call.

Keep answers short and conversational - a sentence or two, or a short list for multi-part questions. This is a small chat widget, not a report. If a question is outside rugby/this dataset, say so briefly and redirect to what you can help with.`;

const TOOLS = [
  {
    function_declarations: [
      {
        name: "get_team_record",
        description: "Aggregate win/draw/loss record and points for a team, optionally head-to-head against one opponent and/or restricted to a year range.",
        parameters: {
          type: "object",
          properties: {
            team: { type: "string", enum: TEAMS },
            opponent: { type: "string", enum: TEAMS },
            year_from: { type: "integer" },
            year_to: { type: "integer" }
          },
          required: ["team"]
        }
      },
      {
        name: "search_matches",
        description: "Search for specific matches matching filters. Returns up to `limit` matches (most recent first) plus the total count found.",
        parameters: {
          type: "object",
          properties: {
            team: { type: "string", enum: TEAMS },
            opponent: { type: "string", enum: TEAMS },
            competition_category: { type: "string", enum: CATEGORIES },
            year_from: { type: "integer" },
            year_to: { type: "integer" },
            venue_contains: { type: "string" },
            world_cup_only: { type: "boolean" },
            limit: { type: "integer" }
          }
        }
      },
      {
        name: "find_extreme_match",
        description: "Find the single most extreme match for a team by a metric: biggest win margin, biggest loss margin, or highest combined score. Use this for 'biggest/best/worst/highest-scoring' style questions.",
        parameters: {
          type: "object",
          properties: {
            team: { type: "string", enum: TEAMS },
            opponent: { type: "string", enum: TEAMS },
            metric: { type: "string", enum: ["biggest_win_margin", "biggest_loss_margin", "highest_combined_score"] },
            year_from: { type: "integer" },
            year_to: { type: "integer" }
          },
          required: ["team", "metric"]
        }
      }
    ]
  }
];

function outcome(m, team) {
  const isHome = m.home === team;
  const us = isHome ? m.home_score : m.away_score;
  const them = isHome ? m.away_score : m.home_score;
  if (us > them) return "W";
  if (us < them) return "L";
  return "D";
}

function getTeamRecord(args) {
  const { team, opponent, year_from, year_to } = args || {};
  if (!team || !TEAMS.includes(team)) return { error: "team must be one of: " + TEAMS.join(", ") };
  let w = 0, d = 0, l = 0, pf = 0, pa = 0;
  MATCHES.forEach((m) => {
    const year = +m.date.slice(0, 4);
    if (year_from && year < year_from) return;
    if (year_to && year > year_to) return;
    if (m.home !== team && m.away !== team) return;
    if (opponent && m.home !== opponent && m.away !== opponent) return;
    const isHome = m.home === team;
    pf += isHome ? m.home_score : m.away_score;
    pa += isHome ? m.away_score : m.home_score;
    const o = outcome(m, team);
    if (o === "W") w++; else if (o === "D") d++; else l++;
  });
  const played = w + d + l;
  return {
    team, opponent: opponent || null, year_from: year_from || null, year_to: year_to || null,
    played, won: w, drawn: d, lost: l,
    win_pct: played ? Math.round((w / played) * 1000) / 10 : null,
    points_for: pf, points_against: pa
  };
}

function searchMatches(args) {
  const { team, opponent, competition_category, year_from, year_to, venue_contains, world_cup_only, limit } = args || {};
  const cap = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 40);
  let results = MATCHES.filter((m) => {
    const year = +m.date.slice(0, 4);
    if (year_from && year < year_from) return false;
    if (year_to && year > year_to) return false;
    if (team && m.home !== team && m.away !== team) return false;
    if (opponent && m.home !== opponent && m.away !== opponent) return false;
    if (team && opponent && !((m.home === team && m.away === opponent) || (m.home === opponent && m.away === team))) return false;
    if (competition_category && m.category !== competition_category) return false;
    if (venue_contains && m.stadium.toLowerCase().indexOf(String(venue_contains).toLowerCase()) === -1) return false;
    if (world_cup_only && !m.world_cup) return false;
    return true;
  });
  results.sort((a, b) => (a.date < b.date ? 1 : -1));
  const total = results.length;
  results = results.slice(0, cap).map((m) => ({
    date: m.date, home: m.home, away: m.away, score: `${m.home_score}-${m.away_score}`,
    competition: m.competition, stadium: m.stadium, city: m.city, country: m.country
  }));
  return { total_matches_found: total, returned: results.length, matches: results };
}

function findExtremeMatch(args) {
  const { team, opponent, metric, year_from, year_to } = args || {};
  if (!team || !TEAMS.includes(team)) return { error: "team must be one of: " + TEAMS.join(", ") };
  if (!["biggest_win_margin", "biggest_loss_margin", "highest_combined_score"].includes(metric)) {
    return { error: "metric must be biggest_win_margin, biggest_loss_margin, or highest_combined_score" };
  }
  let best = null, bestValue = -Infinity;
  MATCHES.forEach((m) => {
    const year = +m.date.slice(0, 4);
    if (year_from && year < year_from) return;
    if (year_to && year > year_to) return;
    if (m.home !== team && m.away !== team) return;
    if (opponent && m.home !== opponent && m.away !== opponent) return;
    const isHome = m.home === team;
    const us = isHome ? m.home_score : m.away_score;
    const them = isHome ? m.away_score : m.home_score;
    let value;
    if (metric === "biggest_win_margin") value = us > them ? us - them : -Infinity;
    else if (metric === "biggest_loss_margin") value = us < them ? them - us : -Infinity;
    else value = us + them;
    if (value > bestValue) {
      bestValue = value;
      best = m;
    }
  });
  if (!best || bestValue === -Infinity) return { found: false, message: "No matching match found for that metric/filters." };
  return {
    found: true,
    metric_value: bestValue,
    date: best.date, home: best.home, away: best.away, score: `${best.home_score}-${best.away_score}`,
    competition: best.competition, stadium: best.stadium, city: best.city, country: best.country
  };
}

function runTool(name, args) {
  if (name === "get_team_record") return getTeamRecord(args);
  if (name === "search_matches") return searchMatches(args);
  if (name === "find_extreme_match") return findExtremeMatch(args);
  return { error: "unknown tool " + name };
}

function toGeminiContents(history, message) {
  const contents = [];
  (history || []).slice(-10).forEach((turn) => {
    if (!turn || !turn.role || !turn.text) return;
    contents.push({ role: turn.role === "assistant" ? "model" : "user", parts: [{ text: String(turn.text).slice(0, 2000) }] });
  });
  contents.push({ role: "user", parts: [{ text: message }] });
  return contents;
}

async function callGemini(contents) {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      tools: TOOLS,
      generationConfig: { maxOutputTokens: 500, temperature: 0.4 }
    })
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error("Gemini API error " + res.status + ": " + errText.slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  if (!API_KEY) {
    res.status(500).json({ error: "Server is missing GEMINI_API_KEY." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const message = String((body && body.message) || "").slice(0, 500).trim();
  const history = (body && body.history) || [];

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  try {
    const contents = toGeminiContents(history, message);
    let data = await callGemini(contents);
    let loops = 0;

    while (loops < 4) {
      const candidate = data.candidates && data.candidates[0];
      const parts = (candidate && candidate.content && candidate.content.parts) || [];
      const call = parts.find((p) => p.functionCall);
      if (!call) break;

      const toolResult = runTool(call.functionCall.name, call.functionCall.args);
      contents.push({ role: "model", parts: [call] });
      contents.push({ role: "user", parts: [{ functionResponse: { name: call.functionCall.name, response: toolResult } }] });
      data = await callGemini(contents);
      loops++;
    }

    const finalCandidate = data.candidates && data.candidates[0];
    const finalParts = (finalCandidate && finalCandidate.content && finalCandidate.content.parts) || [];
    const text = finalParts.filter((p) => p.text).map((p) => p.text).join("\n").trim();

    if (!text) console.error("empty final text, loops=", loops, "finalCandidate=", JSON.stringify(finalCandidate));
    res.status(200).json({ reply: text || "I couldn't find an answer to that - try rephrasing?" });
  } catch (err) {
    console.error("chat handler error:", err && err.stack ? err.stack : err);
    if (err && err.status === 429) {
      res.status(429).json({ error: "This bot is on a free, rate-limited plan and it's briefly maxed out - give it about a minute and try again." });
      return;
    }
    res.status(500).json({ error: "Something went wrong answering that. Try again in a moment." });
  }
};
