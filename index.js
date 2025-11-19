// index.js — 魚魚專用 LINE Bot + Notion 後台
// 前提：package.json 有 "type": "module"

import express from "express";
import { Client } from "@notionhq/client";
import line from "@line/bot-sdk";

// ---------- 0. 基本設定 ----------

const app = express();
app.use(express.json());

// Notion Client：用 NOTION_API_KEY
// !!! 請確保您的環境變數已設定 !!!
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Notion 欄位名稱（根據您的圖片 IMG_0943/0944 調整）
const PROPS = {
  title: "信箱", // Title
  customerName: "客人名稱", // rich text
  productName: "商品名稱", // rich text
  quantity: "數量", // number
  amount: "金額", // number
  paidAmount: "已付金額", // number
  paymentStatus: "付款狀態", // Status 欄位
  memo: "備註", // rich text
  updatedAt: "更新日期", // date
  
  // 🌟🌟🌟 新增：使用您的「流水號」欄位 (Notion ID 屬性) 🌟🌟🌟
  shortIdField: "流水號",
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

// 付款狀態名稱（請確認跟 Notion Status 欄位選項名稱一模一樣）
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

// 🌟🌟🌟 移除 shortId 函式，因為我們改用 Notion 內建的「流水號」 🌟🌟🌟


// 共用查詢：**不用 notion.databases.query，只用 request**
async function queryDatabase(filter) {
  const body = {
    // 依據更新日期排序
    sorts: [
      {
        property: PROPS.updatedAt,
        direction: "descending",
      },
    ],
  };

  if (filter) {
    body.filter = filter;
  }
  
  const res = await notion.request({
    path: `databases/${NOTION_DATABASE_ID}/query`,
    method: "POST",
    body,
  });

  return res.results;
}

// 🌟🌟🌟 核心修改：根據「流水號」找到 Page ID (最穩健) 🌟🌟🌟
async function findPageIdByShortId(shortId) {
    // 1. 取得純數字 ID (如果使用者輸入 FISH-123，只取 123)
    const pureId = shortId.replace(/[^0-9]/g, ''); 
    if (!pureId) return null;
    
    // 2. 使用 Notion API 的 unique_id 屬性過濾器進行精準查詢
    const pages = await queryDatabase({
        property: PROPS.shortIdField, // "流水號"
        unique_id: { equals: Number(pureId) }, // 必須轉成數字
    }); 

    // 只需要第一筆結果 (因為 ID 是唯一的)
    return pages.length > 0 ? pages[0].id : null;
}

// ---------- 1. 解析文字 → 訂單結構或指令 ----------

// 嘗試解析成「快速語彙」訂單 (與之前相同)
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

// 一般訂單：客人 商品 數量 金額 [備註...] (與之前相同)
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

// 統一解析 (與之前相同)
function parseOrder(text) {
  const quick = parseQuickOrder(text);
  if (quick) return quick;

  const normal = parseNormalOrder(text);
  if (normal) return normal;

  return null;
}

// 解析「修改」指令：改 [流水號] [已付 | 付清 | 狀態: [新狀態]] [金額] [備註: [新備註]]
function parseUpdate(text) {
  const parts = text.trim().split(/\s+/);
  // 短 ID 現在可以是 FISH-123 或 123
  if (parts.length < 3 || parts[0] !== "改") return null;

  const shortId = parts[1];
  const updates = { shortId };

  for (let i = 2; i < parts.length; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];

    if (part === "付清") {
      updates.status = PAYMENT_STATUS.PAID;
      updates.paidAmount = "FULL"; // 特殊標記
    } else if (part === "已付" && nextPart && /^\d+(\.\d+)?$/.test(nextPart)) {
      updates.paidAmount = Number(nextPart);
      i++;
    } else if (part.startsWith("備註:")) {
      updates.memo = parts.slice(i).join(" ").substring(3).trim();
      break;
    } else if (part.startsWith("狀態:")) {
      const statusText = part.substring(3).trim();
      const statusValue = Object.values(PAYMENT_STATUS).find(v => v.includes(statusText));
      if (statusValue) {
        updates.status = statusValue;
      }
    }
  }

  if (Object.keys(updates).length <= 1) return null;
  return updates;
}


// ---------- 2. 寫入 Notion：新增/修改訂單 ----------

async function createOrder(order, originalText) {
  const nowIso = new Date().toISOString();
  
  // 🌟🌟🌟 新增時不需要包含「流水號」，Notion 會自動生成 🌟🌟🌟

  const page = await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      [PROPS.title]: {
        title: [
          {
            text: {
              content: originalText, 
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
        status: { name: PAYMENT_STATUS.UNPAID }, // 一律先寫未付款
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

// updateOrder 函式 (與之前相同，邏輯不變)
async function updateOrder(pageId, updates) {
  const properties = {
    [PROPS.updatedAt]: { date: { start: new Date().toISOString() } },
  };

  // 1. 處理已付金額和付款狀態
  if (updates.paidAmount !== undefined || updates.status) {
    const currentPage = await notion.pages.retrieve({ page_id: pageId });
    const currentAmount = currentPage.properties[PROPS.amount]?.number ?? 0;
    const currentPaid = currentPage.properties[PROPS.paidAmount]?.number ?? 0;

    let newPaidAmount = currentPaid;
    let newStatus = updates.status || currentPage.properties[PROPS.paymentStatus]?.status?.name;

    if (updates.paidAmount === "FULL") {
      newPaidAmount = currentAmount;
      newStatus = PAYMENT_STATUS.PAID;
    } else if (updates.paidAmount !== undefined) {
      newPaidAmount = updates.paidAmount;
    }
    
    // 根據金額判斷狀態 (如果 status 沒有明確指定)
    if (!updates.status) {
        if (newPaidAmount >= currentAmount && currentAmount > 0) {
            newStatus = PAYMENT_STATUS.PAID;
        } else if (newPaidAmount > 0) {
            newStatus = PAYMENT_STATUS.PARTIAL;
        } else {
            newStatus = PAYMENT_STATUS.UNPAID;
        }
    }

    if (newPaidAmount !== undefined) {
      properties[PROPS.paidAmount] = { number: newPaidAmount };
    }
    if (newStatus) {
      properties[PROPS.paymentStatus] = { status: { name: newStatus } };
    }
  }

  // 2. 處理備註
  if (updates.memo !== undefined) {
    properties[PROPS.memo] = {
      rich_text: [{ text: { content: updates.memo } }],
    };
  }

  const page = await notion.pages.update({
    page_id: pageId,
    properties,
  });

  return page;
}

// ---------- 3. 查詢功能 ----------

// 查客人 (與之前相同)
async function queryByCustomer(name) {
  return queryDatabase({
    property: PROPS.customerName,
    rich_text: { contains: name },
  });
}

// 查商品 (與之前相同)
async function queryByProduct(keyword) {
  return queryDatabase({
    property: PROPS.productName,
    rich_text: { contains: keyword },
  });
}

// 查未付款（未付或部分付款）(與之前相同)
async function queryUnpaid() {
  return queryDatabase({
    or: [
      { property: PROPS.paymentStatus, status: { equals: PAYMENT_STATUS.UNPAID } },
      { property: PROPS.paymentStatus, status: { equals: PAYMENT_STATUS.PARTIAL } },
    ]
  });
}

// ---------- 4. LINE 訊息處理 ----------

function buildHelpText() {
  return [
    "📌 訂單格式：",
    "• 客人 商品 數量 金額 [備註...]",
    "• 魚魚 官方相卡 2 350 宅配",
    "• 代收 4 150 宅配",
    "---",
    "🔍 查詢指令：",
    "• 查 魚魚 (查客人)",
    "• 查商品 相卡 (查商品)",
    "• 未付 / 欠款 (查未付/部分付款)",
    "---",
    "✍️ 修改指令：",
    "• 改 [流水號] 已付 [金額] (更新已付金額)",
    "• 改 [流水號] 付清 (更新為已付款)",
    "• 範例：改 FISH-1 已付 500",
    "• 範例：改 1 付清",
    "⚠️ 請使用 Notion 資料庫中的「流水號」進行修改。",
  ].join("\n");
}

// 從 page 物件中讀取「流水號」欄位的值
function getShortIdFromPage(page) {
    const property = page.properties[PROPS.shortIdField];
    if (property?.type === 'unique_id' && property.unique_id?.number) {
        const prefix = property.unique_id.prefix || '';
        return `${prefix}${property.unique_id.number}`;
    }
    return '未知ID';
}


async function handleTextMessage(event) {
  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  // 1) 格式 / 幫助
  if (text === "格式" || text === "幫助" || text === "help") {
    return lineClient.replyMessage(replyToken, {
      type: "text",
      text: buildHelpText(),
    });
  }

  // 2) 修改訂單
  if (text.startsWith("改 ")) {
    const update = parseUpdate(text);
    if (!update || !update.shortId) {
      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: "修改格式錯誤，請輸入例如：改 FISH-1 已付 100",
      });
    }

    try {
      // 🌟 使用新的、更穩健的短 ID 搜尋邏輯
      const pageId = await findPageIdByShortId(update.shortId);
      
      if (!pageId) {
        return lineClient.replyMessage(replyToken, {
          type: "text",
          text: `找不到 流水號 為 ${update.shortId} 的訂單 QQ`,
        });
      }

      const updatedPage = await updateOrder(pageId, update);
      
      // 讀取更新後的資料
      const props = updatedPage.properties;
      const c = getRichTextText(props[PROPS.customerName]?.rich_text);
      const prod = getRichTextText(props[PROPS.productName]?.rich_text);
      const amt = props[PROPS.amount]?.number ?? 0;
      const paid = props[PROPS.paidAmount]?.number ?? 0;
      const status = props[PROPS.paymentStatus]?.status?.name ?? "";
      const memo = getRichTextText(props[PROPS.memo]?.rich_text);
      // 讀取「流水號」
      const finalShortId = getShortIdFromPage(updatedPage);


      const lines = [
        "✅ 訂單已更新：",
        `流水號：${finalShortId}`,
        `客人：${c}｜商品：${prod}`,
        `金額：$${amt}｜已付：$${paid}｜狀態：${status}`,
        memo ? `備註：${memo}` : "",
      ].filter(Boolean);

      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: lines.join("\n"),
      });
    } catch (err) {
      console.error("updateOrder error", err);
      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: "修改訂單時發生錯誤 QQ",
      });
    }
  }

  // 3) 未付 / 欠款
  if (text === "未付" || text === "欠款") {
    try {
      const pages = await queryUnpaid();

      if (pages.length === 0) {
        return lineClient.replyMessage(replyToken, {
          type: "text",
          text: "目前沒有未付款或部分付款的訂單。",
        });
      }

      const lines = pages.slice(0, 10).map((p, idx) => {
        const props = p.properties;
        const c = getRichTextText(props[PROPS.customerName]?.rich_text);
        const prod = getRichTextText(props[PROPS.productName]?.rich_text);
        const amt = props[PROPS.amount]?.number ?? 0;
        const paid = props[PROPS.paidAmount]?.number ?? 0;
        const remain = amt - paid;
        const status = props[PROPS.paymentStatus]?.status?.name ?? "";
        const finalShortId = getShortIdFromPage(p); // 讀取「流水號」

        return `${idx + 1}️⃣ ${c}｜${prod}｜$${amt}｜已付$${paid}｜剩$${remain}\n狀態：${status}｜流水號：${finalShortId}`;
      });

      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: `未付款訂單（前 ${lines.length} 筆）：\n\n${lines.join("\n\n")}`,
      });
    } catch (err) {
      console.error("queryUnpaid error", err);
      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: "查詢未付款時發生錯誤 QQ",
      });
    }
  }

  // 4) 查 客人
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
        const c = getRichTextText(props[PROPS.customerName]?.rich_text);
        const prod = getRichTextText(props[PROPS.productName]?.rich_text);
        const amt = props[PROPS.amount]?.number ?? 0;
        const status = props[PROPS.paymentStatus]?.status?.name ?? "";
        const finalShortId = getShortIdFromPage(p);

        return `${idx + 1}️⃣ ${c}｜${prod}｜$${amt}｜${status}\n流水號：${finalShortId}`;
      });

      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: `查客人「${keyword}」結果（前 ${lines.length} 筆）：\n\n${lines.join("\n\n")}`,
      });
    } catch (err) {
      console.error("queryByCustomer error", err);
      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: "查詢客人時發生錯誤 QQ",
      });
    }
  }

  // 5) 查商品
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
        const c = getRichTextText(props[PROPS.customerName]?.rich_text);
        const prod = getRichTextText(props[PROPS.productName]?.rich_text);
        const amt = props[PROPS.amount]?.number ?? 0;
        const status = props[PROPS.paymentStatus]?.status?.name ?? "";
        const finalShortId = getShortIdFromPage(p);

        return `${idx + 1}️⃣ ${c}｜${prod}｜$${amt}｜${status}\n流水號：${finalShortId}`;
      });

      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: `查商品「${keyword}」結果（前 ${lines.length} 筆）：\n\n${lines.join("\n\n")}`,
      });
    } catch (err) {
      console.error("queryByProduct error", err);
      return lineClient.replyMessage(replyToken, {
        type: "text",
        text: "查詢商品時發生錯誤 QQ",
      });
    }
  }

  // 6) 其他 → 嘗試當「新增訂單」
  const order = parseOrder(text);
  if (!order) {
    // 防呆：非訂單、非指令不寫入
    return lineClient.replyMessage(replyToken, {
      type: "text",
      text: "這不是訂單格式喔～\n如果要看範例可以輸入「格式」",
    });
  }

  try {
    const page = await createOrder(order, text);
    
    // 取得 Notion 自動生成的「流水號」
    const finalShortId = getShortIdFromPage(page);

    const lines = [
      "✅ 已寫入訂單：",
      `流水號：${finalShortId}`,
      `客人：${order.customerName}`,
      `商品：${order.productName}`,
      `數量：${order.quantity}`,
      `金額：${order.amount}`,
      order.memo ? `備註：${order.memo}` : "",
    ].filter(Boolean);

    return lineClient.replyMessage(replyToken, {
      type: "text",
      text: lines.join("\n"),
    });
  } catch (err) {
    console.error("createOrder error", err);
    // ⚠️ 如果這裡出錯，通常是 NOTION_API_KEY 或 NOTION_DATABASE_ID 錯誤
    return lineClient.replyMessage(replyToken, {
      type: "text",
      text: `寫入 Notion 時發生錯誤 QQ\n請確認環境變數和 Integration 權限。`,
    });
  }
}

// 處理 LINE Event
async function handleLineEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    // 忽略非文字訊息
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
    // ⚠️ 這裡的錯誤通常是 LINE/網路問題，而不是 Notion 問題
    console.error("webhook processing error", err);
    res.status(500).end();
  }
});

// ---------- 6. 啟動伺服器 ----------

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});

