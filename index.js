import express from "express";
import axios from "axios";

const app = express();

app.use(express.json());

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

const port = process.env.PORT || 3000;

app.listen(port, "0.0.0.0", () => {
  console.log(`FRIDAY News Alert webhook server running on port ${port}`);
});
