// index.js — 魚魚專用 LINE Bot + Notion 後台
// 前提：package.json 設 "type": "module"

import express from "express";
import { Client } from "@notionhq/client";
import line from "@line/bot-sdk";

// ****************************** 0. 基本設定 ******************************

// Express
const app = express();
// 注意：如果使用 line.middleware，express.json() 應該移除或在 middleware 之前
// 這裡先保留，但在正式環境建議使用 LINE SDK 的驗證中間件
// app.use(express.json()); 

// Notion Client（用 NOTION_API_KEY）
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Notion 欄位名稱統一放這裡
const PROPS = {
  title: "信箱",              // Title
  customerName: "客人名稱",
  productName: "商品名稱",
  quantity: "數量",
  amount: "金額",
  paidAmount: "已付金額",
  paymentStatus: "付款狀態", // Status 欄位
  memo: "備註",
  updatedAt: "更新日期",
};

// LINE 基本設定
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineClient = new line.Client(lineConfig);

// ****************************** 1. 小工具 ******************************

// 產生短 ID（給人類看）
function shortId(pageId) {
  return pageId.replace(/-/g, "").slice(0, 6);
}

// Notion 安全取文字
function getRichTextText(richTextArray) {
  if (!Array.isArray(richTextArray) || richTextArray.length === 0) return "";
  return richTextArray.map((t) => t.plain_text || "").join("");
}

// 獲取 LINE 用戶名稱 (用於新增訂單 Title)
async function getUserProfile(userId) {
  try {
    const profile = await lineClient.getProfile(userId);
    return profile.displayName;
  } catch (err) {
    // 可能是群組/房間訊息或 LINE API 錯誤
    console.warn(`無法獲取用戶 ID ${userId} 的 profile:`, err.message);
    return "LINE 訂單";
  }
}

// ****************************** 2. 新增訂單（寫入 Notion） ******************************

async function createOrderFromText(text, userDisplayName) {
  // 格式：客人 商品 數量 金額 [備註...]
  // 例：魚魚 官方相卡2 350 宅配
  const parts = text.trim().split(/\s+/);

  if (parts.length < 4) {
    throw new Error("格式不足：需要 客人 商品 數量 金額");
  }

  const customerName = parts[0];
  const productName = parts[1];
  const quantity = Number(parts[2]);
  const amount = Number(parts[3]);
  const memo = parts.slice(4).join(" ") || "";

  if (Number.isNaN(quantity) || Number.isNaN(amount)) {
    throw new Error("數量或金額不是數字，請重新檢查");
  }

  const nowIso = new Date().toISOString();

  const page = await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      // 標題（信箱）：用 LINE 名稱或固定字串填入
      [PROPS.title]: {
        title: [
          {
            text: {
              content: userDisplayName || "LINE 訂單",
            },
          },
        ],
      },
      [PROPS.customerName]: {
        rich_text: [{ text: { content: customerName } }],
      },
      [PROPS.productName]: {
        rich_text: [{ text: { content: productName } }],
      },
      [PROPS.quantity]: {
        number: quantity,
      },
      [PROPS.amount]: {
        number: amount,
      },
      [PROPS.paidAmount]: {
        number: 0,
      },
      // 這裡用 status
      [PROPS.paymentStatus]: {
        status: { name: "未付款" },
      },
      [PROPS.memo]: {
        rich_text: memo ? [{ text: { content: memo } }] : [],
      },
      [PROPS.updatedAt]: {
        date: { start: nowIso },
      },
    },
  });

  return {
    id: page.id,
    customerName,
    productName,
    quantity,
    amount,
    memo,
  };
}

// ****************************** 3. 查詢（Notion databases.query） ******************************

async function queryDatabase(filter) {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter,
    sorts: [
      {
        property: PROPS.updatedAt,
        direction: "descending",
      },
    ],
  });
  return res.results;
}

// 查客人
async function queryByCustomer(keyword) {
  return queryDatabase({
    property: PROPS.customerName,
    rich_text: { contains: keyword },
  });
}

// 查商品
async function queryByProduct(keyword) {
  return queryDatabase({
    property: PROPS.productName,
    rich_text: { contains: keyword },
  });
}

// 查欠款（未付款＋金額>0）
async function queryUnpaid() {
  return queryDatabase({
    and: [
      {
        property: PROPS.paymentStatus,
        status: { equals: "未付款" },
      },
      {
        property: PROPS.amount,
        number: { greater_than: 0 },
      },
    ],
  });
}

// ****************************** 4. LINE 訊息解析 (核心邏輯調整) ******************************

function buildHelpText() {
  return [
    "✅ 指令列表：",
    "• **格式**：顯示此幫助訊息",
    "• **未付** 或 **欠款**：查詢所有未付款訂單 (前 10 筆)",
    "• **查 客人名稱**：查詢指定客人名稱的訂單 (例如：查 魚魚)",
    "• **查商品 商品名稱**：查詢指定商品的訂單 (例如：查商品 相卡)",
    "---",
    "✏️ 新增訂單格式：",
    "**客人名稱 商品名稱 數量 金額 [備註...]**",
    "• 例子：魚魚 官方相卡 2 350 宅配",
  ].join("\n");
}

async function handleTextMessage(event) {
  const rawText = event.message.text.trim();
  const lowerText = rawText.toLowerCase(); // 方便指令判斷

  // 1. 獲取用戶名稱 (用於新增訂單)
  let userName = "LINE 訂單";
  if (event.source.userId) {
    userName = await getUserProfile(event.source.userId);
  }

  // 2. 格式指令 (最高優先級)
  if (lowerText === "格式") {
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: buildHelpText(),
    });
  }

  // 3. 未付 / 欠款
  if (lowerText === "未付" || lowerText === "欠款") {
    const results = await queryUnpaid();

    if (results.length === 0) {
      return lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: "💰 目前沒有未付款訂單。",
      });
    }

    const lines = results.slice(0, 10).map((page, idx) => {
      const props = page.properties;
      const customer = getRichTextText(props[PROPS.customerName]?.rich_text);
      const product = getRichTextText(props[PROPS.productName]?.rich_text);
      const amount = props[PROPS.amount]?.number ?? 0;
      const paid = props[PROPS.paidAmount]?.number ?? 0;
      const remain = amount - paid;

      return `${idx + 1}️⃣ ${customer}｜${product}｜$${amount}｜已付$${paid}｜剩$${remain}\nID：${shortId(
        page.id
      )}`;
    });

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: `💸 未付款訂單（前 ${results.length > 10 ? 10 : results.length} 筆）：\n\n${lines.join("\n\n")}`,
    });
  }

  // 4. 查 客人
  if (lowerText.startsWith("查 ")) {
    const keyword = rawText.slice(2).trim();
    if (!keyword) {
      return lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: "請輸入要查的客人名稱，例如：查 魚魚",
      });
    }

    const results = await queryByCustomer(keyword);
    if (results.length === 0) {
      return lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: `🔍 找不到客人「${keyword}」的訂單`,
      });
    }

    const lines = results.slice(0, 10).map((page, idx) => {
      const props = page.properties;
      const customer = getRichTextText(props[PROPS.customerName]?.rich_text);
      const product = getRichTextText(props[PROPS.productName]?.rich_text);
      const amount = props[PROPS.amount]?.number ?? 0;
      const status = props[PROPS.paymentStatus]?.status?.name ?? "";

      return `${idx + 1}️⃣ ${customer}｜${product}｜$${amount}｜${status}\nID：${shortId(
        page.id
      )}`;
    });

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: `🔍 客人「${keyword}」訂單（前 ${results.length > 10 ? 10 : results.length} 筆）：\n\n${lines.join("\n\n")}`,
    });
  }

  // 5. 查商品 XXX
  if (lowerText.startsWith("查商品")) {
    const keyword = rawText.replace("查商品", "").trim();
    if (!keyword) {
      return lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: "請輸入要查的商品，例如：查商品 相卡",
      });
    }

    const results = await queryByProduct(keyword);
    if (results.length === 0) {
      return lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: `🔍 找不到商品「${keyword}」的訂單`,
      });
    }

    const lines = results.slice(0, 10).map((page, idx) => {
      const props = page.properties;
      const customer = getRichTextText(props[PROPS.customerName]?.rich_text);
      const product = getRichTextText(props[PROPS.productName]?.rich_text);
      const amount = props[PROPS.amount]?.number ?? 0;
      const status = props[PROPS.paymentStatus]?.status?.name ?? "";

      return `${idx + 1}️⃣ ${customer}｜${product}｜$${amount}｜${status}\nID：${shortId(
        page.id
      )}`;
    });

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: `🔍 商品「${keyword}」訂單（前 ${results.length > 10 ? 10 : results.length} 筆）：\n\n${lines.join("\n\n")}`,
    });
  }

  // 6. 其他文字 → 當「新增訂單」試試看 (最低優先級)
  try {
    const order = await createOrderFromText(rawText, userName);

    const confirmText =
      [
        "✅ 已寫入訂單：",
        `客人：${order.customerName}`,
        `商品：${order.productName}`,
        `數量：${order.quantity}`,
        `金額：${order.amount}`,
        order.memo ? `備註：${order.memo}` : "",
        `ID：${shortId(order.id)}`,
      ]
        .filter(Boolean)
        .join("\n");

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: confirmText,
    });
  } catch (err) {
    console.error("createOrderFromText error", err.message);

    // 格式錯誤時回覆更清晰的訊息
    const formatErrorMsg = "處理時發生錯誤 💔\n請確認格式是否為：客人 商品 數量 金額 [備註]\n(例如：魚魚 相卡 2 350 宅配)";

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: err.message.startsWith('格式不足') || err.message.includes('不是數字') ? formatErrorMsg : `系統錯誤：${err.message}`,
    });
  }
}

// ****************************** 5. LINE Webhook ******************************

async function handleLineEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return Promise.resolve(null);
  }
  return handleTextMessage(event);
}

// 推薦：啟用簽名驗證版本 (更安全)
// app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
//   try {
//     const events = req.body.events || [];
//     const results = await Promise.all(events.map(handleLineEvent));
//     res.json(results);
//   } catch (err) {
//     console.error("webhook error", err);
//     res.status(500).end();
//   }
// });

// 不做簽名驗證版本（您原本的版本，但請注意安全性）
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events || [];
    const results = await Promise.all(events.map(handleLineEvent));
    res.json(results);
  } catch (err) {
    console.error("webhook error", err);
    res.status(500).end();
  }
});

// ****************************** 6. 啟動伺服器 ******************************

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
