// ===============================
// LINE Bot + Notion 連動（正式版）
// ===============================

require("dotenv").config();
const express = require("express");
const { Client } = require("@notionhq/client");
const line = require("@line/bot-sdk");

const app = express();
app.use(express.json());

// ===============================
// 🔑 讀取環境變數（Render 用）
// ===============================
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;   // 你只要貼 32碼版本
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

// ===============================
// Notion Client
// ===============================
const notion = new Client({ auth: NOTION_API_KEY });

// ===============================
// LINE Client
// ===============================
const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

// ===============================
// 📝 Notion 新增資料
// ===============================
async function addOrderToNotion(orderData) {
  try {
    const res = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        "客人": { title: [{ text: { content: orderData.customer } }] },
        "商品": { rich_text: [{ text: { content: orderData.item } }] },
        "數量": { number: orderData.qty },
        "金額": { number: orderData.price },
        "備註": { rich_text: [{ text: { content: orderData.note } }] },
        "付款狀態": { select: { name: orderData.status } },
      }
    });
    return res;
  } catch (err) {
    console.error("❌ Notion 寫入失敗：", err);
    throw err;
  }
}

// ===============================
// 🔍 查詢 Notion
// ===============================
async function queryOrders() {
  try {
    const res = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
    });
    return res.results;
  } catch (err) {
    console.error("❌ Notion 查詢失敗：", err);
    throw err;
  }
}

// ===============================
// LINE Webhook
// ===============================
app.post("/webhook", (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result));
});

// ===============================
// LINE 訊息處理
// ===============================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();

  // 範例：新增資料
  if (text.startsWith("新增 ")) {
    const parts = text.replace("新增 ", "").split(" ");
    const order = {
      customer: event.source.userId,  // 或你要改成自動抓 LINE 名稱
      item: parts[0],
      qty: Number(parts[1]),
      price: Number(parts[2]),
      note: parts[3] || "",
      status: "未付款",
    };

    await addOrderToNotion(order);
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "✅ Notion 已新增訂單！",
    });
  }

  // 查詢 Notion
  if (text === "查詢") {
    const list = await queryOrders();
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: `目前有 ${list.length} 筆訂單`,
    });
  }

  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: "❓ 指令錯誤，請重新輸入。",
  });
}

// ===============================
// 啟動 Server
// ===============================
app.listen(3000, () => {
  console.log("Server running on 3000");
});
