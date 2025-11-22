// index.js — 魚魚專用 LINE Bot + Notion 後台 (修正版 v2)
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

// ✅ 請直接複製這一行，填入你的純 ID
const NOTION_DATABASE_ID = "2ad2cb1210c78097b48efff75cf10c00";

// Notion 欄位名稱（與你的截圖完全對應）
const PROPS = {
  title: "信箱",           // Aa Title 欄位
  customerName: "客人名稱", // Text 欄位
  productName: "商品名稱",  // Text 欄位
  quantity: "數量",        // Number 欄位
  amount: "金額",          // Number 欄位
  paidAmount: "已付金額",  // Number 欄位
  paymentStatus: "付款狀態", // Select (單選) 欄位
  memo: "備註",            // Text 欄位
  shortIdField: "流水號",   // Unique ID 欄位 (Nº)
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

// 付款狀態名稱（必須跟 Notion 選項完全一致）
const PAYMENT_STATUS = {
  UNPAID: "未付款",
  PARTIAL: "部分付款",
  PAID: "已付款",
};

// ---------- 小工具 ----------

// 安全拿 rich_text 的純文字
function getRichTextText(richTextArray) {
  if (!Array.isArray(richTextArray) || richTextArray.length === 0) return "";
  return richTextArray.map((t) => t.plain_text || "").join("");
}

// 錯誤處理小工具
function formatError(err) {
    if (err.body) {
        try {
            const body = JSON.parse(err.body);
            return `Notion 錯誤: ${body.message}`;
        } catch (e) {
            return `Notion 錯誤: ${err.message}`;
        }
    }
    return `錯誤: ${err.message}`;
}

// 共用查詢：改用 timestamp 排序，避免欄位錯誤
async function queryDatabase(filter) {
  const body = {
    // 使用系統內建的最後編輯時間排序，最穩健
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  };
  if (filter) { body.filter = filter; }
  
  const res = await notion.request({
    path: `databases/${NOTION_DATABASE_ID}/query`,
    method: "POST",
    body,
  });
  return res.results;
}

// 根據「流水號」找到 Page ID
async function findPageIdByShortId(shortId) {
    // 提取純數字，例如 FISH-27 -> 27
    const pureId = shortId.toUpperCase().replace(/[^0-9]/g, ''); 
    if (!pureId) return null;
    
    // 使用 unique_id 進行查詢
    const pages = await queryDatabase({
        property: PROPS.shortIdField, // "流水號"
        unique_id: { equals: Number(pureId) },
    }); 
    return pages.length > 0 ? pages[0].id : null;
}

// 從 page 物件中讀取「流水號」顯示用
function getShortIdFromPage(page) {
    const property = page.properties[PROPS.shortIdField];
    if (property?.type === 'unique_id' && property.unique_id?.number) {
        const prefix = property.unique_id.prefix || '';
        return `${prefix}${property.unique_id.number}`;
    }
    return 'ID?'; 
}


// ---------- 1. 解析文字 → 訂單結構或指令 ----------

function parseQuickOrder(text) {
  const key = Object.keys(QUICK_PRODUCTS).find((k) => text.startsWith(k));
  if (!key) return null;

  const rest = text.slice(key.length).trim();
  if (!rest) return null;

  const parts = rest.split(/\s+/);
  const numbers = parts.filter((p) => /^\d+(\.\d+)?$/.test(p));
  const others = parts.filter((p) => !/^\d+(\.\d+)?$/.test(p));

  let quantity = 1;
  let amount = 0;

  if (numbers.length >= 2) {
    quantity = Number(numbers[0]);
    amount = Number(numbers[1]);
  } else if (numbers.length === 1) {
    amount = Number(numbers[0]);
  } else {
    return null;
  }

  const memo = others.join(" ");

  return {
    customerName: "魚魚",
    productName: QUICK_PRODUCTS[key],
    quantity,
    amount,
    memo,
  };
}

function parseNormalOrder(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 4) return null;

  const [customerName, productName, qtyStr, amountStr, ...rest] = parts;

  if (!/^\d+(\.\d+)?$/.test(qtyStr) || !/^\d+(\.\d+)?$/.test(amountStr)) {
    return null;
  }

  return {
    customerName,
    productName,
    quantity: Number(qtyStr),
    amount: Number(amountStr),
    memo: rest.join(" "),
  };
}

function parseOrder(text) {
  const quick = parseQuickOrder(text);
  if (quick) return quick;
  return parseNormalOrder(text);
}

// 解析更新指令：改 FISH-27 ...
function parseUpdate(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3 || parts[0] !== "改") return null;

  const shortId = parts[1].toUpperCase().trim(); 
  if (!shortId) return null;

  const updates = { shortId };

  for (let i = 2; i < parts.length; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];

    if (part === "付清") {
      updates.status = PAYMENT_STATUS.PAID;
      updates.paidAmount = "FULL"; 
    } else if (part === "已付" && nextPart && /^\d+(\.\d+)?$/.test(nextPart)) {
      updates.paidAmount = Number(nextPart);
      i++;
    } else if (part.startsWith("備註:")) {
      updates.memo = parts.slice(i).join(" ").substring(3).trim();
      break;
    } else if (part.startsWith("狀態:")) {
      const statusText = part.substring(3).trim();
      // 模糊比對狀態
      const statusValue = Object.values(PAYMENT_STATUS).find(v => v.includes(statusText));
      if (statusValue) { updates.status = statusValue; }
    }
  }

  if (Object.keys(updates).length <= 1) return null;
  return updates;
}


// ---------- 2. 寫入 Notion：新增/修改訂單 ----------

async function createOrder(order, originalText) {
  // 這裡不依賴 "更新日期" 欄位，只靠 Notion 系統自動記錄
  const page = await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      [PROPS.title]: {
        title: [{ text: { content: originalText } }],
      },
      [PROPS.customerName]: { rich_text: [{ text: { content: order.customerName } }] },
      [PROPS.productName]: { rich_text: [{ text: { content: order.productName } }] },
      [PROPS.quantity]: { number: order.quantity },
      [PROPS.amount]: { number: order.amount },
      [PROPS.paidAmount]: { number: 0 },
      
      // 嚴格使用 Select
      [PROPS.paymentStatus]: { select: { name: PAYMENT_STATUS.UNPAID } }, 
      
      [PROPS.memo]: { rich_text: order.memo ? [{ text: { content: order.memo } }] : [] },
    },
  });
  return page;
}

async function updateOrder(pageId, updates) {
  const properties = {};

  // 如果有改金額或狀態
  if (updates.paidAmount !== undefined || updates.status) {
    const currentPage = await notion.pages.retrieve({ page_id: pageId });
    const currentAmount = currentPage.properties[PROPS.amount]?.number ?? 0;
    
    // 讀取目前的 Select 狀態
    const currentStatus = currentPage.properties[PROPS.paymentStatus]?.select?.name;
    const currentPaid = currentPage.properties[PROPS.paidAmount]?.number ?? 0;

    let newPaidAmount = currentPaid;
    let newStatus = updates.status || currentStatus;

    if (updates.paidAmount === "FULL") {
      newPaidAmount = currentAmount;
      newStatus = PAYMENT_STATUS.PAID;
    } else if (updates.paidAmount !== undefined) {
      newPaidAmount = updates.paidAmount;
    }
    
    // 自動判斷狀態
    if (!updates.status) {
        if (newPaidAmount >= currentAmount && currentAmount > 0) {
            newStatus = PAYMENT_STATUS.PAID;
        } else if (newPaidAmount > 0) {
            newStatus = PAYMENT_STATUS.PARTIAL;
        } else {
            newStatus = PAYMENT_STATUS.UNPAID; // 如果已付變成 0，改回未付款
        }
    }

    if (newPaidAmount !== undefined) { properties[PROPS.paidAmount] = { number: newPaidAmount }; }
    if (newStatus) { properties[PROPS.paymentStatus] = { select: { name: newStatus } }; }
  }

  if (updates.memo !== undefined) {
    properties[PROPS.memo] = { rich_text: [{ text: { content: updates.memo } }] };
  }

  const page = await notion.pages.update({
    page_id: pageId,
    properties,
  });
  return page;
}

// ---------- 3. 查詢功能 ----------

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

async function queryUnpaid() {
  // 嚴格使用 Select 過濾
  return queryDatabase({
    or: [
      { property: PROPS.paymentStatus, select: { equals: PAYMENT_STATUS.UNPAID } },
      { property: PROPS.paymentStatus, select: { equals: PAYMENT_STATUS.PARTIAL } },
    ]
  });
}

// ---------- 4. LINE 訊息處理 ----------

function buildHelpText() {
  return [
    "📌 訂單格式：",
    "• 客人 商品 數量 金額 [備註]",
    "• 代收 2 150",
    "---",
    "🔍 查詢指令：",
    "• 查 魚魚",
    "• 查商品 相卡",
    "• 未付 / 欠款",
    "---",
    "✍️ 修改指令：",
    "• 改 [流水號] 已付 [金額]",
    "• 改 [流水號] 付清",
    "⚠️ 請使用 Notion 的流水號 (如 27 或 FISH-27)",
  ].join("\n");
}

async function handleTextMessage(event) {
  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  // 1) 幫助
  if (text === "格式" || text === "幫助" || text === "help") {
    return lineClient.replyMessage(replyToken, { type: "text", text: buildHelpText() });
  }

  // 2) 修改訂單
  if (text.startsWith("改 ")) {
    const update = parseUpdate(text);
    if (!update || !update.shortId) {
      return lineClient.replyMessage(replyToken, { type: "text", text: "格式錯誤，範例：改 27 已付 100" });
    }

    try {
      const pageId = await findPageIdByShortId(update.shortId);
      if (!pageId) {
        return lineClient.replyMessage(replyToken, { type: "text", text: `❌ 找不到流水號 ${update.shortId} 的訂單` });
      }

      const updatedPage = await updateOrder(pageId, update);
      const props = updatedPage.properties;
      const c = getRichTextText(props[PROPS.customerName]?.rich_text);
      const prod = getRichTextText(props[PROPS.productName]?.rich_text);
      const amt = props[PROPS.amount]?.number ?? 0;
      const paid = props[PROPS.paidAmount]?.number ?? 0;
      const status = props[PROPS.paymentStatus]?.select?.name || "";
      const finalShortId = getShortIdFromPage(updatedPage);

      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: `✅ 更新成功 (${finalShortId})\n${c}｜${prod}\n金額 $${amt}｜已付 $${paid}｜${status}`
      });
    } catch (err) {
      console.error(err);
      return lineClient.replyMessage(replyToken, { type: "text", text: formatError(err) });
    }
  }

  // 3) 未付
  if (text === "未付" || text === "欠款") {
    try {
      const pages = await queryUnpaid();
      if (pages.length === 0) return lineClient.replyMessage(replyToken, { type: "text", text: "👍 沒有未付款訂單" });

      const lines = pages.slice(0, 10).map((p) => {
        const props = p.properties;
        const c = getRichTextText(props[PROPS.customerName]?.rich_text);
        const prod = getRichTextText(props[PROPS.productName]?.rich_text);
        const amt = props[PROPS.amount]?.number ?? 0;
        const paid = props[PROPS.paidAmount]?.number ?? 0;
        const remain = amt - paid;
        const status = props[PROPS.paymentStatus]?.select?.name || ""; // 讀取 Select
        const sid = getShortIdFromPage(p);
        return `[${sid}] ${c}｜${prod}｜剩$${remain} (${status})`;
      });

      return lineClient.replyMessage(replyToken, { type: "text", text: `未付款清單：\n\n${lines.join("\n")}` });
    } catch (err) {
      console.error(err);
      return lineClient.replyMessage(replyToken, { type: "text", text: formatError(err) });
    }
  }

  // 4) 查客人
  if (text.startsWith("查 ")) {
    const keyword = text.slice(2).trim();
    try {
      const pages = await queryByCustomer(keyword);
      if (pages.length === 0) return lineClient.replyMessage(replyToken, { type: "text", text: `找不到「${keyword}」` });

      const lines = pages.slice(0, 8).map((p) => {
        const props = p.properties;
        const prod = getRichTextText(props[PROPS.productName]?.rich_text);
        const amt = props[PROPS.amount]?.number ?? 0;
        const status = props[PROPS.paymentStatus]?.select?.name || "";
        const sid = getShortIdFromPage(p);
        return `[${sid}] ${prod}｜$${amt}｜${status}`;
      });

      return lineClient.replyMessage(replyToken, { type: "text", text: `🔍 ${keyword} 的訂單：\n\n${lines.join("\n")}` });
    } catch (err) {
      console.error(err);
      return lineClient.replyMessage(replyToken, { type: "text", text: formatError(err) });
    }
  }

  // 5) 查商品
  if (text.startsWith("查商品")) {
    const keyword = text.replace("查商品", "").trim();
    try {
      const pages = await queryByProduct(keyword);
      if (pages.length === 0) return lineClient.replyMessage(replyToken, { type: "text", text: `找不到商品「${keyword}」` });

      const lines = pages.slice(0, 8).map((p) => {
        const props = p.properties;
        const c = getRichTextText(props[PROPS.customerName]?.rich_text);
        const amt = props[PROPS.amount]?.number ?? 0;
        const status = props[PROPS.paymentStatus]?.select?.name || "";
        const sid = getShortIdFromPage(p);
        return `[${sid}] ${c}｜$${amt}｜${status}`;
      });

      return lineClient.replyMessage(replyToken, { type: "text", text: `🔍 商品「${keyword}」：\n\n${lines.join("\n")}` });
    } catch (err) {
      console.error(err);
      return lineClient.replyMessage(replyToken, { type: "text", text: formatError(err) });
    }
  }

  // 6) 新增訂單
  const order = parseOrder(text);
  if (order) {
    try {
      const page = await createOrder(order, text);
      const sid = getShortIdFromPage(page);
      const lines = [
        `✅ 訂單已成立 [${sid}]`,
        `客人：${order.customerName}`,
        `商品：${order.productName} x ${order.quantity}`,
        `金額：$${order.amount}`,
        order.memo ? `備註：${order.memo}` : ""
      ].filter(Boolean);
      
      return lineClient.replyMessage(replyToken, { type: "text", text: lines.join("\n") });
    } catch (err) {
      console.error(err);
      return lineClient.replyMessage(replyToken, { type: "text", text: formatError(err) });
    }
  }

  // 無法識別
  return lineClient.replyMessage(replyToken, { type: "text", text: "聽不懂 QQ，輸入「格式」看教學" });
}

// Webhook
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(async (event) => {
      if (event.type === "message" && event.message.type === "text") {
        await handleTextMessage(event);
      }
    }));
    res.json({ status: "ok" });
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});


