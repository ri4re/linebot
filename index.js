// index.js — 魚魚專用後台 LINE Bot + Notion

import express from "express";
import { Client } from "@notionhq/client";
import line from "@line/bot-sdk";

const app = express();

// 這次我們就用一般 JSON，**不要再用 line.middleware**
app.use(express.json());

const notion = new Client({ auth: process.env.NOTION_SECRET });

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineClient = new line.Client(lineConfig);

// 不做簽名驗證版本（自己用後台足夠）
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events || [];
    const results = await Promise.all(
      events.map(handleLineEvent)
    );
    res.json(results);
  } catch (err) {
    console.error("webhook error", err);
    res.status(500).end();
  }
});

// ---------- 1. Notion 欄位對應（照你現在的 Notion） ----------

const NOTION_PROPS = {
  emailTitle: "信箱",
  memberCode: "會員編號",
  lineName: "LINE名稱",
  customerName: "客人名稱",

  productName: "商品名稱",
  style: "款式",

  quantity: "數量",
  amount: "金額",
  cost: "成本",
  profit: "利潤",

  paymentStatus: "付款狀態",
  paidAmount: "已付金額",
  remainingAmount: "剩餘金額",

  weight: "重量",
  estIntlFee: "預計國際運費",
  hasIntlFee: "含國際運費",
  productUrl: "商品網址",

  memo: "備註",
  updatedAt: "更新日期",
  shippedAt: "出貨日期",

  serialNo: "流水號",
};

// ---------- 2. 快速語彙 & 判斷工具 ----------

const QUICK_PRODUCTS = {
  "代收": "代收包裹",
  "代付": "代支付",
  "代拆專輯": "代拆",
  "代抽": "票券代抽",
  "運費": "包裹寄送",
};

function isNumber(str) {
  return /^-?\d+(\.\d+)?$/.test(str);
}

// ---------- 3. 指令路由：把文字分類（新增 / 查詢 / 修改 / 營收 / 錯誤） ----------

function routeMessage(text) {
  const raw = text.trim();
  const t = raw.replace(/\s+/g, " ");

  // 1) 格式說明
  if (t === "格式") {
    return { type: "help", payload: {} };
  }

  // 2) 查詢系列
  if (t.startsWith("查")) {
    const parts = t.split(" ");
    const keyword = parts[0];
    const value = parts.slice(1).join(" ");

    if (keyword === "查") {
      return { type: "query", payload: { mode: "customer", value } };
    }
    if (keyword === "查商品") {
      return { type: "query", payload: { mode: "product", value } };
    }
    if (keyword === "查狀態") {
      return { type: "query", payload: { mode: "status", value } };
    }
    if (keyword === "查日期") {
      return { type: "query", payload: { mode: "date", value } };
    }
  }

  if (t === "未付") {
    return { type: "query", payload: { mode: "unpaid" } };
  }
  if (t === "欠款") {
    return { type: "query", payload: { mode: "debt" } };
  }
  if (t === "今日營收") {
    return { type: "stats", payload: { mode: "today" } };
  }
  if (t === "今月營收") {
    return { type: "stats", payload: { mode: "month" } };
  }
  if (t === "總覽") {
    return { type: "stats", payload: { mode: "overview" } };
  }

  // 3) 修改：改 12 / 金額 / 500
  if (t.startsWith("改 ")) {
    const m = t.match(/^改\s+(\d+)\s*\/\s*([^/]+?)\s*\/\s*(.+)$/);
    if (m) {
      const serial = m[1];
      const field = m[2].trim();
      const value = m[3].trim();
      return {
        type: "modify",
        payload: { serialNo: serial, field, value },
      };
    }
  }

  // 快捷：已出貨 12 / 已付款 12
  if (t.startsWith("已出貨 ")) {
    const serial = t.replace("已出貨", "").trim();
    return {
      type: "modify",
      payload: { serialNo: serial, field: "付款+出貨快捷", value: "已出貨" },
    };
  }
  if (t.startsWith("已付款 ")) {
    const serial = t.replace("已付款", "").trim();
    return {
      type: "modify",
      payload: { serialNo: serial, field: "付款狀態", value: "全額付款完畢" },
    };
  }

  // 4) 快速語彙：代收1 150 宅配
  const quickToken = Object.keys(QUICK_PRODUCTS).find((key) =>
    t.startsWith(key)
  );
  if (quickToken) {
    const rest = t.slice(quickToken.length).trim();
    const parts = rest.split(" ");
    const nums = parts.filter(isNumber);
    const nonNums = parts.filter((p) => !isNumber(p));

    let qty = 1;
    let amount = 0;
    if (nums.length === 2) {
      qty = Number(nums[0]);
      amount = Number(nums[1]);
    } else if (nums.length === 1) {
      qty = 1;
      amount = Number(nums[0]);
    }
    const memo = nonNums.join(" ");

    return {
      type: "create",
      payload: {
        from: "quick",
        customerName: "魚魚", // 先預設你自己，之後可做 LINE 名稱 mapping
        productName: QUICK_PRODUCTS[quickToken],
        quantity: qty,
        amount,
        memo,
      },
    };
  }

  // 5) 一般新增：魚魚 官方相卡2 350 宅配
  const words = t.split(" ");
  if (words.length >= 2) {
    const customerName = words[0];
    const rest = words.slice(1).join(" ");

    const qtyMatch = rest.match(/(\d+)\s*(張|個|本|套)?/);
    const amountMatch = rest.match(/(\d{2,})/g);

    if (qtyMatch && amountMatch && amountMatch.length >= 1) {
      const quantity = Number(qtyMatch[1]);
      const amount = Number(amountMatch[amountMatch.length - 1]);
      const tmp = rest.replace(qtyMatch[0], "").replace(String(amount), "");
      const productName = tmp.trim() || "未填商品";
      const memo = ""; // 你之後要再拆也可以

      return {
        type: "create",
        payload: {
          from: "normal",
          customerName,
          productName,
          quantity,
          amount,
          memo,
        },
      };
    }
  }

  // 6) 其他 → 看不懂
  return { type: "error", payload: { reason: "unrecognized" } };
}

// ---------- 4. Notion：新增訂單 ----------

async function createNotionOrder(fields) {
  const {
    customerName = "未填客人",
    productName = "未填商品",
    quantity = 1,
    amount = 0,
    memo = "",
  } = fields;

  const titleString = `${customerName}｜${productName}`;

  const page = await notion.pages.create({
    parent: { database_id: process.env.NOTION_DATABASE_ID },
    properties: {
      [NOTION_PROPS.emailTitle]: {
        title: [{ text: { content: titleString } }],
      },
      [NOTION_PROPS.customerName]: {
        rich_text: [{ text: { content: customerName } }],
      },
      [NOTION_PROPS.productName]: {
        rich_text: [{ text: { content: productName } }],
      },
      [NOTION_PROPS.quantity]: {
        number: quantity,
      },
      [NOTION_PROPS.amount]: {
        number: amount,
      },
      [NOTION_PROPS.paidAmount]: {
        number: 0,
      },
      [NOTION_PROPS.paymentStatus]: {
        select: { name: "未付款" },
      },
      [NOTION_PROPS.memo]: {
        rich_text: memo ? [{ text: { content: memo } }] : [],
      },
      [NOTION_PROPS.updatedAt]: {
        date: { start: new Date().toISOString() },
      },
    },
  });

  return page;
}

// ---------- 5. Notion：查詢 / 欠款 / 未付 / 營收 ----------

async function queryDatabase(filter, sorts = []) {
  const res = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_ID,
    filter,
    sorts,
  });
  return res.results;
}

function formatOrderForLine(page) {
  const props = page.properties;
  const serial =
    props[NOTION_PROPS.serialNo]?.number ?? "無編號";
  const customer =
    props[NOTION_PROPS.customerName]?.rich_text?.[0]?.plain_text ?? "";
  const product =
    props[NOTION_PROPS.productName]?.rich_text?.[0]?.plain_text ?? "";
  const amount = props[NOTION_PROPS.amount]?.number ?? 0;
  const status =
    props[NOTION_PROPS.paymentStatus]?.select?.name ?? "";

  return `${serial}｜${customer}｜${product}｜$${amount}｜${status}`;
}

async function queryByMode(mode, value) {
  if (mode === "customer") {
    const pages = await queryDatabase({
      property: NOTION_PROPS.customerName,
      rich_text: { contains: value },
    });
    return pages.map(formatOrderForLine);
  }

  if (mode === "product") {
    const pages = await queryDatabase({
      property: NOTION_PROPS.productName,
      rich_text: { contains: value },
    });
    return pages.map(formatOrderForLine);
  }

  if (mode === "status") {
    const pages = await queryDatabase({
      property: NOTION_PROPS.paymentStatus,
      select: { equals: value },
    });
    return pages.map(formatOrderForLine);
  }

  if (mode === "date") {
    const pages = await queryDatabase({
      property: NOTION_PROPS.shippedAt,
      date: { equals: value }, // YYYY-MM-DD
    });
    return pages.map(formatOrderForLine);
  }

  if (mode === "unpaid") {
    const pages = await queryDatabase({
      and: [
        {
          property: NOTION_PROPS.paidAmount,
          number: { equals: 0 },
        },
        {
          property: NOTION_PROPS.amount,
          number: { greater_than: 0 },
        },
      ],
    });
    return pages.map(formatOrderForLine);
  }

  if (mode === "debt") {
    const pages = await queryDatabase({
      property: NOTION_PROPS.remainingAmount,
      number: { greater_than: 0 },
    });
    return pages.map(formatOrderForLine);
  }

  return [];
}

async function statsByMode(mode) {
  const now = new Date();
  const iso = now.toISOString().slice(0, 10);

  let dateFilter;
  if (mode === "today") {
    dateFilter = {
      property: NOTION_PROPS.updatedAt,
      date: { equals: iso },
    };
  } else if (mode === "month") {
    const ym = iso.slice(0, 7);
    dateFilter = {
      property: NOTION_PROPS.updatedAt,
      date: { on_or_after: `${ym}-01` },
    };
  } else {
    // overview 簡單先抓全部
    const res = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_ID,
    });
    let totalPaid = 0;
    res.results.forEach((p) => {
      const paid = p.properties[NOTION_PROPS.paidAmount]?.number ?? 0;
      totalPaid += paid;
    });
    return { count: res.results.length, totalPaid };
  }

  const res = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_ID,
    filter: dateFilter,
  });

  let totalPaid = 0;
  res.results.forEach((page) => {
    const paid = page.properties[NOTION_PROPS.paidAmount]?.number ?? 0;
    totalPaid += paid;
  });

  return { count: res.results.length, totalPaid };
}

// ---------- 6. Notion：用流水號修改訂單 ----------

async function findPageIdBySerial(serialNo) {
  const res = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_ID,
    filter: {
      property: NOTION_PROPS.serialNo,
      number: { equals: Number(serialNo) },
    },
  });
  return res.results[0]?.id || null;
}

async function modifyOrderBySerial(serialNo, field, value) {
  const pageId = await findPageIdBySerial(serialNo);
  if (!pageId) {
    throw new Error("找不到該流水號");
  }

  const props = {};

  if (field === "金額") {
    props[NOTION_PROPS.amount] = { number: Number(value) };
  } else if (field === "已付金額") {
    props[NOTION_PROPS.paidAmount] = { number: Number(value) };
  } else if (field === "付款狀態") {
    props[NOTION_PROPS.paymentStatus] = {
      select: { name: value },
    };
  } else if (field === "重量") {
    props[NOTION_PROPS.weight] = { number: Number(value) };
  } else if (field === "備註") {
    props[NOTION_PROPS.memo] = {
      rich_text: [{ text: { content: value } }],
    };
  } else if (field === "出貨日期") {
    props[NOTION_PROPS.shippedAt] = {
      date: { start: value },
    };
  } else if (field === "付款+出貨快捷") {
    props[NOTION_PROPS.paymentStatus] = {
      select: { name: "全額付款完畢" },
    };
    props[NOTION_PROPS.shippedAt] = {
      date: { start: new Date().toISOString().slice(0, 10) },
    };
  } else {
    throw new Error("不支援的欄位");
  }

  await notion.pages.update({
    page_id: pageId,
    properties: {
      ...props,
      [NOTION_PROPS.updatedAt]: {
        date: { start: new Date().toISOString() },
      },
    },
  });
}

// ---------- 7. LINE 事件處理 ----------

async function handleLineEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return null;
  }

  const text = event.message.text;
  const cmd = routeMessage(text);
  let replyText = "";

  try {
    if (cmd.type === "help") {
      replyText =
        "可用欄位：客人名稱 / 商品名稱 / 數量 / 金額 / 備註\n" +
        "指令例子：\n" +
        "・魚魚 官方相卡2 350 宅配\n" +
        "・代收1 150 宅配\n" +
        "・查 魚魚 / 查商品 相卡\n" +
        "・未付 / 欠款\n" +
        "・今日營收 / 今月營收\n" +
        "・改 12 / 金額 / 500";
    } else if (cmd.type === "create") {
      const base = {
        customerName: cmd.payload.customerName ?? "魚魚",
        productName: cmd.payload.productName,
        quantity: cmd.payload.quantity,
        amount: cmd.payload.amount,
        memo: cmd.payload.memo,
      };
      await createNotionOrder(base);
      replyText =
        "✅ 已寫入訂單！\n" +
        `客人：${base.customerName}\n` +
        `商品：${base.productName}\n` +
        `數量：${base.quantity}\n` +
        `金額：${base.amount}`;
    } else if (cmd.type === "query") {
      const list = await queryByMode(cmd.payload.mode, cmd.payload.value);
      replyText =
        list.length === 0
          ? "查無資料"
          : "查詢結果：\n" + list.slice(0, 10).join("\n");
    } else if (cmd.type === "stats") {
      const stat = await statsByMode(cmd.payload.mode);
      if (cmd.payload.mode === "today") {
        replyText = `📆 今日營收：NT$ ${stat.totalPaid}（更新筆數：${stat.count}）`;
      } else if (cmd.payload.mode === "month") {
        replyText = `📆 今月已付總額：NT$ ${stat.totalPaid}（更新筆數：${stat.count}）`;
      } else {
        replyText = `📊 總覽：筆數 ${stat.count}，已付總額 NT$ ${stat.totalPaid}`;
      }
    } else if (cmd.type === "modify") {
      await modifyOrderBySerial(
        cmd.payload.serialNo,
        cmd.payload.field,
        cmd.payload.value
      );
      replyText = `✅ 已修改流水號 ${cmd.payload.serialNo} 的「${cmd.payload.field}」`;
    } else if (cmd.type === "error") {
      replyText = "輸入錯誤，再來一次！若要看範例請輸入「格式」";
    }
  } catch (e) {
    console.error(e);
    replyText = "處理時發生錯誤 QQ";
  }

  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: replyText,
  });
}

// ---------- 8. 啟動伺服器 ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});


