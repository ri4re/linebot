// index.js — 魚魚全強化版 (所有修正與新增功能統整)

// =================================================================
// 🚨 區塊 A: 必要的假設輔助函數與常數 (請確保您已正確定義這些)
// =================================================================

// 假設的 Notion 屬性名稱 (PROPS)
const PROPS = {
    shortId: '流水號',
    customerName: '客人名稱',
    productName: '商品名稱',
    memo: '備註',
    style: '款式',
    status: '狀態', // 訂單狀態 (e.g., 抵台, 處理中)
    paymentStatus: '付款狀態', // (e.g., 未付款, 部分付款)
    amount: '總金額',
    paidAmount: '已付金額',
    // ... 其他屬性
};

const PAYMENT_STATUS = {
    UNPAID: '未付款',
    PARTIAL: '部分付款',
    PAID: '已付款',
};

// ⚠️ 這些函數必須在您的程式碼中正確定義並可供呼叫：
// async function queryDB(filter) { /* ... Notion API 查詢邏輯 ... */ }
// function getRichTextText(rich_text_array) { /* ... 提取 rich_text 內容 ... */ }
// function getNumber(number_value) { /* ... 提取 number 值 ... */ }
// function parseUpdate(text) { /* ... 解析 '改' 指令 ... */ }
// async function findPageIdByShortId(shortId) { /* ... 查找頁面 ID ... */ }
// async function updateOrder(pageId, updates) { /* ... 更新 Notion 頁面 ... */ }
// async function handleCreateOrder(event, order) { /* ... 處理新增訂單 ... */ }
// function renderDetail(page) { /* ... 渲染訂單詳細內容 ... */ }
// function renderList(pages, title) { /* ... 渲染訂單列表 ... */ }
// function getShortId(page) { /* ... 取得流水號 ... */ }
// function formatError(err) { /* ... 格式化錯誤訊息 ... */ }
// const lineClient = { replyMessage: async (token, message) => {} };
// const notion = { pages: { retrieve: async () => {} } }; 
// -----------------------------------------------------------------


// =================================================================
// 區塊 B: 強化後的輔助查詢工具 (新增)
// =================================================================

/** 取得頁面的狀態欄位值 (Select屬性) */
function getStatus(page) {
    return page.properties[PROPS.status]?.select?.name || "狀態未填";
}

/** 統一查詢：同時搜索多個欄位 */
async function unifiedKeywordSearch(keyword) {
    const filter = {
        or: [
            { property: PROPS.customerName, rich_text: { contains: keyword } },
            { property: PROPS.productName, rich_text: { contains: keyword } },
            { property: PROPS.memo, rich_text: { contains: keyword } }, // 修正：整合查備功能
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

        // 檢查是否所有商品都抵台 (抵台 = '抵台')
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


// =================================================================
// 區塊 C: LINE 事件主處理函數 (handleTextMessage) - 統一後的版本
// =================================================================

async function handleTextMessage(event) {
    const reply = event.replyToken;
    const text = event.message.text.trim();

    try {
        // ========== 1. 修改訂單 (改) ==========
        if (text.startsWith("改 ")) {
            const updates = parseUpdate(text);
            if (!updates)
                return lineClient.replyMessage(reply, { type: "text", text: "修改格式錯誤 ❌。備註欄位請使用 '備註:內容'" });

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
        
        // 查「可結單」/「全部到貨」 (舊定義，已被聚合查詢取代，但保留單純狀態查詢)
        else if (text === "可結單" || text.includes("哪些可以結單") || text.includes("全部到貨")) {
            statusQueryPages = await queryDB({ property: PROPS.status, select: { equals: "抵台" } });
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
        
        // ========== 6. 強化自然語言查詢 ==========

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
