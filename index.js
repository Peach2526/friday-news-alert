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

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization,Accept"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});

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

  return `${day} ${month}${year} เวลา ${hours}:${minutes} น.`;
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

const SECURITY_NEWS_CACHE = new Map();
const SECURITY_SUMMARY_CACHE = new Map();

const SECURITY_AREAS = {
    phuket: {
    label: "ภูเก็ต",
    queries: [
      "Phuket nominee business",
      "Phuket illegal business foreigner",
      "Phuket mafia foreigner",
      "Phuket visa overstay",
      "Phuket work permit foreigner",
      "Phuket property crackdown foreigner",
      "ภูเก็ต นอมินี",
      "ภูเก็ต ธุรกิจผิดกฎหมาย ต่างชาติ",
      "ภูเก็ต มาเฟีย ต่างชาติ",
      "ภูเก็ต แย่งอาชีพ คนไทย",
      "ภูเก็ต ตรวจคนเข้าเมือง ต่างชาติ",
      "ภูเก็ต จับกุม ต่างชาติ",
    ],
  },

  koh_samui: {
    label: "เกาะสมุย",
    queries: [
      "Koh Samui nominee business",
      "Koh Samui illegal business foreigner",
      "Koh Samui mafia foreigner",
      "Koh Samui visa overstay",
      "Koh Samui work permit foreigner",
      "Koh Samui foreigner crime",
      "เกาะสมุย นอมินี",
      "สมุย ธุรกิจผิดกฎหมาย ต่างชาติ",
      "สมุย มาเฟีย ต่างชาติ",
      "สมุย แย่งอาชีพ คนไทย",
      "สมุย ตรวจคนเข้าเมือง ต่างชาติ",
      "สมุย จับกุม ต่างชาติ",
    ],
  },

  koh_phangan: {
    label: "เกาะพะงัน",
    queries: [
      "Koh Phangan nominee business",
      "Koh Phangan illegal business foreigner",
      "Koh Phangan mafia foreigner",
      "Koh Phangan visa overstay",
      "Koh Phangan work permit foreigner",
      "Koh Phangan foreigner crime",
      "Koh Pha-ngan nominee business",
      "เกาะพะงัน นอมินี",
      "เกาะพงัน นอมินี",
      "พะงัน ธุรกิจผิดกฎหมาย ต่างชาติ",
      "พงัน ธุรกิจผิดกฎหมาย ต่างชาติ",
      "พะงัน มาเฟีย ต่างชาติ",
      "พงัน มาเฟีย ต่างชาติ",
      "พะงัน แย่งอาชีพ คนไทย",
      "พงัน แย่งอาชีพ คนไทย",
      "เกาะพะงัน ตรวจคนเข้าเมือง ต่างชาติ",
      "เกาะพงัน จับกุม ต่างชาติ",
    ],
  },

  mae_hong_son: {
    label: "แม่ฮ่องสอน",
    queries: [
      "Mae Hong Son illegal business",
      "Mae Hong Son foreigner crime",
      "Mae Hong Son border security",
      "Mae Hong Son nominee business",
      "Mae Hong Son drug trafficking",
      "Mae Hong Son smuggling",
      "แม่ฮ่องสอน ธุรกิจผิดกฎหมาย",
      "แม่ฮ่องสอน ต่างชาติ",
      "แม่ฮ่องสอน ชายแดน",
      "แม่ฮ่องสอน ความมั่นคง",
      "แม่ฮ่องสอน ยาเสพติด",
      "แม่ฮ่องสอน ลักลอบ",
      "แม่ฮ่องสอน จับกุม",
    ],
  },
};

function buildGoogleNewsRssUrl(query, lang = "th", hours = 72) {
  const lookbackDays = Math.max(1, Math.ceil(hours / 24));
  const encodedQuery = encodeURIComponent(`${query} when:${lookbackDays}d`);
  const hl = lang === "en" ? "en" : "th";
  const ceid = lang === "en" ? "TH:en" : "TH:th";

  return `https://news.google.com/rss/search?q=${encodedQuery}&hl=${hl}&gl=TH&ceid=${ceid}`;
}

function getSecurityTargetAreas(area) {
  if (area === "all") {
    return Object.entries(SECURITY_AREAS);
  }

  if (area === "samui_phangan") {
    return [
      ["koh_samui", SECURITY_AREAS.koh_samui],
      ["koh_phangan", SECURITY_AREAS.koh_phangan],
    ];
  }

  if (SECURITY_AREAS[area]) {
    return [[area, SECURITY_AREAS[area]]];
  }

  return null;
}

function normalizeSecurityNewsItem(item, areaKey, areaLabel, query, feedTitle) {
  const title = item.title || "";
  const link = item.link || item.guid || "";
  const pubDate = item.isoDate || item.pubDate || "";

  const source =
    item.source?.title ||
    item.creator ||
    feedTitle ||
    "Google News";

  return {
    id: createArticleId(link || `${title}-${pubDate}`),
    area: areaKey,
    area_label: areaLabel,
    query,
    title,
    link,
    source,
    published_at: pubDate,
    snippet: item.contentSnippet || item.content || "",
  };
}

function detectRiskCategory(text) {
  const value = String(text || "").toLowerCase();

  if (
    value.includes("nominee") ||
    value.includes("นอมินี") ||
    value.includes("ตัวแทนถือหุ้น")
  ) {
    return "nominee_business";
  }

  if (
    value.includes("illegal business") ||
    value.includes("ธุรกิจผิดกฎหมาย") ||
    value.includes("ประกอบธุรกิจผิด") ||
    value.includes("ผิดกฎหมาย")
  ) {
    return "illegal_business";
  }

  if (
    value.includes("mafia") ||
    value.includes("มาเฟีย") ||
    value.includes("organized crime") ||
    value.includes("อิทธิพล")
  ) {
    return "foreign_mafia";
  }

  if (
    value.includes("visa") ||
    value.includes("overstay") ||
    value.includes("วีซ่า") ||
    value.includes("อยู่เกินกำหนด") ||
    value.includes("immigration") ||
    value.includes("ตรวจคนเข้าเมือง")
  ) {
    return "visa_overstay";
  }

  if (
    value.includes("work permit") ||
    value.includes("ใบอนุญาตทำงาน") ||
    value.includes("แย่งอาชีพ") ||
    value.includes("อาชีพคนไทย")
  ) {
    return "work_permit_or_local_job";
  }

  if (
    value.includes("drug") ||
    value.includes("ยาเสพติด") ||
    value.includes("ยาไอซ์") ||
    value.includes("โคเคน") ||
    value.includes("narcotic")
  ) {
    return "drug_crime";
  }

  return "general_security";
}

function getSecurityReason(item) {
  const text = `${item.title} ${item.snippet}`;
  const category = detectRiskCategory(text);

  const reasons = {
    nominee_business:
      "ข่าวนี้เกี่ยวข้องกับประเด็นนอมินีหรือการถือครองธุรกิจแทนกัน ซึ่งอาจกระทบต่อโครงสร้างธุรกิจท้องถิ่นและการบังคับใช้กฎหมาย",
    illegal_business:
      "ข่าวนี้เกี่ยวข้องกับธุรกิจผิดกฎหมายหรือการประกอบธุรกิจที่อาจไม่เป็นไปตามกฎหมายในพื้นที่",
    foreign_mafia:
      "ข่าวนี้เกี่ยวข้องกับเครือข่ายอิทธิพล อาชญากรรม หรือกลุ่มผิดกฎหมายที่อาจกระทบความปลอดภัยในพื้นที่",
    visa_overstay:
      "ข่าวนี้เกี่ยวข้องกับการตรวจคนเข้าเมือง วีซ่า หรือการพำนักของชาวต่างชาติ ซึ่งเป็นประเด็นด้านความมั่นคงและการบังคับใช้กฎหมาย",
    work_permit_or_local_job:
      "ข่าวนี้เกี่ยวข้องกับใบอนุญาตทำงาน การประกอบอาชีพของชาวต่างชาติ หรือผลกระทบต่ออาชีพของคนท้องถิ่น",
    drug_crime:
      "ข่าวนี้เกี่ยวข้องกับยาเสพติดหรืออาชญากรรมที่อาจกระทบความปลอดภัยของประชาชนและการท่องเที่ยว",
    general_security:
      "ข่าวนี้เกิดขึ้นหรือเกี่ยวข้องกับพื้นที่ที่ติดตาม และอาจมีผลต่อความปลอดภัย การท่องเที่ยว หรือการทำงานของเจ้าหน้าที่ในพื้นที่",
  };

  return reasons[category];
}

function enrichSecurityNewsItem(item) {
  const text = `${item.title} ${item.snippet}`;
  const riskCategory = detectRiskCategory(text);

  let severity = 4;

  if (riskCategory === "foreign_mafia") severity = 8;
  if (riskCategory === "nominee_business") severity = 7;
  if (riskCategory === "illegal_business") severity = 7;
  if (riskCategory === "drug_crime") severity = 7;
  if (riskCategory === "visa_overstay") severity = 5;
  if (riskCategory === "work_permit_or_local_job") severity = 6;

  return {
    ...item,
    risk_category: riskCategory,
    severity,
    reason_th: getSecurityReason(item),
  };
}

function isSecurityNewsWithinHours(item, hours = 72) {
  const date = new Date(item.published_at);

  if (Number.isNaN(date.getTime())) return false;

  const ageMs = Date.now() - date.getTime();
  const maxAgeMs = hours * 60 * 60 * 1000;

  return ageMs >= 0 && ageMs <= maxAgeMs;
}

function compactNewsText(value = "") {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSnippetForSummary(item) {
  const title = compactNewsText(item.title);
  let snippet = compactNewsText(item.snippet);

  if (!snippet) return "";

  snippet = snippet.replace(title, "").trim();
  snippet = snippet.split(" - ")[0].split(" | ")[0].trim();

  return compactNewsText(snippet);
}

function fallbackSecuritySummary(item) {
  const snippet = cleanSnippetForSummary(item);

  if (snippet && snippet.length >= 35) {
    return snippet;
  }

  const title = compactNewsText(item.title);

  if (!title) {
    return "ไม่มีรายละเอียดข่าวเพียงพอสำหรับสรุปสาระสำคัญ";
  }

  return `จากข้อมูลที่มี แหล่งข่าวรายงานประเด็นว่า “${title}” โดยควรเปิดอ่านต้นทางเพื่อตรวจสอบรายละเอียดเพิ่มเติม`;
}

function chunkArray(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

async function summarizeSecurityNewsItems(items) {
  const itemsWithCachedSummary = items.map((item) => {
    const cachedSummary = SECURITY_SUMMARY_CACHE.get(item.id);

    if (cachedSummary) {
      return {
        ...item,
        summary_th: cachedSummary,
      };
    }

    return item;
  });

  const itemsNeedingSummary = itemsWithCachedSummary.filter((item) => !item.summary_th);
    if (itemsNeedingSummary.length === 0) {
    return itemsWithCachedSummary;
  }

  if (!process.env.OPENAI_API_KEY) {
    return itemsWithCachedSummary.map((item) => {
      const summary = item.summary_th || fallbackSecuritySummary(item);
      SECURITY_SUMMARY_CACHE.set(item.id, summary);

      return {
        ...item,
        summary_th: summary,
      };
    });
  }

  const summaryById = new Map();

  for (const group of chunkArray(itemsNeedingSummary, 20)) {
    const compactItems = group.map((item) => ({
      id: item.id,
      area: item.area_label || item.area,
      source: item.source,
      published_at: item.published_at,
      title: compactNewsText(item.title).slice(0, 240),
      snippet: compactNewsText(item.snippet).slice(0, 700),
      risk_category: item.risk_category,
    }));

    const prompt = `
คุณคือบรรณาธิการข่าวภาษาไทยสำหรับ dashboard ติดตามสถานการณ์ความมั่นคง

งานของคุณ:
- สรุปสาระสำคัญของข่าวแต่ละรายการเป็นภาษาไทยแบบร้อยแก้ว 1-2 ประโยค
- ให้สรุปว่าเกิดอะไรขึ้น ใคร/หน่วยงานใดเกี่ยวข้อง พื้นที่หรือผลกระทบคืออะไร เท่าที่ข้อมูลมี
- ใช้เฉพาะข้อมูลจาก title และ snippet ห้ามแต่งข้อเท็จจริงเพิ่ม
- ห้ามคัดลอกหัวข้อข่าวซ้ำทั้งประโยค
- ห้ามเขียนข้อความ template เช่น "ข่าวนี้เกี่ยวข้องกับ..." หรือ "ประเด็นสำคัญของข่าวนี้..."
- ถ้าข้อมูลมีจำกัด ให้สรุปอย่างระมัดระวังจากข้อมูลที่มี โดยไม่บอกว่า backend ไม่มีสรุป

ตอบกลับเป็น JSON เท่านั้น ตามรูปแบบ:
{
  "items": [
    {
      "id": "id",
      "summary_th": "สรุปข่าวภาษาไทย"
    }
  ]
}

รายการข่าว:
${JSON.stringify(compactItems, null, 2)}
`;

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a careful Thai news summarization assistant. Respond with valid JSON only.",
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
      const summarizedItems = Array.isArray(parsed?.items) ? parsed.items : [];

      for (const summarizedItem of summarizedItems) {
        const id = String(summarizedItem.id || "").trim();
        const summary = compactNewsText(summarizedItem.summary_th || "");

        if (id && summary) {
          summaryById.set(id, summary);
          SECURITY_SUMMARY_CACHE.set(id, summary);
        }
      }
    } catch (error) {
      console.error("SECURITY SUMMARY ERROR:", error.response?.data || error.message);
    }
  }

  return itemsWithCachedSummary.map((item) => {
    const summary = item.summary_th || summaryById.get(item.id) || fallbackSecuritySummary(item);
    SECURITY_SUMMARY_CACHE.set(item.id, summary);

    return {
      ...item,
      summary_th: summary,
    };
  });
}

app.get("/api/security-news", async (req, res) => {
  try {
    const area = String(req.query.area || "all").trim();
    const hours = Math.max(1, Math.min(toNumber(req.query.hours, 72), 168));
    const targetAreas = getSecurityTargetAreas(area);

    if (!targetAreas) {
      return res.status(400).json({
        ok: false,
        error: "Invalid area",
        allowed_areas: [
          "all",
          "samui_phangan",
          "koh_samui",
          "koh_phangan",
          "mae_hong_son",
          "phuket",
        ],
      });
    }

    const cacheKey = `security-news:${area}:${hours}`;
    const cached = SECURITY_NEWS_CACHE.get(cacheKey);
    const now = Date.now();
    const cacheTtlMs = 5 * 60 * 1000;

    if (cached && now - cached.createdAt < cacheTtlMs) {
      return res.json({
        ok: true,
        cached: true,
        area,
        hours,
        updated_at: new Date(cached.createdAt).toISOString(),
        count: cached.items.length,
        items: cached.items,
      });
    }

    const allItems = [];

    for (const [areaKey, areaConfig] of targetAreas) {
      for (const query of areaConfig.queries) {
        try {
          const lang = /[a-zA-Z]/.test(query) ? "en" : "th";
          const rssUrl = buildGoogleNewsRssUrl(query, lang, hours);
          const feed = await parser.parseURL(rssUrl);

          const items = (feed.items || [])
            .map((item) =>
              normalizeSecurityNewsItem(
                item,
                areaKey,
                areaConfig.label,
                query,
                feed.title
              )
            )
            .filter((item) => isSecurityNewsWithinHours(item, hours))
            .map(enrichSecurityNewsItem);

          allItems.push(...items);
        } catch (error) {
          console.error(
            "SECURITY RSS ERROR:",
            areaKey,
            query,
            error.message
          );
        }
      }
    }

    const seen = new Set();

    const uniqueItems = allItems
      .filter((item) => {
        if (!item.link && !item.title) return false;

        if (seen.has(item.id)) {
          return false;
        }

        seen.add(item.id);
        return true;
      })
      .sort((a, b) => {
        const dateA = new Date(a.published_at).getTime() || 0;
        const dateB = new Date(b.published_at).getTime() || 0;

        return dateB - dateA;
      });

    const summarizedItems = await summarizeSecurityNewsItems(uniqueItems);

    SECURITY_NEWS_CACHE.set(cacheKey, {
      createdAt: now,
      items: summarizedItems,
    });

    return res.json({
      ok: true,
      cached: false,
      area,
      hours,
      updated_at: new Date().toISOString(),
      count: summarizedItems.length,
      items: summarizedItems,
    });
  } catch (error) {
    console.error("SECURITY NEWS API ERROR:", error.message);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

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
