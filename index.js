import express from "express";
import { middleware, Client } from "@line/bot-sdk";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const notionConfig = {
  apiKey: process.env.NOTION_API_KEY,
  databaseId: process.env.NOTION_DATABASE_ID,
};

const lineClient = new Client(lineConfig);
const app = express();

// Render 健康檢查
app.get("/", (req, res) => {
  res.send("LINE Bot is running!");
});

app.post("/webhook", middleware(lineConfig), async (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return null;
  }

  const userText = event.message.text;
  const userId = event.source.userId;

  try {
    const profile = await lineClient.getProfile(userId);
    const displayName = profile.displayName || "";

    await createNotionOrder(userText, displayName);

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text:
        "📝 已收到！\n" +
        "格式如下（後面都是選填）：\n" +
        "客人名稱 / 商品名稱 / 數量 / 金額 / 備註\n" +
        "/ 成本 / 重量 / 商品網址 / 付款狀態 / 狀態\n" +
        "/ 含國際運費 / 會員編號 / 出貨日期(YYYY-MM-DD)\n\n" +
        "有填到的欄位我會自動寫進 Notion～",
    });
  } catch (err) {
    console.error("寫入 Notion 失敗", err.response?.data || err);
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text:
        "QQ 寫入 Notion 出錯了～\n" +
        "請確認你有用「/」分隔欄位。",
    });
  }
}

// ----------------------------
// Notion 寫入功能（支援選填）
// ----------------------------
async function createNotionOrder(text, lineName) {
  const parts = text.split("/").map((p) => p.trim());

  const [
    customerName,      // 1 客人名稱
    productName,       // 2 商品名稱
    quantityStr,       // 3 數量
    priceStr,          // 4 金額
    note,              // 5 備註
    costStr,           // 6 成本
    weightStr,         // 7 重量
    productUrl,        // 8 商品網址
    paymentStatus,     // 9 付款狀態
    statusName,        // 10 狀態
    includeIntlStr,    // 11 含國際運費
    memberId,          // 12 會員編號
    shipDateStr        // 13 出貨日期
  ] = parts;

  const quantity = quantityStr ? Number(quantityStr) : NaN;
  const price = priceStr ? Number(priceStr) : NaN;
  const cost = costStr ? Number(costStr) : NaN;
  const weight = weightStr ? Number(weightStr) : NaN;

  // 判斷「含國際運費」是否為 YES
  let includeInternational = false;
  if (includeIntlStr) {
    includeInternational = /^(1|是|有|true|y)$/i.test(includeIntlStr);
  }

  // 基本欄位（必填 + LINE 名稱 + 更新時間）
  const properties = {
    商品名稱: {
      title: [{ text: { content: productName || "(未填商品)" } }],
    },
    LINE名稱: {
      rich_text: [{ text: { content: lineName } }],
    },
    客人名稱: {
      rich_text: [{ text: { content: customerName || "" } }],
    },
    備註: {
      rich_text: [{ text: { content: note || "" } }],
    },
    更新日期: {
      date: { start: new Date().toISOString() },
    },
  };

  // 依照是否填寫 → 寫入 Notion
  if (!Number.isNaN(quantity)) properties["數量"] = { number: quantity };
  if (!Number.isNaN(price)) properties["金額"] = { number: price };
  if (!Number.isNaN(cost)) properties["成本"] = { number: cost };
  if (!Number.isNaN(weight)) properties["重量"] = { number: weight };

  if (productUrl) properties["商品網址"] = { url: productUrl };

  if (paymentStatus) {
    properties["付款狀態"] = {
      status: { name: paymentStatus },
    };
  }

  if (statusName) {
    properties["狀態"] = {
      status: { name: statusName },
    };
  }

  if (includeIntlStr) {
    properties["含國際運費"] = {
      checkbox: includeInternational,
    };
  }

  if (memberId) {
    properties["會員編號"] = {
      rich_text: [{ text: { content: memberId } }],
    };
  }

  if (shipDateStr) {
    properties["出貨日期"] = {
      date: { start: shipDateStr },
    };
  }

  const url = "https://api.notion.com/v1/pages";

  const body = {
    parent: { database_id: notionConfig.databaseId },
    properties,
  };

  await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${notionConfig.apiKey}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
