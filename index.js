import express from "express";
import axios from "axios";
import { google } from "googleapis";
import Parser from "rss-parser";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();
const parser = new Parser();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.json());

function getGoogleAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!email || !privateKey) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY");
  }

  privateKey = privateKey.replace(/\\n/g, "\n");

  return new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function getSheetsClient() {
  const auth = getGoogleAuth();
  return google.sheets({ version: "v4", auth });
}

async function readSheetRange(range) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  if (!spreadsheetId) {
    throw new Error("Missing GOOGLE_SHEET_ID");
  }

  const sheets = getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  return response.data.values || [];
}

async function appendSheetRow(range, row) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  if (!spreadsheetId) {
    throw new Error("Missing GOOGLE_SHEET_ID");
  }

  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [row],
    },
  });
}

function rowsToObjects(rows) {
  const [headers, ...dataRows] = rows;

  if (!headers) return [];

  return dataRows
    .filter((row) => row.some((cell) => String(cell || "").trim() !== ""))
    .map((row) => {
      const obj = {};

      headers.forEach((header, index) => {
        obj[String(header).trim()] = String(row[index] || "").trim();
      });

      return obj;
    });
}

function settingsRowsToObject(rows) {
  const dataRows = rows.slice(1);
  const settings = {};

  for (const row of dataRows) {
    const key = String(row[0] || "").trim();
    const value = String(row[1] || "").trim();

    if (key) {
      settings[key] = value;
    }
  }

  return settings;
}

function isActive(value) {
  return String(value || "").trim().toUpperCase() === "TRUE";
}

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeTimeText(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);

  if (!match) return text;

  const hour = match[1].padStart(2, "0");
  const minute = match[2];

  return `${hour}:${minute}`;
}

function getBangkokTimeText(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function getBangkokHourText(date = new Date()) {
  return getBangkokTimeText(date).slice(0, 2);
}

function getLookbackHours(settings, currentTimeText) {
  const normalizedCurrent = normalizeTimeText(currentTimeText);
  const morningHour = normalizeTimeText(settings.morning_hour || "07:00");
  const eveningHour = normalizeTimeText(settings.evening_hour || "20:00");

  if (normalizedCurrent === morningHour) {
    return toNumber(settings.morning_lookback_hours, 8);
  }

  if (normalizedCurrent === eveningHour) {
    return toNumber(settings.evening_lookback_hours, 4);
  }

  return toNumber(settings.normal_lookback_hours, 3);
}

function createArticleId(url) {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 24);
}

function getArticleDate(item) {
  const rawDate = item.isoDate || item.pubDate || item.date || "";

  if (!rawDate) return null;

  const date = new Date(rawDate);

  if (Number.isNaN(date.getTime())) return null;

  return date;
}

function isWithinLookback(date, lookbackHours, now = new Date()) {
  if (!date) return false;

  const diffMs = now.getTime() - date.getTime();
  const lookbackMs = lookbackHours * 60 * 60 * 1000;

  return diffMs >= 0 && diffMs <= lookbackMs;
}

function getRecencyBonus(date, now = new Date()) {
  if (!date) return 0;

  const ageHours = (now.getTime() - date.getTime()) / (60 * 60 * 1000);

  if (ageHours <= 1) return 3;
  if (ageHours <= 3) return 2;
  if (ageHours <= 6) return 1;

  return 0;
}

function sourceBelongsToTopic(source, topic) {
  const sourceId = String(source.source_id || "").toLowerCase();
  const topicId = String(topic.topic_id || "").toLowerCase();

  return sourceId.includes(topicId);
}

async function sendLineMessage(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const targetId = process.env.LINE_TARGET_ID;

  if (!token || !targetId) {
    throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_TARGET_ID");
  }

  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: targetId,
      messages: [
        {
          type: "text",
          text,
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function analyzeArticleWithOpenAI({
  topicName,
  keywords,
  sourceName,
  title,
  link,
  pubDate,
}) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      relevant: true,
      importance_score: 5,
      urgency_score: 5,
      summary_th: "ยังไม่ได้ตั้งค่า OPENAI_API_KEY ระบบจึงส่งข่าวโดยไม่สรุปด้วย AI",
      reason_th: "OpenAI API key missing",
    };
  }

  const prompt = `
คุณคือผู้ช่วยคัดกรองข่าวสำหรับระบบแจ้งเตือน LINE

ให้ประเมินว่าข่าวนี้เกี่ยวข้องกับหัวข้อที่ติดตามจริงหรือไม่ และควรแจ้งเตือนมากน้อยแค่ไหน
ตอบกลับเป็น JSON เท่านั้น ห้ามมี markdown ห้ามมีคำอธิบายนอก JSON

รูปแบบ JSON:
{
  "relevant": true,
  "importance_score": 1,
  "urgency_score": 1,
  "summary_th": "สรุปข่าวภาษาไทยแบบละเอียด 3-5 ประโยค โดยอธิบายว่าเกิดอะไรขึ้น ใครเกี่ยวข้อง ผลกระทบคืออะไร และสถานการณ์ล่าสุด",
  "reason_th": "เหตุผลสั้น ๆ ว่าทำไมข่าวนี้ควรหรือไม่ควรถูกเลือก"
}

เงื่อนไขคะแนน:
- importance_score ให้ 1-10
- urgency_score ให้ 1-10
- ถ้าเป็นข่าวสำคัญ เช่น ความขัดแย้ง ความมั่นคง การทูต เหตุรุนแรง นโยบายรัฐ ผลกระทบสาธารณะ ให้คะแนนสูง
- ถ้าเป็นข่าวท่องเที่ยวทั่วไป รีวิว โรงแรม โปรโมชัน บทความ evergreen หรือข้อมูลพื้นหลังที่ไม่ใช่ข่าวใหม่ ให้ relevant=false หรือคะแนนต่ำ
- summary_th ให้สรุปละเอียด อ่านแล้วเข้าใจข่าวได้ทันที
- ใช้ภาษาไทยแบบข่าวสั้น อ่านง่าย
- ถ้าข้อมูลมีจำกัด ห้ามเดาเกินข้อมูลข่าว

หัวข้อที่ติดตาม: ${topicName}
keywords: ${keywords}
แหล่งข่าว: ${sourceName}
หัวข้อข่าว: ${title}
วันที่ข่าว: ${pubDate || ""}
ลิงก์: ${link}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a careful news filtering assistant. You must respond with valid JSON only.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
  });

  const content = completion.choices?.[0]?.message?.content || "{}";
  const parsed = safeJsonParse(content);

  if (!parsed || typeof parsed.relevant !== "boolean") {
    return {
      relevant: false,
      importance_score: 0,
      urgency_score: 0,
      summary_th: "",
      reason_th: "OpenAI response could not be parsed as expected.",
    };
  }

  return {
    relevant: Boolean(parsed.relevant),
    importance_score: Math.max(0, Math.min(10, Number(parsed.importance_score) || 0)),
    urgency_score: Math.max(0, Math.min(10, Number(parsed.urgency_score) || 0)),
    summary_th: String(parsed.summary_th || "").trim(),
    reason_th: String(parsed.reason_th || "").trim(),
  };
}

function formatThaiDate(dateString) {
  if (!dateString) return "";

  const date = new Date(dateString);

  if (Number.isNaN(date.getTime())) return dateString;

  const bangkokDate = new Date(
    date.toLocaleString("en-US", { timeZone: "Asia/Bangkok" })
  );

  const thaiMonths = [
    "ม.ค.",
    "ก.พ.",
    "มี.ค.",
    "เม.ย.",
    "พ.ค.",
    "มิ.ย.",
    "ก.ค.",
    "ส.ค.",
    "ก.ย.",
    "ต.ค.",
    "พ.ย.",
    "ธ.ค.",
  ];

  const day = bangkokDate.getDate();
  const month = thaiMonths[bangkokDate.getMonth()];
  const year = String(bangkokDate.getFullYear() + 543).slice(-2);

  const hours = String(bangkokDate.getHours()).padStart(2, "0");
  const minutes = String(bangkokDate.getMinutes()).padStart(2, "0");

  return `${day} ${month}${year} เวลา ${hours}${minutes} น.`;
}

function buildNewsMessage({
  topicName,
  sourceName,
  title,
  link,
  pubDate,
  analysis,
}) {
  return [
    `📰 [${topicName}]`,
    "",
    `${title}`,
    "",
    analysis?.summary_th || "",
    "",
    `แหล่งข่าว: ${sourceName}`,
    pubDate ? `ออกข่าวเมื่อ ${formatThaiDate(pubDate)}` : "",
    "",
    `อ่านต่อ: ${link}`,
  ]
    .filter(Boolean)
    .join("\n");
}

app.get("/", (req, res) => {
  res.send("FRIDAY News Alert is running.");
});

app.post("/webhook", (req, res) => {
  console.log("LINE WEBHOOK:", JSON.stringify(req.body, null, 2));

  const events = req.body.events || [];

  for (const event of events) {
    const source = event.source || {};

    if (source.userId) {
      console.log("USER ID:", source.userId);
    }

    if (source.groupId) {
      console.log("GROUP ID:", source.groupId);
    }

    if (source.roomId) {
      console.log("ROOM ID:", source.roomId);
    }
  }

  res.sendStatus(200);
});

app.get("/test-line", async (req, res) => {
  try {
    await sendLineMessage("✅ FRIDAY News Alert test message สำเร็จแล้ว");

    res.json({
      ok: true,
      message: "Test message sent to LINE.",
    });
  } catch (error) {
    console.error("LINE PUSH ERROR:", error.response?.data || error.message);

    res.status(500).json({
      ok: false,
      error: error.response?.data || error.message,
    });
  }
});

app.get("/test-sheet", async (req, res) => {
  try {
    const topics = await readSheetRange("topics!A1:D100");
    const sources = await readSheetRange("sources!A1:E100");
    const sentArticles = await readSheetRange("sent_articles!A1:F1000");
    const settings = await readSheetRange("settings!A1:B100");

    res.json({
      ok: true,
      topics,
      sources,
      sent_articles: sentArticles,
      settings,
    });
  } catch (error) {
    console.error("GOOGLE SHEET ERROR:", error.message);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/debug-env", (req, res) => {
  res.json({
    sheet_id: process.env.GOOGLE_SHEET_ID,
    service_account_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    has_private_key: Boolean(process.env.GOOGLE_PRIVATE_KEY),
    private_key_starts_correctly:
      process.env.GOOGLE_PRIVATE_KEY?.includes("BEGIN PRIVATE KEY") || false,
    has_openai_key: Boolean(process.env.OPENAI_API_KEY),
  });
});

app.get("/run-news-check", async (req, res) => {
  try {
    const now = new Date();

    const topicRows = await readSheetRange("topics!A1:D100");
    const sourceRows = await readSheetRange("sources!A1:E100");
    const sentRows = await readSheetRange("sent_articles!A1:F2000");
    const settingRows = await readSheetRange("settings!A1:B100");

    const topics = rowsToObjects(topicRows).filter((topic) =>
      isActive(topic.active)
    );

    const sources = rowsToObjects(sourceRows).filter((source) =>
      isActive(source.active)
    );

    const sentArticles = rowsToObjects(sentRows);
    const sentArticleIds = new Set(
      sentArticles.map((article) => article.article_id)
    );

    const settings = settingsRowsToObject(settingRows);

    const currentTimeText =
      req.query.time ||
      getBangkokTimeText(now);

    const normalizedCurrentTime = normalizeTimeText(currentTimeText);
    const currentHourText = normalizeTimeText(normalizedCurrentTime).slice(0, 2);

    const scheduleHours = String(settings.schedule_hours || "")
      .split(",")
      .map((item) => normalizeTimeText(item.trim()))
      .filter(Boolean);

    const scheduleHourOnly = scheduleHours.map((item) => item.slice(0, 2));

    const shouldRespectSchedule = req.query.force !== "true";

    if (
      shouldRespectSchedule &&
      scheduleHourOnly.length > 0 &&
      !scheduleHourOnly.includes(currentHourText)
    ) {
      return res.json({
        ok: true,
        skipped: true,
        reason: "Current Bangkok hour is not in schedule_hours.",
        current_time_bangkok: normalizedCurrentTime,
        schedule_hours: scheduleHours,
      });
    }

    const lookbackHours = req.query.lookbackHours
      ? toNumber(req.query.lookbackHours, 3)
      : getLookbackHours(settings, normalizedCurrentTime);

    const maxItemsPerSource = toNumber(settings.max_items_per_source, 5);
    const maxSendPerTopic = toNumber(settings.max_send_per_topic_per_run, 1);

    const results = [];
    let totalSentCount = 0;

    for (const topic of topics) {
      const topicSources = sources.filter((source) =>
        sourceBelongsToTopic(source, topic)
      );

      if (topicSources.length === 0) {
        results.push({
          topic_id: topic.topic_id,
          status: "skipped",
          reason: "No sources found for topic",
        });
        continue;
      }

      const candidates = [];

      for (const source of topicSources) {
        if (!source.url || source.url === "RSS_URL") {
          results.push({
            topic_id: topic.topic_id,
            source: source.source_name,
            status: "source_skipped",
            reason: "Missing RSS URL",
          });
          continue;
        }

        if (source.type !== "rss") {
          results.push({
            topic_id: topic.topic_id,
            source: source.source_name,
            status: "source_skipped",
            reason: "Unsupported source type",
          });
          continue;
        }

        let feed;

        try {
          feed = await parser.parseURL(source.url);
        } catch (error) {
          results.push({
            topic_id: topic.topic_id,
            source: source.source_name,
            status: "source_error",
            reason: error.message,
          });
          continue;
        }

        const items = feed.items || [];

        for (const item of items.slice(0, maxItemsPerSource)) {
          const title = item.title || "Untitled";
          const link = item.link || item.guid;

          if (!link) continue;

          const articleId = createArticleId(link);

          if (sentArticleIds.has(articleId)) {
            continue;
          }

          const articleDate = getArticleDate(item);

          if (!isWithinLookback(articleDate, lookbackHours, now)) {
            continue;
          }

          candidates.push({
            articleId,
            topic,
            source,
            title,
            link,
            pubDate: item.isoDate || item.pubDate || "",
            articleDate,
          });
        }
      }

      if (candidates.length === 0) {
        results.push({
          topic_id: topic.topic_id,
          status: "no_candidates",
          reason: "No new articles within lookback window",
          lookback_hours: lookbackHours,
        });
        continue;
      }

      const analyzedCandidates = [];

      for (const candidate of candidates) {
        const analysis = await analyzeArticleWithOpenAI({
          topicName: topic.topic_name,
          keywords: topic.keywords,
          sourceName: candidate.source.source_name,
          title: candidate.title,
          link: candidate.link,
          pubDate: candidate.pubDate,
        });

        if (!analysis.relevant) {
          analyzedCandidates.push({
            ...candidate,
            analysis,
            finalScore: 0,
            skippedByAi: true,
          });

          continue;
        }

        const recencyBonus = getRecencyBonus(candidate.articleDate, now);

        const finalScore =
          analysis.importance_score * 2 +
          analysis.urgency_score +
          recencyBonus;

        analyzedCandidates.push({
          ...candidate,
          analysis,
          finalScore,
          skippedByAi: false,
        });
      }

      const rankedCandidates = analyzedCandidates
        .filter((candidate) => !candidate.skippedByAi)
        .sort((a, b) => b.finalScore - a.finalScore);

      if (rankedCandidates.length === 0) {
        results.push({
          topic_id: topic.topic_id,
          status: "ai_skipped_all",
          reason: "OpenAI found no relevant article",
          checked_count: analyzedCandidates.length,
          examples: analyzedCandidates.slice(0, 3).map((candidate) => ({
            title: candidate.title,
            reason: candidate.analysis.reason_th,
          })),
        });
        continue;
      }

      const winners = rankedCandidates.slice(0, maxSendPerTopic);

      for (const winner of winners) {
        const message = buildNewsMessage({
          topicName: topic.topic_name,
          sourceName: winner.source.source_name,
          title: winner.title,
          link: winner.link,
          pubDate: winner.pubDate,
          analysis: winner.analysis,
          finalScore: winner.finalScore,
          lookbackHours,
        });

        await sendLineMessage(message);

        await appendSheetRow("sent_articles!A:F", [
          winner.articleId,
          topic.topic_id,
          winner.title,
          winner.link,
          winner.source.source_name,
          new Date().toISOString(),
        ]);

        sentArticleIds.add(winner.articleId);
        totalSentCount += 1;

        results.push({
          topic_id: topic.topic_id,
          status: "sent_best_article",
          source: winner.source.source_name,
          title: winner.title,
          score: winner.finalScore,
          importance_score: winner.analysis.importance_score,
          urgency_score: winner.analysis.urgency_score,
          summary_th: winner.analysis.summary_th,
          reason_th: winner.analysis.reason_th,
          candidate_count: candidates.length,
          link: winner.link,
        });
      }
    }

    res.json({
      ok: true,
      mode: "best_article_per_topic",
      current_time_bangkok: normalizedCurrentTime,
      lookback_hours: lookbackHours,
      max_send_per_topic_per_run: maxSendPerTopic,
      sent_count: totalSentCount,
      results,
    });
  } catch (error) {
    console.error("RUN NEWS CHECK ERROR:", error.response?.data || error.message);

    res.status(500).json({
      ok: false,
      error: error.response?.data || error.message,
    });
  }
});

const port = process.env.PORT || 3000;

app.listen(port, "0.0.0.0", () => {
  console.log(`FRIDAY News Alert webhook server running on port ${port}`);
});
