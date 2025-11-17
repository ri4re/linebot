// index.js — 魚魚專用 LINE Bot + Notion 後台
// 前提：package.json 設 "type": "module"

import express from "express";
import { Client } from "@notionhq/client";
import line from "@line/bot-sdk";

// ---------- 0. 基本設定 ----------

// Express
const app = express();
app.use(express.json());

// Notion Client（用 NOTION_API_KEY）
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Notion 欄位名稱統一放這裡
const PROPS = {
  title: "信箱",          // Title
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

// ---------- 1. 小工具 ----------

// 產生短 ID（給人類看）
function shortId(pageId) {
  return pageId.replace(/-/g, "").slice(0, 6);
}

// Notion 安全取文字
function getRichTextText(richTextArray) {
  if (!Array.isArray(richTextArray) || richTextArray.length === 0) return "";
  return richTextArray.map((t) => t.plain_text || "").join("");
}

// ---------- 2. 新增訂單（寫入 Notion） ----------

async function createOrderFromText(text, userDisplayName) {
  // 格式：客人 商品 數量 金額 [備註...]
  // 例：魚魚 官方相卡2 350 宅配
  const parts = text.trim().split(/\s+/);

  if (parts.length < 4) {
    throw new Error("格式不足"); // 會被外面 catch，回錯誤訊息
  }

  const customerName = parts[0];
  const productName = parts[1];
  const quantity = Number(parts[2]);
  const amount = Number(parts[3]);
  const memo = parts.slice(4).join(" ") || "";

  if (Number.isNaN(quantity) || Number.isNaN(amount)) {
    throw new Error("數量或金額不是數字");
  }

  const nowIso = new Date().toISOString();

  const page = await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      // 標題（信箱）：先用 LINE 名稱或固定字串填一下就好
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
      // ❗ 這裡用 status，而不是 select
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

// ---------- 3. 查詢（Notion databases.query） ----------

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

// 查付款狀態（例如：未付款）
async function queryByPaymentStatus(statusName) {
  return queryDatabase({
    property: PROPS.paymentStatus,
    status: { equals: statusName },
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

// ---------- 4. LINE 訊息解析 ----------

function buildHelpText() {
  return [
    "可用欄位：客人名稱 / 商品名稱 / 數量 / 金額 / 備註",
    "指令例子：",
    "• 魚魚 官方相卡2 350 宅配",
    "• 查 魚魚",
    "• 查商品 相卡",
    "• 未付",
    "• 欠款",
  ].join("\n");
}

async function handleTextMessage(event) {
  const text = event.message.text.trim();
  const userName = event.source?.userId
    ? "" // 如果你有另外查 user profile 可以填名字
    : "";

  // 1）格式指令
  if (text === "格式") {
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: buildHelpText(),
    });
  }

  // 2）未付 / 欠款
  if (text === "未付" || text === "欠款") {
    const results = await queryUnpaid();

    if (results.length === 0) {
      return lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: "目前沒有未付款訂單。",
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
      text: `未付款訂單（前 10 筆）：\n\n${lines.join("\n\n")}`,
    });
  }

  // 3）查 客人
  if (text.startsWith("查 ")) {
    const keyword = text.slice(2).trim();
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
        text: `找不到客人「${keyword}」的訂單`,
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
      text: `查客人「${keyword}」結果（前 10 筆）：\n\n${lines.join("\n\n")}`,
    });
  }

  // 4）查商品 XXX
  if (text.startsWith("查商品")) {
    const keyword = text.replace("查商品", "").trim();
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
        text: `找不到商品「${keyword}」的訂單`,
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
      text: `查商品「${keyword}」結果（前 10 筆）：\n\n${lines.join("\n\n")}`,
    });
  }

  // 5）其他文字 → 當「新增訂單」試試看
  try {
    const order = await createOrderFromText(text, userName);

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
    console.error("createOrderFromText error", err);
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "處理時發生錯誤 QQ\n如果是新增訂單，請確認格式：客人 商品 數量 金額 [備註]",
    });
  }
}

// ---------- 5. LINE Webhook ----------

async function handleLineEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return Promise.resolve(null);
  }
  return handleTextMessage(event);
}

// 不做簽名驗證版本（你自己的後台用，這樣比較不會出錯）
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

// ---------- 6. 啟動伺服器 ----------

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
