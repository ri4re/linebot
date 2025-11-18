// ===============================
// FishOrder LINE Bot + Notion（完整版）
// 支援：新增、查詢、查付款狀態、關鍵字查詢
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
// 📝 新增訂單（付款狀態先不指定）
// ===============================
async function addOrder(data) {
  return await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      "客人名稱": { rich_text: [{ text: { content: data.customer } }] },
      "商品名稱": { rich_text: [{ text: { content: data.item } }] },
      "數量": { number: data.qty },
      "金額": { number: data.price },
      "備註": { rich_text: [{ text: { content: data.note } }] },
      "付款狀態": { select: null }   // 不預設，保持空白
    }
  });
}

// ===============================
// 🔍 查詢：文字（客人 + 商品）
// ===============================
async function queryText(keyword) {
  return await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      or: [
        {
          property: "客人名稱",
          rich_text: { contains: keyword }
        },
        {
          property: "商品名稱",
          rich_text: { contains: keyword }
        }
      ]
    }
  });
}

// ===============================
// 🔍 查詢：付款狀態（Select）
// ===============================
async function queryPayStatus(statusName) {
  return await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      property: "付款狀態",
      select: { equals: statusName }
    }
  });
}

// ===============================
// 🔄 修改付款狀態
// 指令格式：改付款 魚魚 已付
// ===============================
async function updatePayStatus(name, status) {
  const search = await queryText(name);
  if (search.results.length === 0) return null;

  const pageId = search.results[0].id;

  return await notion.pages.update({
    page_id: pageId,
    properties: {
      "付款狀態": { select: { name: status } }
    }
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
// 🧠 處理訊息
// ===============================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();

  // ===========
  // ① 查詢全部
  // ===========
  if (text === "查詢") {
    const list = await notion.databases.query({ database_id: NOTION_DATABASE_ID });
    return reply(event, `📦 目前共有 ${list.results.length} 筆訂單`);
  }

  // ===========
  // ② 查詢：關鍵字
  // ===========
  if (text.startsWith("查")) {
    let keyword = text.replace("查", "").trim(); // 支援「查魚魚」與「查 魚魚」

    const payStatusList = ["未付款", "已付全部款項", "已付部分付款", "待確認", "已取消退款"];

    // 查付款狀態（Select）
    if (payStatusList.includes(keyword)) {
      const res = await queryPayStatus(keyword);
      return reply(event, `💰 付款狀態「${keyword}」共有 ${res.results.length} 筆`);
    }

    // 查文字（客人名稱 + 商品名稱）
    const res = await queryText(keyword);
    return reply(event, `🔍 搜尋「${keyword}」共有 ${res.results.length} 筆`);
  }

  // ===========
  // ③ 修改付款狀態
  // 格式：改付款 魚魚 已付款
  // ===========
  if (text.startsWith("改付款")) {
    const parts = text.split(" ");

    if (parts.length < 3) {
      return reply(event, "格式錯誤：改付款 客人名稱 付款狀態");
    }

    const name = parts[1];
    const status = parts[2];

    const res = await updatePayStatus(name, status);
    if (!res) return reply(event, `找不到「${name}」的訂單`);

    return reply(event, `✔ 已修改：${name} → ${status}`);
  }

  // ===========
  // ④ 格式指令
  // ===========
  if (text === "格式") {
    return reply(event,
      `📌 使用格式：\n客人 商品 數量 金額 備註\n例：魚魚 相卡 2 350 宅配`
    );
  }

  // ===========
  // ⑤ 新增訂單
  // ===========
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
    return reply(event, `✔ 已新增：${data.customer} / ${data.item}（${data.qty}）`);
  }

  // ===========
  // ⑥ 全部不符合 → 錯誤
  // ===========
  return reply(event, "❓ 指令錯誤（輸入「格式」查看範例）");
}

// ===============================
// 快速回覆
// ===============================
function reply(event, msg) {
  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: msg,
  });
}

// ===============================
// 🚀 啟動
// ===============================
app.listen(3000, () => {
  console.log("Server running on 3000");
});
