// index.js — 魚魚 version V13（物流=Status、金流=Select，其他完全不動）

import express from "express";
import { Client } from "@notionhq/client";
import line from "@line/bot-sdk";

// -------------------- 基本設定 --------------------
const app = express();
app.use(express.json());

// 📝 Notion 資料庫 ID
const NOTION_DATABASE_ID = "2ad2cb1210c78097b48efff75cf10c00";

// 🔥 Notion Client
const notion = new Client({
  auth: process.env.NOTION_SECRET,
});

// -------------------- LINE 設定 --------------------
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

// -------------------- Notion 欄位對應 --------------------
const PROPS = {
  title: "信箱",
  customerName: "客人名稱",
  productName: "商品名稱",
  quantity: "數量",
  amount: "金額",
  paidAmount: "已付金額",
  paymentStatus: "金流",   // Select
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
  status: "物流",          // Status
};

// -------------------- 常量 --------------------
const PAYMENT_STATUS = {
  UNPAID: "未付款",
  PARTIAL: "部分付款",
  PAID: "已付款",
};

const QUICK_PRODUCTS = {
  "代收": "代收包裹",
  "轉單": "轉單處理",
  "集運": "集運服務費",
  "代匯": "代匯款服務",
};

const SHIPMENT_READY_STATUSES = ["抵台"];

const TARGET_STATUSES = [
  "取消/退款中", "未處理", "已下單", "抵台",
  "已到貨", "處理中", "結單", "已寄出", "已完成"
];

// -------------------- 工具函數 --------------------
function getRich(r) {
  if (!Array.isArray(r) || r.length === 0) return "";
  return r.map(t => t.plain_text || "").join("");
}

const getRichTextText = getRich;

function getNumber(val) {
  return typeof val === "number" ? val : 0;
}

function formatError(err) {
  console.error("❌ Notion API error:", JSON.stringify(err, null, 2));
  return "Notion 錯誤：" + err.message;
}

async function queryDB(filter) {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: filter || undefined,
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  });
  return res.results;
}

function getShortId(page) {
  const f = page.properties[PROPS.shortIdField];
  if (f?.unique_id?.number) {
    const prefix = f.unique_id.prefix || "";
    return prefix + f.unique_id.number;
  }
  return "ID?";
}

async function findPageIdByShortId(shortId) {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      property: PROPS.shortIdField,
      unique_id: { equals: Number(shortId.replace(/[^0-9]/g, "")) },
    },
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  });
  if (res.results.length === 0) return null;
  return res.results[0].id;
}

function getStatus(page) {
  return page.properties[PROPS.status]?.status?.name || "狀態未填";
}

async function unifiedKeywordSearch(keyword) {
  const filter = {
    or: [
      { property: PROPS.customerName, rich_text: { contains: keyword } },
      { property: PROPS.productName, rich_text: { contains: keyword } },
      { property: PROPS.memo, rich_text: { contains: keyword } },
      { property: PROPS.style, rich_text: { contains: keyword } },
    ]
  };
  return queryDB(filter);
}

async function queryByPaymentStatus(statuses) {
  const statusFilters = statuses.map(s => ({
    property: PROPS.paymentStatus,
    select: { equals: s }
  }));
  return queryDB({ or: statusFilters });
}

async function querySpecificStatusSummary() {
  const statusFilters = TARGET_STATUSES.map(s => ({
    property: PROPS.status, status: { equals: s }
  }));

  const pages = await queryDB({ or: statusFilters });
  const statusCounts = {};

  TARGET_STATUSES.forEach(s => statusCounts[s] = 0);

  pages.forEach(p => {
    const status = getStatus(p);
    if (statusCounts.hasOwnProperty(status)) {
      statusCounts[status]++;
    }
  });

  let output = "📊 訂單狀態總覽：\n";
  for (const status of TARGET_STATUSES) {
    if (statusCounts[status] > 0) {
      output += `・ ${status}: ${statusCounts[status]} 筆\n`;
    }
  }
  return output.trim();
}

// -------------------- Cute 卡片 --------------------
function renderCuteCard(page) {
  const id = getShortId(page);
  const c = getRich(page.properties[PROPS.customerName]?.rich_text);
  const prod = getRich(page.properties[PROPS.productName]?.rich_text);
  const amt = getNumber(page.properties[PROPS.amount]?.number);
  const paid = getNumber(page.properties[PROPS.paidAmount]?.number);
  const memo = getRich(page.properties[PROPS.memo]?.rich_text);
  const paymentStatus = page.properties[PROPS.paymentStatus]?.select?.name || "—";
  const orderStatus = page.properties[PROPS.status]?.status?.name || "—";

  const owe = amt - paid;

  return (
`✅ 新增成功！
🍞 ${id}
💛 ${c}

商品：${prod}
金額：${amt}

- 已付：${paid}
- 欠款：${owe}
- 狀態：${paymentStatus}

📦 ${orderStatus}
📋 ${memo || "無備註"}`
  );
}

function renderDetail(page) {
  const id = getShortId(page);
  const g = page.properties;

  const f = (key) => getRich(g[key]?.rich_text);
  const n = (key) => getNumber(g[key]?.number);

  const amt = n(PROPS.amount);
  const paid = n(PROPS.paidAmount);
  const owe = amt - paid;
  const paymentStatus = g[PROPS.paymentStatus]?.select?.name || "—";
  const orderStatus = g[PROPS.status]?.status?.name || "—";

  return (
`📄 訂單詳細｜${id}

💰 交易資訊
客人：${f(PROPS.customerName)}
商品：${f(PROPS.productName)}
款式：${f(PROPS.style) || "未填"}
金額：$${amt}
已付：$${paid}
欠款：$${owe}

💳 金流：**${paymentStatus}**
📦 狀態：**${orderStatus}**
含國際運費：${g[PROPS.intlIncluded]?.checkbox ? "是" : "否"}

💸 成本/運費
成本：${n(PROPS.cost)}
重量：${n(PROPS.weight)}g
預計國際運費：${n(PROPS.intlCost)}

🔗 其他資訊
商品網址：${g[PROPS.url]?.url || "未填"}
出貨日期：${g[PROPS.shipDate]?.date?.start || "未填"}
會員編號：${f(PROPS.memberId) || "未填"}

📋 備註：${f(PROPS.memo) || "無"}`
  );
}

function renderList(pages, title = "查詢結果") {
  let out = `💛 ${title}（${pages.length} 筆）\n\n`;

  pages.forEach(p => {
    const id = getShortId(p);
    const c = getRich(p.properties[PROPS.customerName]?.rich_text);
    const prod = getRich(p.properties[PROPS.productName]?.rich_text);
    const paymentStatus = p.properties[PROPS.paymentStatus]?.select?.name || "—";
    const orderStatus = p.properties[PROPS.status]?.status?.name || "—";

    out += `・ ${id} ${c} - ${prod} (${paymentStatus}/${orderStatus})\n`;
  });

  return out.trim();
}

// -------------------- 新增訂單 --------------------
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

function parseNormalOrder(text) {
  const parts = text.trim().split(/\s+/);

  if (parts.length < 3) return null;

  const customerName = parts[0];
  let quantity = 0;
  let amount = 0;
  let numIndices = [];

  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (/^\d+$/.test(p)) {
      numIndices.push(i);
    }
  }

  if (numIndices.length < 2) return null;

  const qtyIndex = numIndices[0];
  const amtIndex = numIndices[1];

  quantity = Number(parts[qtyIndex]);
  amount = Number(parts[amtIndex]);

  let productName = "";
  let memo = "";

  productName = parts.slice(1, qtyIndex).join(" ");
  memo = parts.slice(amtIndex + 1).join(" ");

  if (!productName || quantity <= 0 || amount <= 0) {
    return null;
  }

  return { customerName, productName, quantity, amount, memo };
}

function parseOrder(text) {
  const normalOrder = parseNormalOrder(text);
  if (normalOrder) return normalOrder;
  return parseQuickOrder(text);
}

async function createOrder(order, originalText, lineName = "") {
  const paidAmount = 0;
  const paymentStatus = PAYMENT_STATUS.UNPAID;
  const initialOrderStatus = "未處理";

  const page = await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      [PROPS.title]: { title: [{ text: { content: originalText } }] },
      [PROPS.customerName]: { rich_text: [{ text: { content: order.customerName } }] },
      [PROPS.productName]: { rich_text: [{ text: { content: order.productName } }] },
      [PROPS.quantity]: { number: order.quantity },
      [PROPS.amount]: { number: order.amount },

      [PROPS.paidAmount]: { number: paidAmount },
      [PROPS.paymentStatus]: { select: { name: paymentStatus } },

      // 💥 物流改成 Status
      [PROPS.status]: { status: { name: initialOrderStatus } },

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

async function handleCreateOrder(event, order) {
  const reply = event.replyToken;
  let profileName = "";
  try {
    const profile = await lineClient.getProfile(event.source.userId);
    profileName = profile.displayName || "";
  } catch {}

  try {
    const page = await createOrder(order, event.message.text, profileName);
    const cuteCard = renderCuteCard(page);
    return lineClient.replyMessage(reply, {
      type: "text",
      text: cuteCard,
    });
  } catch (e) {
    return lineClient.replyMessage(reply, { type: "text", text: formatError(e) });
  }
}

// -------------------- 修改訂單 --------------------
function parseUpdate(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3 || parts[0] !== "改") return null;

  const shortId = parts[1];
  const updates = { shortId };

  for (let i = 2; i < parts.length; i++) {
    const p = parts[i];
    const next = parts[i + 1];

    if (p === "已付" && /^\d+$/.test(next)) {
      updates.paidAmount = Number(next); i++;
    } else if (p === "付清") {
      updates.paidAmount = "FULL";
    } else if (p === "備註" && next) {
      updates.memo = parts.slice(i + 1).join(" ").trim(); break;
    } else if (p === "狀態" && next) {
      updates.status = next; i++;
    } else if (p === "成本" && /^\d+$/.test(next)) {
      updates.cost = Number(next); i++;
    } else if (p === "重量" && /^\d+$/.test(next)) {
      updates.weight = Number(next); i++;
    } else if ((p === "國際運費" || p === "預計國際運費") && /^\d+$/.test(next)) {
      updates.intlCost = Number(next); i++;
    } else if (p === "網址" && next) {
      updates.url = next; i++;
    } else if (p === "款式" && next) {
      updates.style = next; i++;
    } else if ((p === "會員" || p === "會員編號") && next) {
      updates.memberId = next; i++;
    } else if ((p === "出貨" || p === "出貨日期") && next) {
      updates.shipDate = next; i++;
    }
  }

  if (Object.keys(updates).length === 1 && updates.shortId) return null;
  return updates;
}

async function updateOrder(pageId, updates) {
  const page = await notion.pages.retrieve({ page_id: pageId });
  const props = {};
  const amount = page.properties[PROPS.amount]?.number || 0;
  const currentPaid = page.properties[PROPS.paidAmount]?.number || 0;

  let paid = currentPaid;
  if (updates.paidAmount === "FULL") paid = amount;
  else if (typeof updates.paidAmount === "number") paid = updates.paidAmount;

  props[PROPS.paidAmount] = { number: paid };

  let paymentStatus = PAYMENT_STATUS.UNPAID;
  if (paid >= amount) paymentStatus = PAYMENT_STATUS.PAID;
  else if (paid > 0) paymentStatus = PAYMENT_STATUS.PARTIAL;

  props[PROPS.paymentStatus] = { select: { name: paymentStatus } };

  // 💥 物流更新 使用 Status
  if (updates.status !== undefined)
    props[PROPS.status] = { status: { name: updates.status } };

  if (updates.memo !== undefined) props[PROPS.memo] = { rich_text: [{ text: { content: updates.memo } }] };
  if (updates.cost !== undefined) props[PROPS.cost] = { number: updates.cost };
  if (updates.weight !== undefined) props[PROPS.weight] = { number: updates.weight };
  if (updates.intlCost !== undefined) props[PROPS.intlCost] = { number: updates.intlCost };
  if (updates.url !== undefined) props[PROPS.url] = { url: updates.url };
  if (updates.style !== undefined) props[PROPS.style] = { rich_text: [{ text: { content: updates.style } }] };
  if (updates.memberId !== undefined) props[PROPS.memberId] = { rich_text: [{ text: { content: updates.memberId } }] };
  if (updates.shipDate !== undefined) props[PROPS.shipDate] = { date: { start: updates.shipDate } };

  return await notion.pages.update({
    page_id: pageId,
    properties: props,
  });
}

// -------------------- LINE 事件 --------------------
async function handleTextMessage(event) {
  const reply = event.replyToken;
  const text = event.message.text.trim();

  try {

    // 主選單
    if (text === "指令") {
      const commandMenu = [
        "📚 魚魚強化版 Bot 主選單：",
        "請輸入以下關鍵字查看指令清單：",
        "・ 查詢指令",
        "・ 新增指令",
        "・ 修改指令",
        "---",
        "💡 例如：輸入「新增指令」"
      ].join("\n");
      return lineClient.replyMessage(reply, { type: "text", text: commandMenu });
    }

    // 新增指令
    if (text === "新增指令") {
      const createCommandList = [
        "📝 新增訂單：",
        "格式：[客人] [商品] [數量] [金額] [備註]",
        "例：魚魚 外套 2 3000 黑色L",
        "---",
        "📦 快速新增：",
        "例：代收 5000 朋友的包裹"
      ].join("\n");
      return lineClient.replyMessage(reply, { type: "text", text: createCommandList });
    }

    // 修改指令
    if (text === "修改指令") {
      const updateCommandList = [
        "✏️ 修改訂單格式：",
        "改 [流水號] [欄位] [值]",
        "例：改 12345 狀態 抵台 已付 500 備註 急單",
        "---",
        "可修改欄位：",
        "狀態 / 已付 / 備註 / 款式 / 成本 / 重量 / 國際運費 / 網址 / 會員 / 出貨"
      ].join("\n");
      return lineClient.replyMessage(reply, { type: "text", text: updateCommandList });
    }

    // 查詢指令
    if (text === "查詢指令") {
      const queryCommandList = [
        "✨ 查詢：",
        "查 [流水號]",
        "查 [關鍵字]",
        "---",
        "📊 狀態查詢：",
        "輸入任一狀態（已到貨、抵台、處理中...）",
        "可結單 / 狀態總數 / 未付款"
      ].join("\n");
      return lineClient.replyMessage(reply, { type: "text", text: queryCommandList });
    }

    // 修改訂單
    if (text.startsWith("改 ")) {
      const updates = parseUpdate(text);

      if (!updates)
        return lineClient.replyMessage(reply, { type: "text", text: "格式錯誤，請輸入「修改指令」" });

      const pageId = await findPageIdByShortId(updates.shortId);
      if (!pageId)
        return lineClient.replyMessage(reply, { type: "text", text: `找不到流水號 ${updates.shortId}` });

      const updated = await updateOrder(pageId, updates);

      return lineClient.replyMessage(reply, {
        type: "text",
        text: `✨ 已更新訂單：${getShortId(updated)}`
      });
    }

    // 狀態總數
    if (text === "狀態總數") {
      const summary = await querySpecificStatusSummary();
      return lineClient.replyMessage(reply, { type: "text", text: summary });
    }

    // 狀態查詢（物流：Status）
    let statusQueryPages = null;
    let queryTitle = "";

    if (text === "可結單") {
      const filters = SHIPMENT_READY_STATUSES.map(s => ({
        property: PROPS.status, status: { equals: s }
      }));
      statusQueryPages = await queryDB({ or: filters });
      queryTitle = "已抵台（可結單）";
    }

    else if (TARGET_STATUSES.includes(text)) {
      statusQueryPages = await queryDB({ property: PROPS.status, status: { equals: text } });
      queryTitle = `${text} 的訂單`;
    }

    if (statusQueryPages !== null) {
      if (!statusQueryPages.length)
        return lineClient.replyMessage(reply, { type: "text", text: `沒有「${text}」的訂單 ❤️` });

      return lineClient.replyMessage(reply, {
        type: "text",
        text: renderList(statusQueryPages.slice(0, 10), queryTitle)
      });
    }

    // 查詢（查 XX）
    if (text.startsWith("查 ")) {
      const keyword = text.replace("查", "").trim();

      if (!keyword)
        return lineClient.replyMessage(reply, { type: "text", text: "請輸入關鍵字" });

      if (/^\d+$/.test(keyword)) {
        const pageId = await findPageIdByShortId(keyword);
        if (pageId) {
          const p = await notion.pages.retrieve({ page_id: pageId });
          return lineClient.replyMessage(reply, { type: "text", text: renderDetail(p) });
        }
      }

      const pages = await unifiedKeywordSearch(keyword);

      if (!pages.length)
        return lineClient.replyMessage(reply, { type: "text", text: `查不到「${keyword}」` });

      return lineClient.replyMessage(reply, {
        type: "text",
        text: renderList(pages.slice(0, 10), `關鍵字「${keyword}」`)
      });
    }

    // 自然語言（全部抵台 + 未付）
    if (text.includes("抵台") && text.includes("未付")) {
      const filters = SHIPMENT_READY_STATUSES.map(s => ({
        property: PROPS.status, status: { equals: s }
      }));

      const pages = await queryDB({
        and: [
          { or: filters },
          {
            or: [
              { property: PROPS.paymentStatus, select: { equals: PAYMENT_STATUS.UNPAID } },
              { property: PROPS.paymentStatus, select: { equals: PAYMENT_STATUS.PARTIAL } }
            ]
          }
        ]
      });

      if (!pages.length)
        return lineClient.replyMessage(reply, { type: "text", text: "沒有抵台但未付清的訂單" });

      return lineClient.replyMessage(reply, {
        type: "text",
        text: renderList(pages.slice(0, 10), "抵台但未付清")
      });
    }

    // 新增訂單
    const order = parseOrder(text);
    if (order) return handleCreateOrder(event, order);

    // 聽不懂
    return lineClient.replyMessage(reply, {
      type: "text",
      text: "聽不懂喔 💧\n輸入「指令」查看所有功能。"
    });

  } catch (err) {
    return lineClient.replyMessage(reply, {
      type: "text",
      text: formatError(err)
    });
  }
}

// -------------------- LINE Webhook 路由 --------------------
app.post("/webhook", (req, res) => {
  Promise.all(req.body.events.map(event => {
    if (event.type !== "message" || event.message.type !== "text") {
      return Promise.resolve(null);
    }
    return handleTextMessage(event);
  }))
  .then(() => res.json({ success: true }))
  .catch((err) => {
    console.error("LINE Webhook error:", err);
    res.status(500).end();
  });
});

// -------------------- 啟動 --------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`魚魚強化版 Bot 正在 port ${port} 運行 🚀`);
});

