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
    // 抓 LINE 顯示名稱（例如 魚魚、ぺりん）
    const profile = await lineClient.getProfile(userId);
    const displayName = profile.displayName || "";

    await createNotionOrder(userText, displayName);

    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text:
        "📝 已收到～\n" +
        "格式為：客人名稱 / 商品 / 數量 / 金額 / 備註\n" +
        "已幫你寫進 Notion 囉！",
    });
  } catch (err) {
    console.error("寫入 Notion 失敗", err.response?.data || err);
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text:
        "QQ 寫入 Notion 出錯了～\n" +
        "請確認格式：客人名稱 / 商品 / 數量 / 金額 / 備註",
    });
  }
}

async function createNotionOrder(text, lineName) {
  // 預期：客人名稱 / 商品 / 數量 / 金額 / 備註
  const parts = text.split("/").map((p) => p.trim());

  const customerName = parts[0] || "";      // 客人名稱（你打的：魚魚）
  const product = parts[1] || "";           // 商品
  const quantityStr = parts[2] || "";       // 數量（字串）
  const priceStr = parts[3] || "";          // 金額（字串）
  const note = parts[4] || "";              // 備註

  const quantity = Number(quantityStr) || 0;
  const price = Number(priceStr) || 0;

  const url = "https://api.notion.com/v1/pages";

  const body = {
    parent: { database_id: notionConfig.databaseId },
    properties: {
      // 商品：Title 欄位
      商品: {
        title: [
          {
            text: { content: product || "(未填商品)" },
          },
        ],
      },
      // LINE：自動抓的 LINE 顯示名稱
      LINE: {
        rich_text: [
          {
            text: { content: lineName || "" },
          },
        ],
      },
      // 客人名稱：你在訊息裡打的第一段
      客人名稱: {
        rich_text: [
          {
            text: { content: customerName || "" },
          },
        ],
      },
      // 數量：Number
      數量: {
        number: quantity,
      },
      // 金額：Number
      金額: {
        number: price,
      },
      // 備註：Rich text
      備註: {
        rich_text: [
          {
            text: { content: note },
          },
        ],
      },
      // 建立時間：如果你有這個欄位
      建立時間: {
        date: {
          start: new Date().toISOString(),
        },
      },
    },
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
