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

function isActive(value) {
  return String(value || "").trim().toUpperCase() === "TRUE";
}

function createArticleId(url) {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 24);
}

function guessTopicIdFromSource(sourceId, topics) {
  const cleanSourceId = String(sourceId || "").trim();

  const matchedTopic = topics.find((topic) =>
    cleanSourceId.includes(topic.topic_id)
  );

  return matchedTopic?.topic_id || "unknown";
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

function cleanGoogleNewsUrl(url) {
  return String(url || "").trim();
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
      summary_th: "ยังไม่ได้ตั้งค่า OPENAI_API_KEY ระบบจึงส่งข่าวโดยไม่สรุปด้วย AI",
      reason_th: "OpenAI API key missing",
    };
  }

  const prompt = `
คุณคือผู้ช่วยคัดกรองข่าวสำหรับระบบแจ้งเตือน LINE

ให้ตัดสินว่าข่าวนี้เกี่ยวข้องกับหัวข้อที่ติดตามจริงหรือไม่
ตอบกลับเป็น JSON เท่านั้น ห้ามมี markdown ห้ามมีคำอธิบายนอก JSON

รูปแบบ JSON:
{
  "relevant": true,
  "summary_th": "สรุปข่าวภาษาไทย 1-2 ประโยค",
  "reason_th": "เหตุผลสั้น ๆ ว่าทำไมข่าวนี้เกี่ยวหรือไม่เกี่ยว"
}

หัวข้อที่ติดตาม: ${topicName}
keywords: ${keywords}
แหล่งข่าว: ${sourceName}
หัวข้อข่าว: ${title}
วันที่ข่าว: ${pubDate || ""}
ลิงก์: ${link}

เกณฑ์:
- ถ้าข่าวเกี่ยวกับหัวข้อหลักจริง ให้ relevant เป็น true
- ถ้าเป็นข่าวทั่วไปที่มีคำซ้ำแต่ไม่เกี่ยวกับหัวข้อหลัก ให้ relevant เป็น false
- summary_th ต้องเป็นภาษาไทย กระชับ และไม่เดาข้อมูลเกินจากหัวข้อข่าว/ข้อมูลที่ให้
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
      summary_th: "",
      reason_th: "OpenAI response could not be parsed as expected.",
    };
  }

  return {
    relevant: parsed.relevant,
    summary_th: String(parsed.summary_th || "").trim(),
    reason_th: String(parsed.reason_th || "").trim(),
  };
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
    `หัวข้อ: ${title}`,
    "",
    analysis?.summary_th ? `สรุป: ${analysis.summary_th}` : "",
    analysis?.reason_th ? `เหตุผลที่เกี่ยวข้อง: ${analysis.reason_th}` : "",
    "",
    `แหล่งข่าว: ${sourceName}`,
    pubDate ? `วันที่ข่าว: ${pubDate}` : "",
    "",
    `ลิงก์: ${cleanGoogleNewsUrl(link)}`,
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
    const topics = await readSheetRange("topics!A1:D50");
    const sources = await readSheetRange("sources!A1:E50");
    const sentArticles = await readSheetRange("sent_articles!A1:F200");

    res.json({
      ok: true,
      topics,
      sources,
      sent_articles: sentArticles,
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
    const topicRows = await readSheetRange("topics!A1:D50");
    const sourceRows = await readSheetRange("sources!A1:E50");
    const sentRows = await readSheetRange("sent_articles!A1:F1000");

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

    const results = [];
    let sentCount = 0;
    const maxSendPerRun = 5;

    for (const source of sources) {
      if (sentCount >= maxSendPerRun) break;

      if (!source.url || source.url === "RSS_URL") {
        results.push({
          source: source.source_name,
          status: "skipped",
          reason: "Missing RSS URL",
        });
        continue;
      }

      if (source.type !== "rss") {
        results.push({
          source: source.source_name,
          status: "skipped",
          reason: "Unsupported source type",
        });
        continue;
      }

      const topicId = guessTopicIdFromSource(source.source_id, topics);
      const topic = topics.find((item) => item.topic_id === topicId);

      if (!topic) {
        results.push({
          source: source.source_name,
          status: "skipped",
          reason: `No matching topic for source_id: ${source.source_id}`,
        });
        continue;
      }

      const feed = await parser.parseURL(source.url);
      const items = feed.items || [];

      for (const item of items.slice(0, 5)) {
        if (sentCount >= maxSendPerRun) break;

        const title = item.title || "Untitled";
        const link = item.link || item.guid;

        if (!link) continue;

        const articleId = createArticleId(link);

        if (sentArticleIds.has(articleId)) {
          results.push({
            status: "duplicate_skipped",
            topic_id: topic.topic_id,
            source: source.source_name,
            title,
          });
          continue;
        }

        const pubDate = item.isoDate || item.pubDate || "";

        const analysis = await analyzeArticleWithOpenAI({
          topicName: topic.topic_name,
          keywords: topic.keywords,
          sourceName: source.source_name,
          title,
          link,
          pubDate,
        });

        if (!analysis.relevant) {
          results.push({
            status: "ai_skipped",
            topic_id: topic.topic_id,
            source: source.source_name,
            title,
            reason: analysis.reason_th,
          });
          continue;
        }

        const message = buildNewsMessage({
          topicName: topic.topic_name,
          sourceName: source.source_name,
          title,
          link,
          pubDate,
          analysis,
        });

        await sendLineMessage(message);

        await appendSheetRow("sent_articles!A:F", [
          articleId,
          topic.topic_id,
          title,
          link,
          source.source_name,
          new Date().toISOString(),
        ]);

        sentArticleIds.add(articleId);
        sentCount += 1;

        results.push({
          status: "sent",
          topic_id: topic.topic_id,
          source: source.source_name,
          title,
          summary_th: analysis.summary_th,
          link,
        });
      }
    }

    res.json({
      ok: true,
      sent_count: sentCount,
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
