// index.js — 魚魚專用 LINE Bot + Notion 後台
// 前提：package.json 有 "type": "module"

import express from "express";
import { Client } from "@notionhq/client";
import line from "@line/bot-sdk";

// ---------- 0. 基本設定 ----------

const app = express();
app.use(express.json());

// Notion Client：用 NOTION_API_KEY
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Notion 欄位名稱（請確認跟資料庫一模一樣）
const PROPS = {
  title: "信箱",            // Title
  customerName: "客人名稱",  // rich text
  productName: "商品名稱",   // rich text
  quantity: "數量",         // number
  amount: "金額",           // number
  paidAmount: "已付金額",   // number
  paymentStatus: "付款狀態", // Status 欄位
  memo: "備註",             // rich text
  updatedAt: "更新日期",    // date
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

// ---------- 小工具 ----------

// 安全拿 rich_text 的純文字
function getRichTextText(richTextArray) {
  if (!Array.isArray(richTextArray) || richTextArray.length === 0) return "";
  return richTextArray.map((t) => t.plain_text || "").join("");
}

// 頁面短 ID
function shortId(pageId) {
  return pageId.replace(/-/g, "").slice(0, 6);
}

// 共用查詢：**不用 notion.databases.query，只用 request**
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

// ---------- 1. 解析文字 → 訂單結構 ----------

// 嘗試解析成「快速語彙」訂單
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
    customerName: "魚魚", // 快速模式預設你自己
    productName: QUICK_PRODUCTS[key],
    quantity,
    amount,
    memo,
  };
}

// 一般訂單：客人 商品 數量 金額 [備註...]
function parseNormalOrder(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 4) return null;

  const [customerName, productName, qtyStr, amountStr, ...rest] = parts;

  if (!/^\d+(\.\d+)?$/.test(qtyStr) || !/^\d+(\.\d+)?$/.test(amountStr)) {
    return null;
  }

  const quantity = Number(qtyStr);
  const amount = Number(amountStr);
  const memo = rest.join(" ");

  return {
    customerName,
    productName,
    quantity,
    amount,
    memo,
  };
}

// 統一解析：先試快速語彙，再試一般格式
function parseOrder(text) {
  const quick = parseQuickOrder(text);
  if (quick) return quick;

  const normal = parseNormalOrder(text);
  if (normal) return normal;

  return null;
}

// ---------- 2. 寫入 Notion：新增訂單 ----------

async function createOrder(order, userDisplayName) {
  const nowIso = new Date().toISOString();

  const page = await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      [PROPS.title]: {
        title: [
          {
            text: {
              content:
                userDisplayName || `${order.customerName}｜${order.productName}`,
            },
          },
        ],
      },
      [PROPS.customerName]: {
        rich_text: [{ text: { content: order.customerName } }],
      },
      [PROPS.productName]: {
        rich_text: [{ text: { content: order.productName } }],
      },
      [PROPS.quantity]: {
        number: order.quantity,
      },
      [PROPS.amount]: {
        number: order.amount,
      },
      [PROPS.paidAmount]: {
        number: 0,
      },
      [PROPS.paymentStatus]: {
        status: { name: "未付款" }, // 一律先寫未付款
      },
      [PROPS.memo]: {
        rich_text: order.memo
          ? [{ text: { content: order.memo } }]
          : [],
      },
      [PROPS.updatedAt]: {
        date: { start: nowIso },
      },
    },
  });

  return page;
}

// ---------- 3. 查詢功能 ----------

// 查客人
async function queryByCustomer(name) {
  return queryDatabase({
    property: PROPS.customerName,
    rich_text: { contains: name },
  });
}

// 查商品
async function queryByProduct(keyword) {
  return queryDatabase({
    property: PROPS.productName,
    rich_text: { contains: keyword },
  });
}

// 查未付款（簡單版）
async function queryUnpaid() {
  return queryDatabase({
    property: PROPS.paymentStatus,
    status: { equals: "未付款" },
  });
}

// ---------- 4. LINE 訊息處理 ----------

function buildHelpText() {
  return [
    "可用欄位：客人名稱 / 商品名稱 / 數量 / 金額 / 備註",
    "指令例子：",
    "• 魚魚 官方相卡 2 350 宅配",
    "• 代收 4 150 宅配",
    "• 查 魚魚",
    "• 查商品 相卡",
    "• 未付 / 欠款",
  ].join("\n");
}

async function handleTextMessage(event) {
  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  // 1) 格式
  if (text === "格式") {
    return lineClient.replyMessage(replyToken, {
      type: "text",
      text: buildHelpText(),
    });
  }

  // 2) 未付 / 欠款
  if (text === "未付" || text === "欠款") {
    try {
      const pages = await queryUnpaid();

      if (pages.length === 0) {
        return lineClient.replyMessage(replyToken, {
          type: "text",
          text: "目前沒有未付款訂單。",
        });
      }

      const lines = pages.slice(0, 10).map((p, idx) => {
        const props = p.properties;
        const c = getRichTextText(
          props[PROPS.customerName]?.rich_text
        );
        const prod = getRichTextText(
          props[PROPS.productName]?.rich_text
        );
        const amt = props[PROPS.amount]?.number ?? 0;
        const paid = props[PROPS.paidAmount]?.number ?? 0;
        const remain = amt - paid;

        return `${idx + 1}️⃣ ${c}｜${prod}｜$${amt}｜已付$${paid}｜剩$${remain}\nID：${shortId(
          p.id
        )}`;
      });

      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: `未付款訂單（前 10 筆）：\n\n${lines.join("\n\n")}`,
      });
    } catch (err) {
      console.error("queryUnpaid error", err);
      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: "查詢未付款時發生錯誤 QQ",
      });
    }
  }

  // 3) 查 客人
  if (text.startsWith("查 ")) {
    const keyword = text.slice(2).trim();
    if (!keyword) {
      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: "請輸入要查的客人名稱，例如：查 魚魚",
      });
    }

    try {
      const pages = await queryByCustomer(keyword);

      if (pages.length === 0) {
        return lineClient.replyMessage(replyToken, {
          type: "text",
          text: `找不到客人「${keyword}」的訂單`,
        });
      }

      const lines = pages.slice(0, 10).map((p, idx) => {
        const props = p.properties;
        const c = getRichTextText(
          props[PROPS.customerName]?.rich_text
        );
        const prod = getRichTextText(
          props[PROPS.productName]?.rich_text
        );
        const amt = props[PROPS.amount]?.number ?? 0;
        const status =
          props[PROPS.paymentStatus]?.status?.name ?? "";

        return `${idx + 1}️⃣ ${c}｜${prod}｜$${amt}｜${status}\nID：${shortId(
          p.id
        )}`;
      });

      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: `查客人「${keyword}」結果（前 10 筆）：\n\n${lines.join("\n\n")}`,
      });
    } catch (err) {
      console.error("queryByCustomer error", err);
      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: "查詢客人時發生錯誤 QQ",
      });
    }
  }

  // 4) 查商品
  if (text.startsWith("查商品")) {
    const keyword = text.replace("查商品", "").trim();
    if (!keyword) {
      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: "請輸入要查的商品，例如：查商品 相卡",
      });
    }

    try {
      const pages = await queryByProduct(keyword);

      if (pages.length === 0) {
        return lineClient.replyMessage(replyToken, {
          type: "text",
          text: `找不到商品「${keyword}」的訂單`,
        });
      }

      const lines = pages.slice(0, 10).map((p, idx) => {
        const props = p.properties;
        const c = getRichTextText(
          props[PROPS.customerName]?.rich_text
        );
        const prod = getRichTextText(
          props[PROPS.productName]?.rich_text
        );
        const amt = props[PROPS.amount]?.number ?? 0;
        const status =
          props[PROPS.paymentStatus]?.status?.name ?? "";

        return `${idx + 1}️⃣ ${c}｜${prod}｜$${amt}｜${status}\nID：${shortId(
          p.id
        )}`;
      });

      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: `查商品「${keyword}」結果（前 10 筆）：\n\n${lines.join("\n\n")}`,
      });
    } catch (err) {
      console.error("queryByProduct error", err);
      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: "查詢商品時發生錯誤 QQ",
      });
    }
  }

  // 5) 其他 → 嘗試當「新增訂單」
  const order = parseOrder(text);
  if (!order) {
    // 防呆：非訂單不寫入
    return lineClient.replyMessage(replyToken, {
      type: "text",
      text: "這不是訂單格式喔～\n如果要看範例可以輸入「格式」",
    });
  }

  try {
    const page = await createOrder(order, "LINE 訂單");

    const lines = [
      "✅ 已寫入訂單：",
      `客人：${order.customerName}`,
      `商品：${order.productName}`,
      `數量：${order.quantity}`,
      `金額：${order.amount}`,
      order.memo ? `備註：${order.memo}` : "",
      `ID：${shortId(page.id)}`,
    ].filter(Boolean);

    return lineClient.replyMessage(replyToken, {
      type: "text",
      text: lines.join("\n"),
    });
  } catch (err) {
    console.error("createOrder error", err);
    return lineClient.replyMessage(replyToken, {
      type: "text",
      text: "寫入 Notion 時發生錯誤 QQ",
    });
  }
}

// 處理 LINE Event
async function handleLineEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return null;
  }
  return handleTextMessage(event);
}

// ---------- 5. Webhook（不做簽名驗證） ----------

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
