// index.js — 魚魚專用 LINE Bot + Notion 後台 (官方 SDK 查詢版)
// 前提：package.json 有 "type": "module"

import express from "express";
import { Client } from "@notionhq/client";
import line from "@line/bot-sdk";

// ---------- 0. 基本設定 ----------

const app = express();
app.use(express.json());

// ✅ 直接硬寫 ID，排除變數讀取問題
const NOTION_DATABASE_ID = "2ad2cb1210c78097b48efff75cf10c00";

// Notion Client
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

// Notion 欄位名稱
const PROPS = {
  title: "信箱",
  customerName: "客人名稱",
  productName: "商品名稱",
  quantity: "數量",
  amount: "金額",
  paidAmount: "已付金額",
  paymentStatus: "付款狀態",
  memo: "備註",
  shortIdField: "流水號",
};

// LINE 設定
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

// 快速商品對應
const QUICK_PRODUCTS = {
  "代收": "代收包裹",
  "代付": "代支付",
  "代拆專輯": "代拆",
  "代抽": "票券代抽",
  "運費": "包裹寄送",
};

// 付款狀態
const PAYMENT_STATUS = {
  UNPAID: "未付款",
  PARTIAL: "部分付款",
  PAID: "已付款",
};

// ---------- 小工具 ----------

function getRichTextText(richTextArray) {
  if (!Array.isArray(richTextArray) || richTextArray.length === 0) return "";
  return richTextArray.map((t) => t.plain_text || "").join("");
}

function formatError(err) {
    // 印出完整錯誤到後台，方便除錯
    console.error("Notion API Error Details:", JSON.stringify(err, null, 2));
    
    if (err.code === 'object_not_found') return "Notion 找不到資料庫，請檢查 ID 或權限";
    if (err.code === 'validation_error') return "Notion 欄位格式錯誤，請檢查程式碼與 Notion 設定是否一致";
    return `Notion 錯誤: ${err.message}`;
}

// 🌟 重大修改：改用 notion.databases.query (SDK 原生方法)
// 不要再手動拼網址了，這樣可以避免 invalid_request_url
async function queryDatabase(filter) {
  const params = {
    database_id: NOTION_DATABASE_ID,
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  };
  if (filter) { params.filter = filter; }
  
  // 使用官方 SDK 方法，而不是 notion.request
  const res = await notion.databases.query(params);
  return res.results;
}

// 根據「流水號」找到 Page ID
async function findPageIdByShortId(shortId) {
    const pureId = shortId.toUpperCase().replace(/[^0-9]/g, ''); 
    if (!pureId) return null;
    
    const pages = await queryDatabase({
        property: PROPS.shortIdField,
        unique_id: { equals: Number(pureId) },
    }); 
    return pages.length > 0 ? pages[0].id : null;
}

function getShortIdFromPage(page) {
    const property = page.properties[PROPS.shortIdField];
    if (property?.type === 'unique_id' && property.unique_id?.number) {
        const prefix = property.unique_id.prefix || '';
        return `${prefix}${property.unique_id.number}`;
    }
    return 'ID?'; 
}

// ---------- 1. 解析文字 ----------

function parseQuickOrder(text) {
  const key = Object.keys(QUICK_PRODUCTS).find((k) => text.startsWith(k));
  if (!key) return null;
  const rest = text.slice(key.length).trim();
  if (!rest) return null;
  const parts = rest.split(/\s+/);
  const numbers = parts.filter((p) => /^\d+(\.\d+)?$/.test(p));
  const others = parts.filter((p) => !/^\d+(\.\d+)?$/.test(p));
  let quantity = 1, amount = 0;
  if (numbers.length >= 2) { quantity = Number(numbers[0]); amount = Number(numbers[1]); } 
  else if (numbers.length === 1) { amount = Number(numbers[0]); } 
  else { return null; }
  return { customerName: "魚魚", productName: QUICK_PRODUCTS[key], quantity, amount, memo: others.join(" ") };
}

function parseNormalOrder(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 4) return null;
  const [customerName, productName, qtyStr, amountStr, ...rest] = parts;
  if (!/^\d+(\.\d+)?$/.test(qtyStr) || !/^\d+(\.\d+)?$/.test(amountStr)) return null;
  return { customerName, productName, quantity: Number(qtyStr), amount: Number(amountStr), memo: rest.join(" ") };
}

function parseOrder(text) {
  return parseQuickOrder(text) || parseNormalOrder(text);
}

function parseUpdate(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3 || parts[0] !== "改") return null;
  const shortId = parts[1].toUpperCase().trim(); 
  if (!shortId) return null;
  const updates = { shortId };
  for (let i = 2; i < parts.length; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];
    if (part === "付清") { updates.status = PAYMENT_STATUS.PAID; updates.paidAmount = "FULL"; } 
    else if (part === "已付" && nextPart && /^\d+(\.\d+)?$/.test(nextPart)) { updates.paidAmount = Number(nextPart); i++; } 
    else if (part.startsWith("備註:")) { updates.memo = parts.slice(i).join(" ").substring(3).trim(); break; } 
    else if (part.startsWith("狀態:")) {
      const statusText = part.substring(3).trim();
      const statusValue = Object.values(PAYMENT_STATUS).find(v => v.includes(statusText));
      if (statusValue) { updates.status = statusValue; }
    }
  }
  return Object.keys(updates).length > 1 ? updates : null;
}

// ---------- 2. 寫入 Notion ----------

async function createOrder(order, originalText) {
  return await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      [PROPS.title]: { title: [{ text: { content: originalText } }] },
      [PROPS.customerName]: { rich_text: [{ text: { content: order.customerName } }] },
      [PROPS.productName]: { rich_text: [{ text: { content: order.productName } }] },
      [PROPS.quantity]: { number: order.quantity },
      [PROPS.amount]: { number: order.amount },
      [PROPS.paidAmount]: { number: 0 },
      [PROPS.paymentStatus]: { select: { name: PAYMENT_STATUS.UNPAID } }, 
      [PROPS.memo]: { rich_text: order.memo ? [{ text: { content: order.memo } }] : [] },
    },
  });
}

async function updateOrder(pageId, updates) {
  const properties = {};
  if (updates.paidAmount !== undefined || updates.status) {
    const currentPage = await notion.pages.retrieve({ page_id: pageId });
    const currentAmount = currentPage.properties[PROPS.amount]?.number ?? 0;
    const currentPaid = currentPage.properties[PROPS.paidAmount]?.number ?? 0;
    let newPaidAmount = updates.paidAmount === "FULL" ? currentAmount : (updates.paidAmount ?? currentPaid);
    let newStatus = updates.status;
    
    if (!newStatus) {
        if (newPaidAmount >= currentAmount && currentAmount > 0) newStatus = PAYMENT_STATUS.PAID;
        else if (newPaidAmount > 0) newStatus = PAYMENT_STATUS.PARTIAL;
        else newStatus = PAYMENT_STATUS.UNPAID;
    }
    if (newPaidAmount !== undefined) properties[PROPS.paidAmount] = { number: newPaidAmount };
    if (newStatus) properties[PROPS.paymentStatus] = { select: { name: newStatus } };
  }
  if (updates.memo !== undefined) properties[PROPS.memo] = { rich_text: [{ text: { content: updates.memo } }] };
  
  return await notion.pages.update({ page_id: pageId, properties });
}

// ---------- 3. LINE 處理 ----------

async function handleTextMessage(event) {
  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  if (text === "格式" || text === "幫助") {
    return lineClient.replyMessage(replyToken, { type: "text", text: "📌 指令：\n• 魚魚 商品 1 100\n• 改 27 已付 100\n• 查 魚魚\n• 未付" });
  }

  try {
    // A. 修改
    if (text.startsWith("改 ")) {
      const update = parseUpdate(text);
      if (!update) return lineClient.replyMessage(replyToken, { type: "text", text: "格式錯誤❌" });
      const pageId = await findPageIdByShortId(update.shortId);
      if (!pageId) return lineClient.replyMessage(replyToken, { type: "text", text: `找不到流水號 ${update.shortId}` });
      
      const p = await updateOrder(pageId, update);
      const sid = getShortIdFromPage(p);
      const status = p.properties[PROPS.paymentStatus]?.select?.name;
      const paid = p.properties[PROPS.paidAmount]?.number;
      return lineClient.replyMessage(replyToken, { type: "text", text: `✅ 更新成功 [${sid}]\n狀態：${status}｜已付：$${paid}` });
    }

    // B. 查詢未付
    if (text === "未付" || text === "欠款") {
      const pages = await queryDatabase({
        or: [
          { property: PROPS.paymentStatus, select: { equals: PAYMENT_STATUS.UNPAID } },
          { property: PROPS.paymentStatus, select: { equals: PAYMENT_STATUS.PARTIAL } },
        ]
      });
      if (pages.length === 0) return lineClient.replyMessage(replyToken, { type: "text", text: "👍 沒有欠款" });
      const lines = pages.slice(0, 10).map(p => {
          const sid = getShortIdFromPage(p);
          const c = getRichTextText(p.properties[PROPS.customerName]?.rich_text);
          const r = (p.properties[PROPS.amount]?.number||0) - (p.properties[PROPS.paidAmount]?.number||0);
          return `[${sid}] ${c}｜剩$${r}`;
      });
      return lineClient.replyMessage(replyToken, { type: "text", text: `未付清單：\n${lines.join("\n")}` });
    }

    // C. 查客人
    if (text.startsWith("查 ")) {
      const name = text.slice(2).trim();
      const pages = await queryDatabase({ property: PROPS.customerName, rich_text: { contains: name } });
      if (pages.length === 0) return lineClient.replyMessage(replyToken, { type: "text", text: "找不到訂單" });
      const lines = pages.slice(0, 8).map(p => {
          const sid = getShortIdFromPage(p);
          const prod = getRichTextText(p.properties[PROPS.productName]?.rich_text);
          const s = p.properties[PROPS.paymentStatus]?.select?.name;
          return `[${sid}] ${prod}｜${s}`;
      });
      return lineClient.replyMessage(replyToken, { type: "text", text: `🔍 ${name} 的訂單：\n${lines.join("\n")}` });
    }

    // D. 新增訂單
    const order = parseOrder(text);
    if (order) {
      const p = await createOrder(order, text);
      return lineClient.replyMessage(replyToken, { type: "text", text: `✅ 訂單成立 [${getShortIdFromPage(p)}]` });
    }
    
    return lineClient.replyMessage(replyToken, { type: "text", text: "聽不懂 QQ" });

  } catch (err) {
    return lineClient.replyMessage(replyToken, { type: "text", text: formatError(err) });
  }
}

app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];
  await Promise.all(events.map(async e => (e.type === "message" && e.message.type === "text") ? handleTextMessage(e) : null));
  res.json({ status: "ok" });
});

app.listen(process.env.PORT || 10000, () => console.log("Server running"));
