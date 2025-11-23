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
  lineName: "LINE名稱",
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
      [PROPS.title]: { title: [{ text: { content: "" } }] },
      [PROPS.lineName]: { rich_text: [{ text: { content: lineName || "" } }] },
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

      // -------------------- 👤 客人清單聚合渲染工具 (NEW) --------------------
function renderCustomerSummary(pages, title = "客人清單") {
    // 1. 統計每個客人名下的訂單筆數
    const customerCounts = {};
    pages.forEach(p => {
        const customerName = getRich(p.properties[PROPS.customerName]?.rich_text);
        if (customerName) {
            customerCounts[customerName] = (customerCounts[customerName] || 0) + 1;
        }
    });

    // 2. 排序並格式化輸出
    let out = `👤 ${title}（共 ${Object.keys(customerCounts).length} 位客人）\n\n`;
    
    // 根據訂單筆數降序排列
    const sortedCustomers = Object.entries(customerCounts).sort(([, countA], [, countB]) => countB - countA);

    sortedCustomers.forEach(([name, count]) => {
        out += `・ ${name} - (${count} 筆)\n`;
    });

    return out.trim();
}

      // -------------------- 💰 客人級別的金流狀態聚合工具 (NEW) --------------------
function aggregateCustomerPaymentStatus(pages) {
    const customerData = {};

    // 1. 遍歷所有訂單，按客戶分組，並找出該客戶擁有的所有金流狀態
    pages.forEach(p => {
        const customerName = getRich(p.properties[PROPS.customerName]?.rich_text);
        if (!customerName) return;

        const paymentStatus = p.properties[PROPS.paymentStatus]?.select?.name;
        const shortId = getShortId(p);

        if (!customerData[customerName]) {
            customerData[customerName] = {
                counts: 0,
                statuses: new Set(),
                ids: []
            };
        }
        
        customerData[customerName].counts += 1;
        customerData[customerName].statuses.add(paymentStatus);
        customerData[customerName].ids.push(shortId);
    });

    // 2. 根據您的業務邏輯對客戶進行分類
    const finalGroups = {
        paid: [], // 1. 只限全付清
        partial: [], // 2. 只剩部分付款
        unpaid: [] // 3. 只要有未付款 (嚴重欠款)
    };

    for (const [name, data] of Object.entries(customerData)) {
        const hasUnpaid = data.statuses.has(PAYMENT_STATUS.UNPAID); // "未付款"
        const hasPartial = data.statuses.has(PAYMENT_STATUS.PARTIAL); // "部分付款"
        const hasPaid = data.statuses.has(PAYMENT_STATUS.PAID); // "已付款"
        
        // 🚨 客人分類 3 (最高優先級：只要有未付款)
        if (hasUnpaid) {
            finalGroups.unpaid.push({ name, count: data.counts });
        } 
        // 🚨 客人分類 2 (次級優先級：有部分付款，但沒有未付款)
        else if (hasPartial) {
            finalGroups.partial.push({ name, count: data.counts });
        } 
        // 🚨 客人分類 1 (最低優先級：所有都是已付款)
        else if (hasPaid) {
            finalGroups.paid.push({ name, count: data.counts });
        }
        // 注意：理論上不會有其他情況，除非訂單金流狀態為空或非預期值
    }

    return finalGroups;
}

// -------------------- 最終渲染函數 (使用新的聚合結果) --------------------
function renderFinalCustomerSummary(groups, type) {
    let list = [];
    let title = "";
    
    if (type === "all_paid") {
        list = groups.paid;
        title = "✅ 抵台訂單【全付清】客人清單";
    } else if (type === "partial_only") {
        list = groups.partial;
        title = "⚠️ 抵台訂單【只剩部分欠款】客人清單";
    } else if (type === "unpaid_exists") {
        list = groups.unpaid;
        title = "❌ 抵台訂單【有未付款】客人清單";
    }

    if (list.length === 0) {
        return `✅ 查詢成功：目前沒有符合「${title.split('【')[1].replace(/】客人清單/g, '')}」的客人。`;
    }

    let output = `${title}（共 ${list.length} 位客人）\n\n`;
    
    // 根據訂單筆數降序排列
    const sortedList = list.sort((a, b) => b.count - a.count);

    sortedList.forEach(item => {
        output += `・ ${item.name} - (${item.count} 筆抵台訂單)\n`;
    });

    return output.trim();
}

// -------------------- LINE 事件主處理 (V17 修正版：結構整理與功能完整) --------------------
async function handleTextMessage(event) {
    const reply = event.replyToken;
    const text = event.message.text.trim();

    try {
        // ========== 1. 主指令選單 / 幫助文件 ==========
        if (text === "指令") {
            const commandMenu = [
                "📚 魚魚強化版 Bot 主選單：",
                "請輸入以下關鍵字查看指令清單：",
                "・ 查詢指令",
                "・ 新增指令",
                "・ 修改指令",
                "---",
                "💡 例如：輸入「查詢指令」"
            ].join("\n");
            return lineClient.replyMessage(reply, { type: "text", text: commandMenu });
        }
        if (text === "新增指令") {
             const createCommandList = [
                 "📝 新增訂單格式：",
                 "格式：[客人] [商品] [數量] [金額] [備註]",
                 "例：魚魚 外套 2 3000 黑色L",
                 "---",
                 "📦 快速新增格式：",
                 "用於代收、轉單等固定品項。",
                 "例：代收 5000 朋友的包裹"
             ].join("\n");
             return lineClient.replyMessage(reply, { type: "text", text: createCommandList });
        }
        if (text === "修改指令") {
            const updateCommandList = [
                "✏️ 修改訂單格式：",
                "格式：改 [流水號] [欄位] [值]",
                "例：改 12345 狀態 抵台 已付 500 備註 急單",
                "---",
                "可修改欄位（注意格式）：",
                "**狀態** / **已付** (或 **付清**) / **備註** / **款式** / **成本** / **重量** / **國際運費** / **網址** / **會員** / **出貨**"
            ].join("\n");
            return lineClient.replyMessage(reply, { type: "text", text: updateCommandList });
        }
        if (text === "查詢指令") {
             const queryCommandList = [
                "✨ 查詢訂單內容：",
                "・ 查 [流水號]",
                "・ 查 [關鍵字] (查客人/商品/備註)",
                "---",
                "📦 狀態列表查詢 (回傳訂單列表)：",
                "・ 輸入任一**物流狀態** (如：抵台、已下單)",
                "・ **可結單** (廣義，所有已抵台訂單列表)",
                "・ **未付款** / **已付款** / **部分付款** (查金流狀態)",
                "・ **查抵台未付訂單** (找出抵台且有欠款的訂單列表)",
                "---",
                "📊 客人清單聚合 (回傳客人筆數清單)：",
                "・ **狀態總數** (所有訂單狀態總覽)",
                "・ **抵台全付清** (所有抵台訂單皆已付清的客人)",
                "・ **抵台部分未付** (有部分欠款，但無完全未付款訂單的客人)",
                "・ **抵台未付** (有完全未付款訂單的客人)",
            ].join("\n");
            return lineClient.replyMessage(reply, { type: "text", text: queryCommandList });
        }

        // ========== 2. 修改訂單 (改) ==========
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

        // ========== 3. 狀態數量總覽 ==========
        if (text === "狀態總數") {
            const summary = await querySpecificStatusSummary();
            return lineClient.replyMessage(reply, { type: "text", text: summary });
        }
        
        // ========== 4. 單一狀態查詢：金流 (Select) 與 物流 (Status) (已修復功能) ==========
        let statusQueryPages = null;
        let queryTitle = "";

        // 🎯 金流查詢 (Select)
        if (text === "未付款") {
            statusQueryPages = await queryByPaymentStatus([PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PARTIAL]);
            queryTitle = "未完全付清的訂單";
        } else if (text === "部分付款") {
            statusQueryPages = await queryByPaymentStatus([PAYMENT_STATUS.PARTIAL]);
            queryTitle = "部分付款的訂單";
        } else if (text === "已付款" || text === "付清") {
            statusQueryPages = await queryByPaymentStatus([PAYMENT_STATUS.PAID]);
            queryTitle = "已付款 (付清) 的訂單";
        }
        
        // 🎯 物流廣義查詢 (可結單)
        else if (text === "可結單") {
            const filters = SHIPMENT_READY_STATUSES.map(s => ({
                property: PROPS.status, status: { equals: s }
            }));
            statusQueryPages = await queryDB({ or: filters });
            queryTitle = "已抵台（可結單）的訂單";
        }
        
        // 🎯 物流單一狀態查詢
        else if (TARGET_STATUSES.includes(text)) {
            statusQueryPages = await queryDB({ property: PROPS.status, status: { equals: text } });
            queryTitle = `${text} 的訂單`;
        }

        if (statusQueryPages !== null) {
            if (!statusQueryPages.length)
                return lineClient.replyMessage(reply, { type: "text", text: `目前沒有符合「${queryTitle.replace(/的訂單|/g, '')}」的項目 ❤️` });

            // 回傳單一狀態的訂單詳細列表
            const replyText = renderList(statusQueryPages.slice(0, 10), queryTitle);

            return lineClient.replyMessage(reply, { type: "text", text: replyText });
        }
        
        // ========== 5. 客人級別金流聚合查詢 (NEW) ==========
        const isAggregateQuery = text === "抵台全付清" || text === "抵台部分未付" || text === "抵台未付";
        
        if (isAggregateQuery) {
            const filters = SHIPMENT_READY_STATUSES.map(s => ({
                property: PROPS.status, status: { equals: s }
            }));
            const allShipmentReadyPages = await queryDB({ or: filters });
            
            if (!allShipmentReadyPages.length) {
                return lineClient.replyMessage(reply, { type: "text", text: "目前沒有任何已抵台的訂單。" });
            }

            const groups = aggregateCustomerPaymentStatus(allShipmentReadyPages);
            let replyText = "";

            if (text === "抵台全付清") {
                replyText = renderFinalCustomerSummary(groups, "all_paid");
            } else if (text === "抵台部分未付") {
                replyText = renderFinalCustomerSummary(groups, "partial_only");
            } else if (text === "抵台未付") {
                replyText = renderFinalCustomerSummary(groups, "unpaid_exists");
            }
            
            return lineClient.replyMessage(reply, { type: "text", text: replyText });
        }


        // ========== 6. 精確組合查詢：查抵台未付訂單 (回傳訂單列表) ==========
        if (text === "查抵台未付訂單") {
            const filters = SHIPMENT_READY_STATUSES.map(s => ({
                property: PROPS.status, status: { equals: s } // 物流 Status
            }));
            const paymentFilters = {
                or: [ 
                    { property: PROPS.paymentStatus, select: { equals: PAYMENT_STATUS.UNPAID } },
                    { property: PROPS.paymentStatus, select: { equals: PAYMENT_STATUS.PARTIAL } }
                ]
            };
            const pages = await queryDB({
                and: [ { or: filters }, paymentFilters ]
            });

            if (!pages.length)
                return lineClient.replyMessage(reply, { type: "text", text: "目前沒有「抵台但未付清」的訂單 👍" });

            return lineClient.replyMessage(reply, {
                type: "text",
                text: renderList(pages.slice(0, 10), "抵台但未付清的訂單列表")
            });
        }


        // ========== 7. 統一查詢指令 (查) (維持原本的 查 [流水號/關鍵字] 邏輯) ==========
        if (text.startsWith("查 ")) {
             const keyword = text.replace("查", "").trim();
             // ... (此處保留原本的查流水號和關鍵字查詢邏輯) ...
             if (!keyword)
                return lineClient.replyMessage(reply, { type: "text", text: "請在「查」後面提供關鍵字 🔎" });

            const isShortId = /^\d+$/.test(keyword);
            if (isShortId) {
                const pageId = await findPageIdByShortId(keyword);
                if (pageId) {
                    const p = await notion.pages.retrieve({ page_id: pageId });
                    return lineClient.replyMessage(reply, { type: "text", text: renderDetail(p) });
                }
            }

            const pages = await unifiedKeywordSearch(keyword);
            if (!pages.length)
                return lineClient.replyMessage(reply, { type: "text", text: `查不到與「${keyword}」相關的訂單` });

            return lineClient.replyMessage(reply, {
                type: "text",
                text: renderList(pages.slice(0, 10), `關鍵字「${keyword}」的查詢結果`)
            });
        }


        // ========== 8. 新增訂單 ==========
        const order = parseOrder(text);
        if (order) return handleCreateOrder(event, order);

        // ========== 9. 聽不懂 (Fallback) ==========
        return lineClient.replyMessage(reply, {
            type: "text",
            text: "聽不懂喔 💧\n請輸入「指令」查看所有可用功能。"
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





