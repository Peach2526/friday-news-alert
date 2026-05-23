import express from "express";
import axios from "axios";
import { google } from "googleapis";

const app = express();

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

async function readSheetRange(range) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  if (!spreadsheetId) {
    throw new Error("Missing GOOGLE_SHEET_ID");
  }

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  return response.data.values || [];
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
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const targetId = process.env.LINE_TARGET_ID;

    if (!token || !targetId) {
      return res.status(500).json({
        ok: false,
        error: "Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_TARGET_ID",
      });
    }

    await axios.post(
      "https://api.line.me/v2/bot/message/push",
      {
        to: targetId,
        messages: [
          {
            type: "text",
            text: "✅ FRIDAY News Alert test message สำเร็จแล้ว",
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
    const topics = await readSheetRange("topics!A1:D20");
    const sources = await readSheetRange("sources!A1:E20");
    const sentArticles = await readSheetRange("sent_articles!A1:F20");

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
  });
});
const port = process.env.PORT || 3000;

app.listen(port, "0.0.0.0", () => {
  console.log(`FRIDAY News Alert webhook server running on port ${port}`);
});
