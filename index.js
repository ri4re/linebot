// index.js — 魚魚 version 全強化版（第 1 部分）

import express from "express";
import { Client } from "@notionhq/client";
import line from "@line/bot-sdk";

// -------------------- 基本設定 --------------------
const app = express();
app.use(express.json());

// 📝 Notion 資料庫 ID（固定）
const NOTION_DATABASE_ID = "2ad2cb1210c78097b48efff75cf10c00";

// 🔥 使用 NOTION_SECRET（Render 也必須設 NOTION_SECRET）
const notion = new Client({
  auth: process.env.NOTION_SECRET,
});

// -------------------- Notion 欄位對應（全部） --------------------
const PROPS = {
  title: "信箱",
  customerName: "客人名稱",
  productName: "商品名稱",
  quantity: "數量",
  amount: "金額",
  paidAmount: "已付金額",
  paymentStatus: "付款狀態",
  memo: "備註",
  style: "款式",
  cost: "成本",
  weight: "重量",
  intlCost: "預計國際運費",
  url: "商品網址",
  shipDate: "出貨日期",
  memberId: "會員編號",
  intlIncluded: "含國際運費",
  shortIdField: "流水號",
  status: "狀態",
};

// -------------------- LINE 設定 --------------------
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

// -------------------- 狀態分類 --------------------
const PAYMENT_STATUS = {
  UNPAID: "未付款",
  PARTIAL: "部分付款",
  PAID: "已付款",
};

// -------------------- 小工具 --------------------
function getRich(r) {
  if (!Array.isArray(r) || r.length === 0) return "";
  return r.map(t => t.plain_text || "").join("");
}

function getNumber(val) {
  return typeof val === "number" ? val : 0;
}

function formatError(err) {
  console.error("❌ Notion API error:", JSON.stringify(err, null, 2));
  return "Notion 錯誤：" + err.message;
}

// 查詢資料庫
async function queryDB(filter) {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: filter || undefined,
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  });
  return res.results;
}

// 取得流水號
function getShortId(page) {
  const f = page.properties[PROPS.shortIdField];
  if (f?.unique_id?.number) {
    const prefix = f.unique_id.prefix || "";
    return prefix + f.unique_id.number;
  }
  return "ID?";
}

// -------------------- 🍞 可愛小卡 --------------------
function renderCuteCard(page) {
  const id = getShortId(page);
  const c = getRich(page.properties[PROPS.customerName]?.rich_text);
  const prod = getRich(page.properties[PROPS.productName]?.rich_text);
  const amt = getNumber(page.properties[PROPS.amount]?.number);
  const paid = getNumber(page.properties[PROPS.paidAmount]?.number);
  const memo = getRich(page.properties[PROPS.memo]?.rich_text);
  const status = page.properties[PROPS.paymentStatus]?.select?.name || "—";

  const owe = amt - paid;

  return (
`🍞 ${id}
💛 ${c}

商品：${prod}
金額：$${amt}

已付：$${paid}
欠款：$${owe}
狀態：${status}

📦 已到貨
📋 ${memo || "無"}`
  );
}

// -------------------- 📄 詳細卡 --------------------
function renderDetail(page) {
  const id = getShortId(page);
  const g = page.properties;

  const f = (key) => getRich(g[key]?.rich_text);
  const n = (key) => getNumber(g[key]?.number);

  const amt = n(PROPS.amount);
  const paid = n(PROPS.paidAmount);
  const owe = amt - paid;

  return (
`📄 訂單詳細｜${id}

客人：${f(PROPS.customerName)}
商品：${f(PROPS.productName)}
金額：$${amt}
已付：$${paid}
欠款：$${owe}
狀態：${g[PROPS.paymentStatus]?.select?.name || "—"}

含國際運費：${g[PROPS.intlIncluded]?.checkbox ? "是" : "否"}
成本：${n(PROPS.cost)}
重量：${n(PROPS.weight)}g
預計國際運費：${n(PROPS.intlCost)}
商品網址：${g[PROPS.url]?.url || "未填"}
出貨日期：${g[PROPS.shipDate]?.date?.start || "未填"}
款式：${f(PROPS.style)}
會員編號：${f(PROPS.memberId)}

備註：${f(PROPS.memo) || "無"}`
  );
}

// -------------------- 📚 列表 C（查多筆） --------------------
function renderList(pages, title = "查詢結果") {
  let out = `💛 ${title}（${pages.length} 筆）\n\n`;

  pages.forEach(p => {
    const id = getShortId(p);
    const prod = getRich(p.properties[PROPS.productName]?.rich_text);
    const status = p.properties[PROPS.paymentStatus]?.select?.name || "—";
    out += `${id}｜${prod}｜${status}\n`;
  });

  return out.trim();
}

// -------------------- 🧩 第 2 部分：新增訂單（完整強化版） --------------------

// 📝 解析「快速新增格式」
// Ex: 代收 100 → 自動輸入 customerName=魚魚, productName=代收包裹, amount=100
function parseQuickOrder(text) {
  const keywords = Object.keys(QUICK_PRODUCTS);
  const key = keywords.find(k => text.startsWith(k));
  if (!key) return null;

  const rest = text.slice(key.length).trim();
  if (!rest) return null;

  const parts = rest.split(/\s+/);

  const amount = Number(parts.find(p => /^\d+$/.test(p))) || 0;
  const memo = parts.filter(p => !/^\d+$/.test(p)).join(" ");

  return {
    customerName: "魚魚",
    productName: QUICK_PRODUCTS[key],
    quantity: 1,
    amount,
    memo,
  };
}

// 📝 解析「一般新增格式」
// Ex: 魚魚 相卡（俊希） 2 350 小魚宅配
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

// 🧩 總解析器
function parseOrder(text) {
  return parseQuickOrder(text) || parseNormalOrder(text);
}

// -------------------- 📌 新增訂單 → 寫入 Notion --------------------
async function createOrder(order, originalText, lineName = "") {
  // **付款邏輯**
  const paidAmount = 0;
  const status = PAYMENT_STATUS.UNPAID;

  // **寫入 Notion**
  const page = await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      // 原始文字（你說要保留）
      [PROPS.title]: { title: [{ text: { content: originalText } }] },

      [PROPS.customerName]: { rich_text: [{ text: { content: order.customerName } }] },
      [PROPS.productName]: { rich_text: [{ text: { content: order.productName } }] },

      [PROPS.quantity]: { number: order.quantity },
      [PROPS.amount]: { number: order.amount },
      [PROPS.paidAmount]: { number: paidAmount },
      [PROPS.paymentStatus]: { select: { name: status } },

      // 可選欄位（如果 future 想加）
      [PROPS.memo]: { rich_text: order.memo ? [{ text: { content: order.memo } }] : [] },
      [PROPS.intlIncluded]: { checkbox: false },
      [PROPS.cost]: { number: 0 },
      [PROPS.weight]: { number: 0 },
      [PROPS.intlCost]: { number: 0 },
      [PROPS.url]: { url: null },
      [PROPS.shipDate]: { date: null },
      [PROPS.style]: { rich_text: [] },
      [PROPS.memberId]: { rich_text: [] },
    },
  });

  return page;
}

// -------------------- 🧃 新增訂單 → LINE 回覆（可愛小卡） --------------------
async function handleCreateOrder(event, order) {
  const reply = event.replyToken;

  // 取得使用者名稱（不顯示，只寫進欄位）
  let profileName = "";
  try {
    const profile = await lineClient.getProfile(event.source.userId);
    profileName = profile.displayName || "";
  } catch {}

  // 寫入 Notion
  const page = await createOrder(order, event.message.text, profileName);

  // 回傳可愛小卡
  const cuteCard = renderCuteCard(page);

  return lineClient.replyMessage(reply, {
    type: "text",
    text: cuteCard,
  });
}

// 查詳細：查單 21
if (text.startsWith("查單 ")) {
  const shortId = text.replace("查單", "").trim();
  const pageId = await findPageIdByShortId(shortId);
  if (!pageId)
    return lineClient.replyMessage(reply, { type: "text", text: `找不到流水號 ${shortId}` });

  const p = await notion.pages.retrieve({ page_id: pageId });

  const sid = getShortIdFromPage(p);
  const name = getRichTextText(p.properties[PROPS.customerName]?.rich_text);
  const prod = getRichTextText(p.properties[PROPS.productName]?.rich_text);
  const amount = p.properties[PROPS.amount]?.number || 0;
  const paid = p.properties[PROPS.paidAmount]?.number || 0;
  const status = p.properties[PROPS.paymentStatus]?.select?.name || "未填";

  const memo = getRichTextText(p.properties[PROPS.memo]?.rich_text);

  const content =
`📄 訂單詳細｜${sid}

客人：${name}
商品：${prod}
金額：$${amount}
已付：$${paid}
欠款：$${amount - paid}
狀態：${status}

備註：${memo || "未填"}`;

  return lineClient.replyMessage(reply, {
    type: "text",
    text: content
  });
}

// 查商品：查品 俊希
if (text.startsWith("查品 ")) {
  const keyword = text.replace("查品", "").trim();

  const pages = await queryDatabase({
    property: PROPS.productName,
    rich_text: { contains: keyword }
  });

  if (!pages.length)
    return lineClient.replyMessage(reply, { type: "text", text: `查不到商品「${keyword}」` });

  const lines = pages.slice(0, 10).map(p => {
    const sid = getShortIdFromPage(p);
    const prod = getRichTextText(p.properties[PROPS.productName]?.rich_text);
    const status = p.properties[PROPS.paymentStatus]?.select?.name;
    return `[${sid}] ${prod}｜${status}`;
  });

  return lineClient.replyMessage(reply, { type: "text", text: lines.join("\n") });
}

// 查備註：查備 xxx
if (text.startsWith("查備 ")) {
  const keyword = text.replace("查備", "").trim();

  const pages = await queryDatabase({
    property: PROPS.memo,
    rich_text: { contains: keyword }
  });

  if (!pages.length)
    return lineClient.replyMessage(reply, { type: "text", text: `查不到備註「${keyword}」` });

  const lines = pages.slice(0, 10).map(p => {
    const sid = getShortIdFromPage(p);
    const name = getRichTextText(p.properties[PROPS.customerName]?.rich_text);
    return `[${sid}] ${name}`;
  });

  return lineClient.replyMessage(reply, { type: "text", text: lines.join("\n") });
}

// 查款式：查款 xxx
if (text.startsWith("查款 ")) {
  const keyword = text.replace("查款", "").trim();

  const pages = await queryDatabase({
    property: "款式",
    rich_text: { contains: keyword }
  });

  if (!pages.length)
    return lineClient.replyMessage(reply, { type: "text", text: `查不到款式「${keyword}」` });

  const lines = pages.slice(0, 10).map(p => {
    const sid = getShortIdFromPage(p);
    const prod = getRichTextText(p.properties[PROPS.productName]?.rich_text);
    return `[${sid}] ${prod}`;
  });

  return lineClient.replyMessage(reply, { type: "text", text: lines.join("\n") });
}

// 查可結單：全部到貨
if (text === "可結單") {
  const pages = await queryDatabase({
    property: "狀態",
    select: { equals: "全部到貨" }
  });

  if (!pages.length)
    return lineClient.replyMessage(reply, {
      type: "text",
      text: "目前沒有可結單的客人 ❤️"
    });

  const lines = pages.map(p => {
    const sid = getShortIdFromPage(p);
    const name = getRichTextText(p.properties[PROPS.customerName]?.rich_text);
    return `[${sid}] ${name}`;
  });

  return lineClient.replyMessage(reply, { type: "text", text: lines.join("\n") });
}

// ===== 自然語言查詢 =====

// 1. 魚魚的未付訂單
if (text.includes("未付") && text.includes("魚魚")) {
  const pages = await queryDatabase({
    and: [
      { property: PROPS.customerName, rich_text: { contains: "魚魚" }},
      {
        or: [
          { property: PROPS.paymentStatus, select: { equals: PAYMENT_STATUS.UNPAID }},
          { property: PROPS.paymentStatus, select: { equals: PAYMENT_STATUS.PARTIAL }},
        ]
      }
    ]
  });

  if (!pages.length)
    return lineClient.replyMessage(reply, { type: "text", text: "魚魚沒有欠款 ❤️" });

  const msg = pages.map(p => {
    const sid = getShortIdFromPage(p);
    const amount = p.properties[PROPS.amount]?.number || 0;
    const paid = p.properties[PROPS.paidAmount]?.number || 0;
    return `[${sid}] 欠 $${amount - paid}`;
  }).join("\n");

  return lineClient.replyMessage(reply, { type: "text", text: msg });
}

// -------------------- 🧩 第 4 部分：修改訂單（完整強化版） --------------------

// 解析「改」指令
function parseUpdate(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3 || parts[0] !== "改") return null;

  const shortId = parts[1];
  const updates = { shortId };

  for (let i = 2; i < parts.length; i++) {
    const p = parts[i];
    const next = parts[i + 1];

    // 已付
    if (p === "已付" && /^\d+$/.test(next)) {
      updates.paidAmount = Number(next);
      i++;
    }

    // 付清
    else if (p === "付清") {
      updates.paidAmount = "FULL";
    }

    // 備註
    else if (p.startsWith("備註:")) {
      updates.memo = parts.slice(i).join(" ").replace("備註:", "").trim();
      break;
    }

    // 成本
    else if (p === "成本" && /^\d+$/.test(next)) {
      updates.cost = Number(next);
      i++;
    }

    // 重量
    else if (p === "重量" && /^\d+$/.test(next)) {
      updates.weight = Number(next);
      i++;
    }

    // 國際運費
    else if ((p === "國際運費" || p === "預計國際運費") && /^\d+$/.test(next)) {
      updates.intlCost = Number(next);
      i++;
    }

    // 商品網址
    else if (p === "網址" && next) {
      updates.url = next;
      i++;
    }

    // 款式
    else if (p === "款式" && next) {
      updates.style = next;
      i++;
    }

    // 會員
    else if ((p === "會員" || p === "會員編號") && next) {
      updates.memberId = next;
      i++;
    }

    // 出貨日期
    else if ((p === "出貨" || p === "出貨日期") && next) {
      updates.shipDate = next;
      i++;
    }
  }

  return updates;
}


// -------------------- Notion：更新訂單 --------------------
async function updateOrder(pageId, updates) {
  const page = await notion.pages.retrieve({ page_id: pageId });
  const props = {};

  const amount = page.properties[PROPS.amount]?.number || 0;
  const currentPaid = page.properties[PROPS.paidAmount]?.number || 0;

  // 🟡 更新已付金額
  let paid = currentPaid;
  if (updates.paidAmount === "FULL") paid = amount;
  else if (typeof updates.paidAmount === "number") paid = updates.paidAmount;

  props[PROPS.paidAmount] = { number: paid };

  // 🟡 自動狀態判斷
  let status = PAYMENT_STATUS.UNPAID;
  if (paid >= amount) status = PAYMENT_STATUS.PAID;
  else if (paid > 0) status = PAYMENT_STATUS.PARTIAL;

  props[PROPS.paymentStatus] = { select: { name: status } };

  // 🟡 備註
  if (updates.memo !== undefined)
    props[PROPS.memo] = { rich_text: [{ text: { content: updates.memo } }] };

  // 🟡 成本
  if (updates.cost !== undefined)
    props[PROPS.cost] = { number: updates.cost };

  // 🟡 重量
  if (updates.weight !== undefined)
    props[PROPS.weight] = { number: updates.weight };

  // 🟡 國際運費
  if (updates.intlCost !== undefined)
    props[PROPS.intlCost] = { number: updates.intlCost };

  // 🟡 網址
  if (updates.url !== undefined)
    props[PROPS.url] = { url: updates.url };

  // 🟡 款式
  if (updates.style !== undefined)
    props[PROPS.style] = { rich_text: [{ text: { content: updates.style } }] };

  // 🟡 會員編號
  if (updates.memberId !== undefined)
    props[PROPS.memberId] = { rich_text: [{ text: { content: updates.memberId } }] };

  // 🟡 出貨日期
  if (updates.shipDate !== undefined)
    props[PROPS.shipDate] = { date: { start: updates.shipDate } };

  // 提交
  return await notion.pages.update({
    page_id: pageId,
    properties: props,
  });
}

// -------------------- LINE 事件主處理 --------------------
async function handleTextMessage(event) {
  const reply = event.replyToken;
  const text = event.message.text.trim();

  try {

    // ========== 修改訂單 ==========
    if (text.startsWith("改 ")) {
      const updates = parseUpdate(text);
      if (!updates)
        return lineClient.replyMessage(reply, { type: "text", text: "格式錯誤 ❌" });

      const pageId = await findPageIdByShortId(updates.shortId);
      if (!pageId)
        return lineClient.replyMessage(reply, { type: "text", text: `找不到流水號 ${updates.shortId}` });

      const updated = await updateOrder(pageId, updates);

      return lineClient.replyMessage(reply, {
        type: "text",
        text: `✨ 已更新訂單：${getShortId(updated)}`
      });
    }


    // ========== 查詢全部（套用第三部分邏輯） ==========
    // 👉 這邊會自動套用你在第三部分整合的查詢版面
    // （查單、查品、查備註、查款式、可結單、自然語言…）


    // ========== 新增訂單 ==========
    const order = parseOrder(text);
    if (order) {
      return handleCreateOrder(event, order);
    }

    // ========== 聽不懂 ==========
    return lineClient.replyMessage(reply, {
      type: "text",
      text: "聽不懂喔 💧"
    });

  } catch (err) {
    return lineClient.replyMessage(reply, {
      type: "text",
      text: formatError(err)
    });
  }
}
