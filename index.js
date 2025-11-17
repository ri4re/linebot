// index.js — 魚魚專用 LINE Bot + Notion 後台（Select 版本）
// 前提：package.json 有 "type": "module"

import express from "express";
import { Client } from "@notionhq/client";
import line from "@line/bot-sdk";

// ---------- 0. 基本設定 ----------

const app = express();
app.use(express.json());

// Notion Client
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Notion 欄位名稱（請確認完全一致）
const PROPS = {
  title: "信箱",            
  customerName: "客人名稱",   
  productName: "商品名稱",    
  quantity: "數量",         
  amount: "金額",           
  paidAmount: "已付金額",   
  paymentStatus: "付款狀態",  
  memo: "備註",             
  updatedAt: "更新日期",    
};

// LINE 設定
const lineClient = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// 快速商品對應
const QUICK_PRODUCTS = {
  "代收": "代收包裹",
  "代付": "代支付",
  "代拆專輯": "代拆",
  "代抽": "票券代抽",
  "運費": "包裹寄送",
};

// ---------- 小工具 ----------
function getRichTextText(arr) {
  if (!Array.isArray(arr)) return "";
  return arr.map(t => t.plain_text || "").join("");
}

function shortId(id) {
  return id.replace(/-/g, "").slice(0, 6);
}

// Notion query（自訂 request）
async function queryDatabase(filter) {
  const res = await notion.request({
    path: `databases/${NOTION_DATABASE_ID}/query`,
    method: "POST",
    body: {
      filter,
      sorts: [
        {
          property: PROPS.updatedAt,
          direction: "descending",
        },
      ],
    },
  });

  return res.results;
}

// ---------- 解析文字 → 訂單 ----------
function parseQuickOrder(text) {
  const key = Object.keys(QUICK_PRODUCTS).find(k => text.startsWith(k));
  if (!key) return null;

  const rest = text.slice(key.length).trim();
  const parts = rest.split(/\s+/);

  const nums = parts.filter(v => /^\d+(\.\d+)?$/.test(v));
  const other = parts.filter(v => !/^\d+(\.\d+)?$/.test(v));

  let quantity = 1;
  let amount = 0;

  if (nums.length >= 2) {
    quantity = Number(nums[0]);
    amount = Number(nums[1]);
  } else if (nums.length === 1) {
    amount = Number(nums[0]);
  } else return null;

  return {
    customerName: "魚魚",
    productName: QUICK_PRODUCTS[key],
    quantity,
    amount,
    memo: other.join(" "),
  };
}

function parseNormalOrder(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 4) return null;

  const [customerName, productName, qtyStr, amountStr, ...rest] = parts;
  if (!/^\d+(\.\d+)?$/.test(qtyStr) || !/^\d+(\.\d+)?$/.test(amountStr)) return null;

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

// ---------- 新增訂單 ----------
async function createOrder(order, userDisplayName) {
  const nowIso = new Date().toISOString();

  const page = await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      [PROPS.title]: {
        title: [
          { text: { content: userDisplayName || `${order.customerName}｜${order.productName}` } }
        ],
      },
      [PROPS.customerName]: { rich_text: [{ text: { content: order.customerName } }] },
      [PROPS.productName]: { rich_text: [{ text: { content: order.productName } }] },
      [PROPS.quantity]: { number: order.quantity },
      [PROPS.amount]: { number: order.amount },
      [PROPS.paidAmount]: { number: 0 },

      // **❗改成 select（符合你現在欄位類型）**
      [PROPS.paymentStatus]: { select: { name: "未付款" } },

      [PROPS.memo]: order.memo ? { rich_text: [{ text: { content: order.memo } }] } : { rich_text: [] },
      [PROPS.updatedAt]: { date: { start: nowIso } },
    },
  });

  return page;
}

// ---------- 查詢 ----------
async function queryUnpaid() {
  return queryDatabase({
    property: PROPS.paymentStatus,
    select: { equals: "未付款" },
  });
}

async function queryByCustomer(name) {
  return queryDatabase({
    property: PROPS.customerName,
    rich_text: { contains: name },
  });
}

async function queryByProduct(keyword) {
  return queryDatabase({
    property: PROPS.productName,
    rich_text: { contains: keyword },
  });
}

// ---------- LINE 指令處理 ----------
function helpText() {
  return [
    "可用格式：客人 商品 數量 金額 備註",
    "例：",
    "• 魚魚 官方相卡 2 350 宅配",
    "• 代收 3 150 宅配",
    "• 查 魚魚",
    "• 查商品 相卡",
    "• 未付 / 欠款",
  ].join("\n");
}

async function handleText(event) {
  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  // 格式
  if (text === "格式") {
    return lineClient.replyMessage(replyToken, { type: "text", text: helpText() });
  }

  // 未付款查詢
  if (text === "未付" || text === "欠款") {
    const pages = await queryUnpaid();
    if (pages.length === 0)
      return lineClient.replyMessage(replyToken, { type: "text", text: "目前沒有未付款訂單。" });

    const lines = pages.map((p, i) => {
      const props = p.properties;
      const c = getRichTextText(props[PROPS.customerName].rich_text);
      const prod = getRichTextText(props[PROPS.productName].rich_text);
      const amt = props[PROPS.amount].number ?? 0;
      const paid = props[PROPS.paidAmount].number ?? 0;
      const remain = amt - paid;

      return `${i + 1}️⃣ ${c}｜${prod}｜$${amt}｜已付$${paid}｜剩$${remain}\nID：${shortId(p.id)}`;
    });

    return lineClient.replyMessage(replyToken, {
      type: "text",
      text: `未付款訂單：\n\n${lines.join("\n\n")}`,
    });
  }

  // 查客人
  if (text.startsWith("查 ")) {
    const key = text.slice(2).trim();
    const pages = await queryByCustomer(key);

    if (pages.length === 0)
      return lineClient.replyMessage(replyToken, { type: "text", text: `找不到「${key}」的訂單。` });

    const lines = pages.map((p, i) => {
      const props = p.properties;
      return `${i + 1}️⃣ ${getRichTextText(props[PROPS.customerName].rich_text)}｜${getRichTextText(props[PROPS.productName].rich_text)}｜$${props[PROPS.amount].number || 0}\nID：${shortId(p.id)}`;
    });

    return lineClient.replyMessage(replyToken, {
      type: "text",
      text: `查「${key}」結果：\n\n${lines.join("\n\n")}`,
    });
  }

  // 查商品
  if (text.startsWith("查商品")) {
    const key = text.replace("查商品", "").trim();
    const pages = await queryByProduct(key);

    if (pages.length === 0)
      return lineClient.replyMessage(replyToken, { type: "text", text: `找不到商品「${key}」的訂單。` });

    const lines = pages.map((p, i) => {
      const props = p.properties;
      return `${i + 1}️⃣ ${getRichTextText(props[PROPS.customerName].rich_text)}｜${getRichTextText(props[PROPS.productName].rich_text)}｜$${props[PROPS.amount].number || 0}\nID：${shortId(p.id)}`;
    });

    return lineClient.replyMessage(replyToken, {
      type: "text",
      text: `查商品「${key}」結果：\n\n${lines.join("\n\n")}`,
    });
  }

  // 其他 → 新增訂單
  const order = parseOrder(text);
  if (!order) {
    return lineClient.replyMessage(replyToken, { type: "text", text: "格式錯誤，請輸入「格式」查看示範。" });
  }

  const page = await createOrder(order, "LINE 訂單");

  return lineClient.replyMessage(replyToken, {
    type: "text",
    text: [
      "✅ 已新增訂單",
      `客人：${order.customerName}`,
      `商品：${order.productName}`,
      `數量：${order.quantity}`,
      `金額：${order.amount}`,
      order.memo ? `備註：${order.memo}` : "",
      `ID：${shortId(page.id)}`,
    ].join("\n"),
  });
}

// ---------- LINE webhook ----------
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];
  await Promise.all(events.map(evt => {
    if (evt.message?.type === "text") return handleText(evt);
  }));
  res.send("OK");
});

// ---------- 啟動 ----------
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server running on ${port}`));
