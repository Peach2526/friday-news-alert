import express from "express";

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

const port = process.env.PORT || 3000;

app.listen(port, "0.0.0.0", () => {
  console.log(`FRIDAY News Alert webhook server running on port ${port}`);
});
