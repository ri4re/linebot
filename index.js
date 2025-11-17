// ===============================
// FishOrder LINE Bot + Notion 連動（最終完整版）
// ES Module (type: module) 專用
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
const lineClient = new line.Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
});

// ===============================
// 📝 寫入 Notion（符合你的欄位）
// ===============================
async function addOrder(data) {
  return await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      "客人名稱": {
        rich_text: [{ text: { content: data.customer } }]
      },
      "商品名稱": {
        rich_text: [{ text: { content: data.item } }]
      },
      "數量": {
        number: data.qty
      },
      "金額": {
        number: data.price
      },
      "備註": {
        rich_text: [{ text: { content: data.note } }]
      },
      "付款狀態": {
        select: { name: "未付款" }
      }
    }
  });
}

// ===============================
// 🔍 查詢 Notion 全部
// ===============================
async function queryAll() {
  return await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
  });
}

// ===============================
// 🔍 查詢：某個人 or 某個商品
// ===============================
async function queryKeyword(keyword) {
  return await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      or: [
        {
          property: "客人名稱",
          rich_text: {
            contains: keyword,
          },
        },
        {
          property: "商品名稱",
          rich_text: {
            contains: keyword,
          },
        }
      ],
    },
  });
}

// ===============================
// LINE Webhook
// ===============================
app.post("/webhook", (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => console.error(err));
});

// ===============================
// 🧠 處理訊息（你的專屬格式）
// ===============================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();

  // ⭐⭐ 指令：查詢全部 ⭐⭐
  if (text === "查詢") {
    const list = await queryAll();
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: `📦 目前共有 ${list.results.length} 筆訂單`,
    });
  }

  // ⭐⭐ 指令：查 XXX ⭐⭐
  if (text.startsWith("查 ")) {
    const keyword = text.replace("查 ", "").trim();
    const res = await queryKeyword(keyword);

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: `🔍 搜尋「${keyword}」共有 ${res.results.length} 筆。`,
    });
  }

  // ⭐⭐ 指令：格式 ⭐⭐
  if (text === "格式") {
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: `📌 使用格式：\n客人 商品 數量 金額 備註\n例：魚魚 相卡 2 350 宅配`,
    });
  }

  // ===============================
  // ⭐⭐ 解析你的專屬輸入格式 ⭐⭐
  // 例如：魚魚 相卡 2 350 宅配
  // ===============================
  const parts = text.split(" ");

  if (parts.length >= 4) {
    const data = {
      customer: parts[0],
      item: parts[1],
      qty: Number(parts[2]),
      price: Number(parts[3]),
      note: parts[4] || "",
    };

    await addOrder(data);

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: `✔ 已新增：${data.customer} / ${data.item}（${data.qty}）`,
    });
  }

  // ⭐⭐ 其他不符合 → 指令錯誤 ⭐⭐
  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: "❓ 指令錯誤（輸入「格式」查看範例）",
  });
}

// ===============================
// 🚀 啟動
// ===============================
app.listen(3000, () => {
  console.log("Server running on 3000");
});
