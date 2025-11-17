// ===============================
// LINE Bot + Notion（ESM 正式版）
// ===============================

import "dotenv/config";
import express from "express";
import { Client as NotionClient } from "@notionhq/client";
import line from "@line/bot-sdk";

const app = express();
app.use(express.json());

// ===============================
// 🔑 環境變數
// ===============================
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

// ===============================
// 🟦 Notion Client
// ===============================
const notion = new NotionClient({ auth: NOTION_API_KEY });

// ===============================
// 🟩 LINE Client
// ===============================
const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

// ===============================
// 📝 新增到 Notion
// ===============================
async function addOrder(data) {
  return await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      "客人": { title: [{ text: { content: data.customer } }] },
      "商品": { rich_text: [{ text: { content: data.item } }] },
      "數量": { number: data.qty },
      "金額": { number: data.price },
      "備註": { rich_text: [{ text: { content: data.note } }] },
    }
  });
}

// ===============================
// 🔍 查詢 Notion
// ===============================
async function queryOrders() {
  return await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
  });
}

// ===============================
// LINE Webhook
// ===============================
app.post("/webhook", (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("Webhook Error:", err);
    });
});

// ===============================
// 處理訊息
// ===============================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();

  // 新增：新增 商品 數量 金額 備註
  if (text.startsWith("新增 ")) {
    const parts = text.replace("新增 ", "").split(" ");

    const data = {
      customer: event.source.userId,
      item: parts[0],
      qty: Number(parts[1]),
      price: Number(parts[2]),
      note: parts[3] || "",
    };

    await addOrder(data);

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "✔ 已新增到 Notion！"
    });
  }

  // 查詢
  if (text === "查詢") {
    const results = await queryOrders();
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: `目前有 ${results.results.length} 筆訂單`,
    });
  }

  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: "❓ 指令錯誤"
  });
}

// ===============================
// 啟動
// ===============================
app.listen(3000, () => {
  console.log("Server running on port 3000");
});
