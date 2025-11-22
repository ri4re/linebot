// index.js — 魚魚專用 LINE Bot + Notion 後台 (使用 NOTION_SECRET)
// 前提：package.json 必須有 "type": "module"

import express from "express";
import { Client } from "@notionhq/client";
import line from "@line/bot-sdk";

// -------------------- 基本設定 --------------------
const app = express();
app.use(express.json());

// 你的 Notion Database
const NOTION_DATABASE_ID = "2ad2cb1210c78097b48efff75cf10c00";

// 🔥 改成使用 NOTION_SECRET（Render 也要用這個變數）
const notion = new Client({
  auth: process.env.NOTION_SECRET,
});

// Notion 欄位名稱設定
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

// -------------------- 小工具 --------------------
function getRichTextText(richTextArray) {
  if (!Array.isArray(richTextArray) || richTextArray.length === 0) return "";
  return richTextArray.map((t) => t.plain_text || "").join("");
}

function formatError(err) {
  console.error("❌ Notion API Error:", JSON.stringify(err, null, 2));
  return `Notion 錯誤: ${err.message}`;
}

// 官方 SDK 查詢
async function queryDatabase(filter) {
  const params = {
    database_id: NOTION_DATABASE_ID,
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  };
  if (filter) params.filter = filter;
  const res = await notion.databases.query(params);
  return res.results;
}

// 根據流水號找 Page ID
async function findPageIdByShortId(shortId) {
  const pureId = shortId.toUpperCase().replace(/[^0-9]/g, "");
  if (!pureId) return null;

  const pages = await queryDatabase({
    property: PROPS.shortIdField,
    unique_id: { equals: Number(pureId) },
  });

  return pages.length ? pages[0].id : null;
}

// 顯示流水號
function getShortIdFromPage(page) {
  const p = page.properties[PROPS.shortIdField];
  if (p?.type === "unique_id" && p.unique_id?.number) {
    const prefix = p.unique_id.prefix || "";
    return `${prefix}${p.unique_id.number}`;
  }
  return "ID?";
}

// -------------------- 解析文字 --------------------
function parseQuickOrder(text) {
  const key = Object.keys(QUICK_PRODUCTS).find(k => text.startsWith(k));
  if (!key) return null;

  const rest = text.slice(key.length).trim();
  if (!rest) return null;

  const parts = rest.split(/\s+/);
  const numbers = parts.filter(p => /^\d+(\.\d+)?$/.test(p));
  const others = parts.filter(p => !/^\d+(\.\d+)?$/.test(p));

  let quantity = 1, amount = 0;
  if (numbers.length >= 2) { quantity = Number(numbers[0]); amount = Number(numbers[1]); }
  else if (numbers.length === 1) { amount = Number(numbers[0]); }
  else return null;

  return {
    customerName: "魚魚",
    productName: QUICK_PRODUCTS[key],
    quantity,
    amount,
    memo: others.join(" "),
  };
}

function parseNormalOrder(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 4) return null;

  const [customerName, productName, qtyStr, amountStr, ...rest] = parts;

  if (!/^\d+$/.test(qtyStr) || !/^\d+$/.test(amountStr)) return null;

  return {
    customerName,
    productName,
    quantity: Number(qtyStr),
    amount: Number(amountStr),
    memo: rest.join(" "),
  };
}

function parseOrder(text) {
  return parseQuickOrder(text) || parseNormalOrder(text);
}

function parseUpdate(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3 || parts[0] !== "改") return null;

  const shortId = parts[1].trim();
  const updates = { shortId };

  for (let i = 2; i < parts.length; i++) {
    const p = parts[i];
    const next = parts[i + 1];

    if (p === "付清") {
      updates.status = PAYMENT_STATUS.PAID;
      updates.paidAmount = "FULL";
    }
    else if (p === "已付" && next && /^\d+$/.test(next)) {
      updates.paidAmount = Number(next);
      i++;
    }
    else if (p.startsWith("備註:")) {
      updates.memo = parts.slice(i).join(" ").replace("備註:", "").trim();
      break;
    }
  }
  return updates;
}

// -------------------- Notion 寫入 --------------------
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
  const current = await notion.pages.retrieve({ page_id: pageId });

  const amount = current.properties[PROPS.amount]?.number || 0;
  const paid = current.properties[PROPS.paidAmount]?.number || 0;

  let newPaid = paid;
  let newStatus = updates.status;

  if (updates.paidAmount === "FULL") newPaid = amount;
  else if (typeof updates.paidAmount === "number") newPaid = updates.paidAmount;

  if (!newStatus) {
    if (newPaid >= amount) newStatus = PAYMENT_STATUS.PAID;
    else if (newPaid > 0) newStatus = PAYMENT_STATUS.PARTIAL;
    else newStatus = PAYMENT_STATUS.UNPAID;
  }

  properties[PROPS.paidAmount] = { number: newPaid };
  properties[PROPS.paymentStatus] = { select: { name: newStatus } };

  if (updates.memo !== undefined)
    properties[PROPS.memo] = { rich_text: [{ text: { content: updates.memo } }] };

  return await notion.pages.update({ page_id: pageId, properties });
}

// -------------------- LINE 處理 --------------------
async function handleTextMessage(event) {
  const text = event.message.text.trim();
  const reply = event.replyToken;

  if (text === "格式" || text === "幫助") {
    return lineClient.replyMessage(reply, {
      type: "text",
      text: "📌 指令：\n• 魚魚 商品 1 100\n• 改 27 已付 100\n• 查 魚魚\n• 未付",
    });
  }

  try {
    // 修改訂單
    if (text.startsWith("改 ")) {
      const update = parseUpdate(text);
      if (!update) return lineClient.replyMessage(reply, { type: "text", text: "格式錯誤❌" });

      const pageId = await findPageIdByShortId(update.shortId);
      if (!pageId) return lineClient.replyMessage(reply, { type: "text", text: `找不到流水號 ${update.shortId}` });

      const p = await updateOrder(pageId, update);
      const sid = getShortIdFromPage(p);

      return lineClient.replyMessage(reply, {
        type: "text",
        text: `✅ 更新成功 [${sid}]`,
      });
    }

    // 查未付
    if (text === "未付" || text === "欠款") {
      const pages = await queryDatabase({
        or: [
          { property: PROPS.paymentStatus, select: { equals: PAYMENT_STATUS.UNPAID } },
          { property: PROPS.paymentStatus, select: { equals: PAYMENT_STATUS.PARTIAL } },
        ],
      });

      if (!pages.length)
        return lineClient.replyMessage(reply, { type: "text", text: "👍 沒有欠款" });

      const lines = pages.slice(0, 10).map(p => {
        const sid = getShortIdFromPage(p);
        const name = getRichTextText(p.properties[PROPS.customerName]?.rich_text);
        const amount = p.properties[PROPS.amount]?.number || 0;
        const paid = p.properties[PROPS.paidAmount]?.number || 0;
        return `[${sid}] ${name}｜剩$${amount - paid}`;
      });

      return lineClient.replyMessage(reply, { type: "text", text: lines.join("\n") });
    }

    // 查客人
    if (text.startsWith("查 ")) {
      const name = text.slice(2).trim();

      const pages = await queryDatabase({
        property: PROPS.customerName,
        rich_text: { contains: name },
      });

      if (!pages.length)
        return lineClient.replyMessage(reply, { type: "text", text: "找不到訂單" });

      const lines = pages.slice(0, 10).map(p => {
        const sid = getShortIdFromPage(p);
        const prod = getRichTextText(p.properties[PROPS.productName]?.rich_text);
        const status = p.properties[PROPS.paymentStatus]?.select?.name;
        return `[${sid}] ${prod}｜${status}`;
      });

      return lineClient.replyMessage(reply, { type: "text", text: lines.join("\n") });
    }

    // 新增訂單
    const order = parseOrder(text);
    if (order) {
      const p = await createOrder(order, text);
      return lineClient.replyMessage(reply, {
        type: "text",
        text: `✅ 訂單成立 [${getShortIdFromPage(p)}]`,
      });
    }

    return lineClient.replyMessage(reply, { type: "text", text: "聽不懂 QQ" });

  } catch (err) {
    return lineClient.replyMessage(reply, { type: "text", text: formatError(err) });
  }
}

// -------------------- Webhook --------------------
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];
  await Promise.all(
    events.map(e =>
      e.type === "message" && e.message.type === "text"
        ? handleTextMessage(e)
        : null
    )
  );
  res.json({ status: "ok" });
});

app.listen(process.env.PORT || 10000, () => console.log("Server running"));

