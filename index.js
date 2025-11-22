// index.js — 魚魚 version 最終強化版（完美整合）

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
  shortIdField: "流水號", // 統一使用 shortIdField
  status: "狀態", // 訂單狀態 (e.g., 抵台, 處理中)
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

// -------------------- 快速新增產品定義 --------------------
const QUICK_PRODUCTS = {
  "代收": "代收包裹",
  "轉單": "轉單處理",
  "集運": "集運服務費",
  "代匯": "代匯款服務",
};

// -------------------- 🧰 核心小工具 --------------------

// 🧰 取得 Rich Text 內容 (V1: getRich, V2: getRichTextText)
function getRich(r) {
  if (!Array.isArray(r) || r.length === 0) return "";
  return r.map(t => t.plain_text || "").join("");
}
const getRichTextText = getRich; // 統一名稱

// 🧰 取得 Number 內容 (V1: getNumber)
function getNumber(val) {
  return typeof val === "number" ? val : 0;
}

// 🧰 錯誤格式化
function formatError(err) {
  console.error("❌ Notion API error:", JSON.stringify(err, null, 2));
  return "Notion 錯誤：" + err.message;
}

// 🧰 查詢資料庫 (V1: queryDB)
async function queryDB(filter) {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: filter || undefined,
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  });
  return res.results;
}

// 🧰 取得流水號 (V1: getShortId)
function getShortId(page) {
  const f = page.properties[PROPS.shortIdField];
  if (f?.unique_id?.number) {
    const prefix = f.unique_id.prefix || "";
    return prefix + f.unique_id.number;
  }
  return "ID?";
}
const getShortIdFromPage = getShortId; // 統一名稱


// 🧰 根據流水號查找 Page ID
async function findPageIdByShortId(shortId) {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      property: PROPS.shortIdField,
      unique_id: { equals: Number(shortId.replace(/[^0-9]/g, "")) }, // 假設只有數字
    },
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  });
  
  if (res.results.length === 0) return null;
  return res.results[0].id;
}


// -------------------- 🆕 強化後的輔助查詢工具（從 V2 複製貼上） --------------------

/** 取得頁面的狀態欄位值 (Select屬性) */
function getStatus(page) {
    // 使用 PROPS.status 統一欄位名稱
    return page.properties[PROPS.status]?.select?.name || "狀態未填";
}

/** 統一查詢：同時搜索多個欄位 (查客/查品/查備/查款) */
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

/** 根據付款狀態查詢 */
async function queryByPaymentStatus(statuses) {
    const statusFilters = statuses.map(s => ({ 
        property: PROPS.paymentStatus, select: { equals: s } 
    }));
    return queryDB({ or: statusFilters });
}

// 狀態數量列表查詢的目標狀態
const TARGET_STATUSES = [
    "處理中", "抵台", "已到貨", "已結單", "已寄出", "取消退款中"
];

/** 查詢特定狀態的數量總覽 (狀態總數) */
async function querySpecificStatusSummary() {
    const statusFilters = TARGET_STATUSES.map(s => ({
        property: PROPS.status, select: { equals: s } 
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
        output += `・ ${status}: ${statusCounts[status]} 筆\n`;
    }
    return output;
}

/** 複雜聚合查詢：按客戶分組，檢查狀態和付款狀態 (用於可結單判斷) */
async function aggregateOrdersByCustomer() {
    // 查詢所有活躍訂單
    const activePages = await queryDB({
        filter: { 
            and: [
                { property: PROPS.status, select: { does_not_equal: "已結單" } },
                { property: PROPS.status, select: { does_not_equal: "已寄出" } }
            ]
        }
    });

    const customers = {};

    activePages.forEach(p => {
        const name = getRichTextText(p.properties[PROPS.customerName]?.rich_text) || "未知客戶";
        const status = getStatus(p);
        const amount = getNumber(p.properties[PROPS.amount]?.number);
        const paid = getNumber(p.properties[PROPS.paidAmount]?.number);
        
        if (!customers[name]) {
            customers[name] = { 
                readyToShip: true,
                unpaidExists: false,
                orderCount: 0
            };
        }
        
        customers[name].orderCount++;

        // 檢查是否所有商品都抵台 (使用 V2 的邏輯：'抵台')
        if (status !== "抵台") {
            customers[name].readyToShip = false;
        }

        // 檢查是否有未付款金額
        if (amount - paid > 0) {
            customers[name].unpaidExists = true;
        }
    });

    return customers;
}

// -------------------- 🍞 可愛小卡 (不變) --------------------
function renderCuteCard(page) {
  // ... (V1 內容不變)
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

// -------------------- 📄 詳細卡 (不變) --------------------
function renderDetail(page) {
  // ... (V1 內容不變)
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

// -------------------- 📚 列表 C（查多筆）(不變) --------------------
function renderList(pages, title = "查詢結果") {
  // ... (V1 內容不變)
  let out = `💛 ${title}（${pages.length} 筆）\n\n`;

  pages.forEach(p => {
    const id = getShortId(p);
    const prod = getRich(p.properties[PROPS.productName]?.rich_text);
    const status = p.properties[PROPS.paymentStatus]?.select?.name || "—";
    out += `${id}｜${prod}｜${status}\n`;
  });

  return out.trim();
}

// -------------------- 🧩 新增訂單解析 (不變) --------------------
function parseQuickOrder(text) {
  // ... (V1 內容不變)
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
  // ... (V1 內容不變)
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

// -------------------- 📌 新增訂單 → 寫入 Notion (不變) --------------------
async function createOrder(order, originalText, lineName = "") {
  // ... (V1 內容不變)
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
      [PROPS.status]: { select: { name: "處理中" } }, // 確保新增訂單時有初始狀態
    },
  });

  return page;
}

// -------------------- 🧃 新增訂單 → LINE 回覆 (不變) --------------------
async function handleCreateOrder(event, order) {
  // ... (V1 內容不變)
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

// -------------------- 🧩 修改訂單解析 (不變) --------------------
function parseUpdate(text) {
  // ... (V1 內容不變)
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

    // 備註 (修正：確保備註: 可以抓到後面的全部文字)
    else if (p.startsWith("備註:")) {
      updates.memo = parts.slice(i).join(" ").replace("備註:", "").trim();
      break;
    }
    // 增加一個判斷：如果下一段是備註內容
    else if (p === "備註" && next) {
        updates.memo = parts.slice(i + 1).join(" ").trim();
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

  // 如果沒有任何有效更新，則返回 null
  if (Object.keys(updates).length === 1 && updates.shortId) return null;
  return updates;
}


// -------------------- Notion：更新訂單 (不變) --------------------
async function updateOrder(pageId, updates) {
  // ... (V1 內容不變)
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

// -------------------- 🆕 LINE 事件主處理 (完全替換為 V2 統一邏輯) --------------------
async function handleTextMessage(event) {
    const reply = event.replyToken;
    const text = event.message.text.trim();

    try {
        // ========== 1. 修改訂單 (改) ==========
        if (text.startsWith("改 ")) {
            const updates = parseUpdate(text);
            // V1 的 parseUpdate 在無效時返回 null
            if (!updates)
                return lineClient.replyMessage(reply, { type: "text", text: "修改格式錯誤 ❌" });

            const pageId = await findPageIdByShortId(updates.shortId);
            if (!pageId)
                return lineClient.replyMessage(reply, { type: "text", text: `找不到流水號 ${updates.shortId}` });

            const updated = await updateOrder(pageId, updates); 

            return lineClient.replyMessage(reply, {
                type: "text",
                text: `✨ 已更新訂單：${getShortId(updated)}`
            });
        }

        // ========== 2. 狀態與預設查詢 (優先處理) ==========
        let statusQueryPages = null;
        let queryTitle = "";

        // 查「未付款」/「欠款」
        if (text.includes("未付款") || text.includes("欠款")) {
            statusQueryPages = await queryByPaymentStatus([PAYMENT_STATUS.UNPAID]);
            queryTitle = "完全未付款的訂單";
        }
        // 查「部分付款」
        else if (text.includes("部分付款")) {
            statusQueryPages = await queryByPaymentStatus([PAYMENT_STATUS.PARTIAL]);
            queryTitle = "部分付款的訂單";
        }
        // 查「已付款」
        else if (text.includes("已付款") || text.includes("付清")) {
            statusQueryPages = await queryByPaymentStatus([PAYMENT_STATUS.PAID]);
            queryTitle = "已付款 (付清) 的訂單";
        }
        
        // 查「可結單」/「全部到貨」 (V1 舊邏輯的單純狀態查詢)
        else if (text === "可結單" || text.includes("哪些可以結單") || text.includes("全部到貨")) {
            statusQueryPages = await queryDB({ property: PROPS.status, select: { equals: "抵台" } }); // 假設抵台才是可結單
            queryTitle = "已抵台 (可結單) 的訂單";
        }

        if (statusQueryPages !== null) {
            if (!statusQueryPages.length)
                return lineClient.replyMessage(reply, { type: "text", text: `目前沒有符合「${queryTitle.replace('的訂單', '')}」的項目 ❤️` });
            
            return lineClient.replyMessage(reply, { 
                type: "text", 
                text: renderList(statusQueryPages.slice(0, 10), queryTitle)
            });
        }
        
        // ========== 3. 狀態數量總覽 ==========
        if (text === "狀態總數" || text === "狀態數量列表查詢") {
            const summary = await querySpecificStatusSummary();
            return lineClient.replyMessage(reply, { type: "text", text: summary });
        }


        // ========== 4. 統一查詢指令 (查) - 查單/查品/查客/查備/查款 全部整合 ==========
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
        
        // ========== 5. 客戶聚合查詢 (複雜邏輯 - 全到可結單 / 未付可結單) ==========
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
            
            // 輸出格式：人名 / 幾筆訂單
            const output = readyList.map(name => 
                `${name} / ${allCustomers[name].orderCount} 筆訂單`
            ).join("\n");

            return lineClient.replyMessage(reply, {
                type: "text",
                text: `💛 ${title}（共 ${readyList.length} 人）\n\n${output}`
            });
        }
        
        // ========== 6. 強化自然語言查詢 (V2 邏輯) ==========

        // 句式: 「我想看俊希的訂單」 (模糊查詢客戶名/商品名)
        if (text.includes("訂單") || text.includes("想看")) {
             let keyword = text.replace(/的?訂單|想看|我想看|給我|的/g, "").trim();
             
             if (keyword) {
                 const pages = await unifiedKeywordSearch(keyword);
                 
                 if (pages.length > 0) {
                     return lineClient.replyMessage(reply, { 
                         type: "text", 
                         text: renderList(pages.slice(0, 10), `與「${keyword}」相關的訂單`)
                     });
                 }
             }
        }
        
        // 句式: 「全部到貨但未付款」 (組合查詢)
        if (text.includes("全部到貨") && (text.includes("未付") || text.includes("欠款"))) {
            const pages = await queryDB({
                and: [
                    { property: PROPS.status, select: { equals: "抵台" } }, // 使用「抵台」作為到貨狀態
                    { 
                        or: [
                            { property: PROPS.paymentStatus, select: { equals: PAYMENT_STATUS.UNPAID } },
                            { property: PROPS.paymentStatus, select: { equals: PAYMENT_STATUS.PARTIAL } },
                        ]
                    }
                ]
            });
            
            if (!pages.length)
                return lineClient.replyMessage(reply, { type: "text", text: "目前沒有「全部到貨但未付清」的訂單 👍" });
            
            return lineClient.replyMessage(reply, { 
                type: "text", 
                text: renderList(pages.slice(0, 10), "全部到貨但未付清的訂單")
            });
        }
        
        // 舊的「魚魚未付」邏輯 (升級為完整列表)
        if (text.includes("未付") && text.includes("魚魚")) {
            const pages = await queryDB({
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

            return lineClient.replyMessage(reply, { 
                type: "text", 
                text: renderList(pages.slice(0, 10), "魚魚的未付訂單")
            });
        }


        // ========== 7. 新增訂單 (一般/快速格式) ==========
        const order = parseOrder(text);
        if (order) {
            return handleCreateOrder(event, order);
        }

        // ========== 8. 聽不懂 (Fallback) ==========
        return lineClient.replyMessage(reply, {
            type: "text",
            text: "聽不懂喔 💧\n請嘗試使用「查 [關鍵字]」或「改 [流水號]...」"
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
