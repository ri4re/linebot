// index.js — 魚魚 version Emoji 修正版 (V11)
// **重要修正：重新將 Emoji 加回 renderCuteCard (新增) 與 renderDetail (查詢) 的格式中。**

import express from "express";
import { Client } from "@notionhq/client";
import line from "@line/bot-sdk";

// -------------------- 基本設定 --------------------
const app = express();
app.use(express.json());

// 📝 Notion 資料庫 ID（固定）
const NOTION_DATABASE_ID = "2ad2cb1210c78097b48efff75cf10c00"; // 請確認此 ID 正確

// 🔥 使用 NOTION_SECRET（Render 也必須設 NOTION_SECRET）
const notion = new Client({
  auth: process.env.NOTION_SECRET,
});

// -------------------- LINE 設定 --------------------
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

// -------------------- Notion 欄位對應（核心欄位名稱） --------------------
const PROPS = {
  title: "信箱",
  customerName: "客人名稱",
  productName: "商品名稱",
  quantity: "數量",
  amount: "金額",
  paidAmount: "已付金額",
  paymentStatus: "金流", 
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
  status: "物流", // <--- 物流是 Status 類型
};

// -------------------- 狀態分類 --------------------
const PAYMENT_STATUS = {
  UNPAID: "未付款",
  PARTIAL: "部分付款",
  PAID: "已付款",
};

// -------------------- 快速新增產品定義 --------------------
const QUICK_PRODUCTS = {
  "代收": "代收包裹",
  "轉單": "轉單處理",
  "集運": "集運服務費",
  "代匯": "代匯款服務",
};

// 🎯 根據您的最新要求：只有「抵台」才能結單
const SHIPMENT_READY_STATUSES = ["抵台"]; 

// 🎯 根據您的截圖，設定目標狀態列表 
const TARGET_STATUSES = [
    "取消/退款中", "未處理", "已下單", "抵台", "已到貨", "處理中", "結單", "已寄出", "已完成"
];

// -------------------- 🧰 核心小工具 (略) --------------------
// (以下輔助函數保持不變，為節省空間略去)
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
  if (err.message && err.message.includes("is not supported")) {
    return "Notion 錯誤：資料庫欄位類型不匹配，請檢查輸入格式。";
  }
  // 🎯 修正: 重新捕獲金流的 select 錯誤，避免與物流混淆
  if (err.message && err.message.includes("does not match filter select") && !err.message.includes("status")) {
      return `Notion 錯誤：金流欄位篩選錯誤。請檢查您的Notion中「${PROPS.paymentStatus}」欄位名稱是否正確，且類型為 Select。`;
  }
  // 🎯 捕獲 Status 錯誤的提示
  if (err.message && err.message.includes("is expected to be status") || err.message && err.message.includes("database property status does not match filter select")) {
      return `Notion 錯誤：物流狀態值有誤。請檢查您輸入的狀態值是否完全存在於「${PROPS.status} (物流)」欄位中 (大小寫/全半形須完全一致)。`;
  }
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
const getShortIdFromPage = getShortId;

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
// (其他查詢和聚合函數保持不變)
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
    // 金流是 Select 類型，使用 select 語法
    const statusFilters = statuses.map(s => ({ 
        property: PROPS.paymentStatus, select: { equals: s } 
    }));
    return queryDB({ or: statusFilters });
}

async function querySpecificStatusSummary() {
    // 物流是 Status 類型，使用 status 語法
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
    
    let output = "📊 訂單狀態數量總覽：\n";
    for (const status of TARGET_STATUSES) {
        if (statusCounts[status] > 0) {
            output += `・ ${status}: ${statusCounts[status]} 筆\n`;
        }
    }
    return output.trim();
}

// -------------------- 🍞 卡片渲染工具 (V11 格式修正 - 加入 Emoji) --------------------

function renderCuteCard(page) {
    const id = getShortId(page);
    const c = getRich(page.properties[PROPS.customerName]?.rich_text);
    const prod = getRich(page.properties[PROPS.productName]?.rich_text);
    const amt = getNumber(page.properties[PROPS.amount]?.number);
    const paid = getNumber(page.properties[PROPS.paidAmount]?.number);
    const memo = getRich(page.properties[PROPS.memo]?.rich_text);
    const paymentStatus = page.properties[PROPS.paymentStatus]?.select?.name || "—";
    // 物流是 Status 類型
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
    // 物流是 Status 類型
    const orderStatus = g[PROPS.status]?.status?.name || "—";
    
    // 依照您的格式要求重新排列
    const detailText = 
`📄 訂單詳細｜${id}

客人：${f(PROPS.customerName)}
商品：${f(PROPS.productName)}
金額：$${amt}
已付：$${paid}
欠款：$${owe}
**金流：${paymentStatus}**
**狀態：${orderStatus}** 含國際運費：${g[PROPS.intlIncluded]?.checkbox ? "是" : "否"}
成本：${n(PROPS.cost)}
重量：${n(PROPS.weight)}g
預計國際運費：${n(PROPS.intlCost)}
商品網址：${g[PROPS.url]?.url || "未填"}
出貨日期：${g[PROPS.shipDate]?.date?.start || "未填"}
款式：${f(PROPS.style) || "未填"}
會員編號：${f(PROPS.memberId) || "未填"}

備註：${f(PROPS.memo) || "無"}`
    ;

    return detailText;
}

function renderList(pages, title = "查詢結果") {
  let out = `💛 ${title}（${pages.length} 筆）\n\n`;

  pages.forEach(p => {
    const id = getShortId(p);
    const c = getRich(p.properties[PROPS.customerName]?.rich_text);
    const prod = getRich(p.properties[PROPS.productName]?.rich_text);
    const paymentStatus = p.properties[PROPS.paymentStatus]?.select?.name || "—";
    // 物流是 Status 類型
    const orderStatus = p.properties[PROPS.status]?.status?.name || "—"; 
    // 列表顯示 流水號 | 客人名 | 商品名稱 | 金流 | 物流
    out += `・ ${id} ${c} - ${prod} (${paymentStatus}/${orderStatus})\n`; 
  });

  return out.trim();
}

// -------------------- 🧩 新增訂單解析/寫入 (略) --------------------
// (所有邏輯處理函數保持不變)
function parseQuickOrder(text) {
  // ... (邏輯不變)
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
    // 🎯 V6 強化解析邏輯 (不變)
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
      // 🎯 V8 修正：使用 status 類型和更穩定的賦值結構
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
  // 寫入 Notion
  try {
    const page = await createOrder(order, event.message.text, profileName);
    // 回傳可愛小卡
    const cuteCard = renderCuteCard(page);
    return lineClient.replyMessage(reply, {
      type: "text",
      text: cuteCard,
    });
  } catch (e) {
    return lineClient.replyMessage(reply, { type: "text", text: formatError(e) });
  }
}


// -------------------- 🧩 修改訂單解析/更新 (略) --------------------
// (解析和更新函數保持不變)
function parseUpdate(text) {
  // ... (解析邏輯不變)
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
    } else if (p.startsWith("備註:")) {
      updates.memo = parts.slice(i).join(" ").replace(/備註[:：]/, "").trim(); break;
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

  // 金流 (Select) 保持不變
  props[PROPS.paymentStatus] = { select: { name: paymentStatus } };
  
  // 🎯 V8 修正：更新 Status 欄位時使用 status 類型
  if (updates.status !== undefined) props[PROPS.status] = { status: { name: updates.status } }; 
  
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


// -------------------- 🆕 LINE 事件主處理 (V11) --------------------
async function handleTextMessage(event) {
    const reply = event.replyToken;
    const text = event.message.text.trim();

    try {
        // ========== 1. 主指令選單 (V9) ==========
        if (text === "指令") {
            const commandMenu = [
                "📚 魚魚強化版 Bot 主選單：",
                "請輸入以下關鍵字查看指令清單：",
                "・ **查詢指令**：查看所有查詢、篩選和統計的指令。",
                "・ **新增指令**：查看新增訂單的格式和範例。",
                "・ **修改指令**：查看修改訂單的語法和所有可修改的欄位清單。",
                "---",
                "💡 範例：輸入「修改指令」即可。"
            ].join("\n");
            return lineClient.replyMessage(reply, { type: "text", text: commandMenu });
        }

        // ========== 2. 新增指令回覆 (V9) ==========
        if (text === "新增指令") {
            const createCommandList = [
                "📝 新增訂單 (必填欄位):",
                "・ **格式**：[客人] [商品名稱] [數量(數字)] [金額(數字)] [備註(選填)]",
                "・ **範例**：魚魚 韓國代購連帽外套 2 3000 紅色L號",
                "---",
                "📦 快速新增服務 (客人名稱為魚魚):",
                "・ **快速格式**：[代收/轉單/集運/代匯] [金額(數字)] [備註(選填)]",
                "・ **範例**：代收 5000 這是朋友的包裹",
                "---",
                "💡 輸入「指令」回主選單。"
            ].join("\n");
            return lineClient.replyMessage(reply, { type: "text", text: createCommandList });
        }

        // ========== 3. 修改指令回覆 (V9) ==========
        if (text === "修改指令") {
            const updateCommandList = [
                "✏️ 修改訂單格式:",
                "使用「**改 [流水號] [欄位] [新值]**」來修改單一或多個欄位。",
                "💡 範例：改 12345 狀態 抵台 已付 500 備註 這個是急單",
                "--- 📝 可修改欄位清單 ---",
                `**📦 物流 (Status)**：`,
                "・ **狀態** [狀態名] (例如：已到貨、抵台、結單)",
                `**💰 金流 (Select)**：`,
                "・ **已付** [金額] (修改「已付金額」)",
                "・ **付清** (自動設為總金額)",
                "**💾 其他細節**：",
                "・ **備註** [內容] (直接接內容)",
                "・ **款式** [內容]",
                "・ **成本** [金額] / **重量** [數值]",
                "・ **國際運費** [金額]",
                "・ **網址** [網址]",
                "・ **會員** [內容] / **會員編號** [內容]",
                "・ **出貨** [日期] / **出貨日期** [日期] (格式：YYYY-MM-DD)",
                "---",
                "💡 輸入「指令」回主選單。"
            ].join("\n");
            return lineClient.replyMessage(reply, { type: "text", text: updateCommandList });
        }

        // ========== 4. 查詢指令回覆 (V9) ==========
        if (text === "查詢指令") {
            const queryCommandList = [
                "✨ 查詢/統計指令清單:",
                "--- 🔎 單筆與模糊查詢 ---",
                "・ `查 [流水號]` (單筆詳情)",
                "・ `查 [關鍵字]` (模糊查詢客戶/商品/備註)",
                "--- 📊 統計與聚合查詢 ---",
                "・ `狀態總數` (各狀態數量統計)",
                "・ `可結單` (查詢所有商品都抵台的客戶)",
                "・ `未完全付款可結單` (查詢抵台但有欠款的客戶)",
                "--- 🗂️ 狀態直接查詢 ---",
                "・ 直接輸入 **[狀態名]** (例如：`已到貨`, `處理中`, `結單`)",
                "---",
                "💡 輸入「指令」回主選單。"
            ].join("\n");
            return lineClient.replyMessage(reply, { type: "text", text: queryCommandList });
        }


        // ========== 5. 修改訂單 (改) - 邏輯不變 ==========
        if (text.startsWith("改 ")) {
            const updates = parseUpdate(text); 
            
            if (!updates)
                return lineClient.replyMessage(reply, { type: "text", text: "❌ 修改格式錯誤，請輸入「修改指令」查看格式。" });

            const pageId = await findPageIdByShortId(updates.shortId);
            if (!pageId)
                return lineClient.replyMessage(reply, { type: "text", text: `找不到流水號 ${updates.shortId}` });

            const updated = await updateOrder(pageId, updates); 

            return lineClient.replyMessage(reply, {
                type: "text",
                text: `✨ 已更新訂單：${getShortId(updated)}`
            });
        }

        // ========== 6. 狀態數量總覽 - 邏輯不變 ==========
        if (text === "狀態總數") {
            const summary = await querySpecificStatusSummary(); 
            return lineClient.replyMessage(reply, { type: "text", text: summary });
        }
        
        // ========== 7. 狀態與預設查詢 - 邏輯不變 ==========
        let statusQueryPages = null;
        let queryTitle = "";

        if (text.includes("未付款") || text.includes("欠款")) {
            statusQueryPages = await queryByPaymentStatus([PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PARTIAL]);
            queryTitle = "未完全付清的訂單";
        } else if (text.includes("部分付款")) {
            statusQueryPages = await queryByPaymentStatus([PAYMENT_STATUS.PARTIAL]);
            queryTitle = "部分付款的訂單";
        } else if (text.includes("已付款") || text.includes("付清")) {
            statusQueryPages = await queryByPaymentStatus([PAYMENT_STATUS.PAID]);
            queryTitle = "已付款 (付清) 的訂單";
        }
        
        else if (text === "可結單" || text.includes("哪些可以結單")) {
            // 物流是 Status 類型，使用 status 語法
            const statusFilters = SHIPMENT_READY_STATUSES.map(s => ({
                property: PROPS.status, status: { equals: s } 
            }));
            statusQueryPages = await queryDB({ or: statusFilters }); 
            queryTitle = "已抵台 (可結單) 的訂單";
        }
        // 物流是 Status 類型，使用 status 語法
        else if (text === "已到貨") {
            statusQueryPages = await queryDB({ property: PROPS.status, status: { equals: "已到貨" } });
            queryTitle = "已到貨 (不可結單) 的訂單";
        }
        
        // 物流是 Status 類型，使用 status 語法
        else if (TARGET_STATUSES.includes(text)) {
            statusQueryPages = await queryDB({ property: PROPS.status, status: { equals: text } });
            queryTitle = `${text} 的訂單`;
        }

        if (statusQueryPages !== null) {
            if (!statusQueryPages.length)
                return lineClient.replyMessage(reply, { type: "text", text: `目前沒有符合「${queryTitle.replace('的訂單', '')}」的項目 ❤️` });
            
            return lineClient.replyMessage(reply, { 
                type: "text", 
                text: renderList(statusQueryPages.slice(0, 10), queryTitle)
            });
        }
        
        // ========== 8. 統一查詢指令 (查) - 邏輯不變 ==========
        if (text.startsWith("查 ")) {
            const keyword = text.replace("查", "").trim();

            if (!keyword) 
                return lineClient.replyMessage(reply, { type: "text", text: "請在「查」後面提供關鍵字 🔎" });

            // A. 嘗試 Short ID 查詢 (查單)
            const isShortId = /^\d+$/.test(keyword);
            if (isShortId) {
                const pageId = await findPageIdByShortId(keyword);
                if (pageId) {
                    const p = await notion.pages.retrieve({ page_id: pageId });
                    return lineClient.replyMessage(reply, { type: "text", text: renderDetail(p) });
                }
            }

            // B. 多欄位關鍵字查詢 (查客 / 查品 / 查備 / 查款)
            const pages = await unifiedKeywordSearch(keyword);

            if (!pages.length)
                return lineClient.replyMessage(reply, { type: "text", text: `查不到與「${keyword}」相關的訂單` });

            return lineClient.replyMessage(reply, { 
                type: "text", 
                text: renderList(pages.slice(0, 10), `關鍵字「${keyword}」的查詢結果`)
            });
        }
        
        // ========== 9. 客戶聚合查詢 - 邏輯不變 ==========
        if (text === "全部到貨可結單" || text === "未完全付款可結單") {
            const allCustomers = await aggregateOrdersByCustomer();
            let readyList = [];
            let title = "";

            if (text === "全部到貨可結單") {
                title = "✅ 所有商品皆抵台 (可結單)";
                readyList = Object.keys(allCustomers).filter(name => allCustomers[name].readyToShip);
            } else if (text === "未完全付款可結單") {
                title = "⚠️ 抵台但有欠款 (未完全付款可結單)";
                readyList = Object.keys(allCustomers).filter(name => 
                    allCustomers[name].readyToShip && allCustomers[name].unpaidExists
                );
            }

            if (!readyList.length) {
                return lineClient.replyMessage(reply, { type: "text", text: `${title} 名單為空。` });
            }
            
            const output = readyList.map(name => 
                `${name} / ${allCustomers[name].orderCount} 筆訂單`
            ).join("\n");

            return lineClient.replyMessage(reply, {
                type: "text",
                text: `💛 ${title}（共 ${readyList.length} 人）\n\n${output}`
            });
        }
        
        // ========== 10. 組合查詢 / 自然語言 - 邏輯不變 ==========
        if (text.includes("全部到貨") && (text.includes("未付") || text.includes("欠款"))) {
            // 物流是 Status 類型，使用 status 語法
            const readyFilters = SHIPMENT_READY_STATUSES.map(s => ({
                property: PROPS.status, status: { equals: s } 
            }));
            const pages = await queryDB({
                and: [
                    { or: readyFilters },
                    { 
                        or: [
                            { property: PROPS.paymentStatus, select: { equals: PAYMENT_STATUS.UNPAID } },
                            { property: PROPS.paymentStatus, select: { equals: PAYMENT_STATUS.PARTIAL } },
                        ]
                    }
                ]
            });
            
            if (!pages.length)
                return lineClient.replyMessage(reply, { type: "text", text: "目前沒有「全部抵台但未付清」的訂單 👍" });
            
            return lineClient.replyMessage(reply, { 
                type: "text", 
                text: renderList(pages.slice(0, 10), "全部抵台但未付清的訂單")
            });
        }
        
        // ========== 11. 新增訂單 - 邏輯不變 ==========
        const order = parseOrder(text);
        if (order) {
            return handleCreateOrder(event, order); 
        }

        // ========== 12. 聽不懂 (Fallback) ==========
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


// -------------------- LINE Webhook 處理路由 (不變) --------------------
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


// -------------------- 啟動伺服器 (不變) --------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`魚魚強化版 Bot 正在 port ${port} 上運行 🚀`);
});
