const puppeteer = require("puppeteer");
const axios = require("axios");
const pLimit = require("p-limit");
const { google } = require("googleapis");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");

const scopes = ["https://www.googleapis.com/auth/spreadsheets"];
const app = express();
const PORT = process.env.PORT || 3000;
app.use(bodyParser.json());

const FEED_API_URL = "https://ohou.se/productions/feed.json";
const SEARCH_AFFECT_TYPE = "Typing";
const V = 7;
const PER_PAGE = 20;
const MAX_PAGES = 75; // 20*75 = 1500위까지
const MAX_CONCURRENCY = 3; // 최대 3키워드 병렬

function sleep(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

// 구글 시트에서 데이터 가져오기
async function getRowsFromSheet(sheets, spreadsheetId, sheetName) {
  const range = `${sheetName}!G7:H`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  return res.data.values || [];
}

async function sendDataToSheet(sheets, ranks, rowsCount, sheetId, sheetName, spreadsheetId) {
  const now = new Date()
    .toLocaleString("sv-SE", { hour12: false, timeZone: "Asia/Seoul" })
    .slice(2, 16)
    .replace("T", "");
  const values = [[now], ...ranks];
  const writeRange = `${sheetName}!I6:I${6 + rowsCount}`;

  // 열 삽입 + 서식 지정
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId,
              dimension: "COLUMNS",
              startIndex: 8,
              endIndex: 9,
            },
            inheritFromBefore: false,
          },
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 5,
              endRowIndex: 6,
              startColumnIndex: 8,
              endColumnIndex: 9,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 1, green: 0.949, blue: 0.8 },
                horizontalAlignment: "CENTER",
              },
            },
            fields:
              "userEnteredFormat.backgroundColor,userEnteredFormat.horizontalAlignment",
          },
        },
      ],
    },
  });

  // 값 업데이트
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: writeRange,
    valueInputOption: "RAW",
    requestBody: { values },
  });
}

//최신 쿠키 가져오기
async function fetchBrowserCookies() {
  let browser;
  try{
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.goto("https://ohou.se", { waitUntil: "networkidle2" });
    const cookies = await page.cookies();
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (e) {
    console.error("fetchBrowserCookies 실패:", e);
  } finally {
    if (browser) await browser.close();
  }
}

// feed.json 호출 & 순위 계산
async function getRanksViaFeedApi(keyword, mids, cookieHeader) {
  const rankMap = {};
  mids.forEach((mid) => (rankMap[mid] = ""));
  if (!keyword) return rankMap;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = {
      v: V,
      query: keyword,
      search_affect_type: SEARCH_AFFECT_TYPE,
      page,
      per: PER_PAGE,
    };
    let data;
    try {
      const res = await axios.get(FEED_API_URL, {
        params,
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent": "Mozilla/5.0",
          Referer: "https://ohou.se/",
          Origin: "https://ohou.se",
          Cookie: cookieHeader,
        },
      });
      data = res.data;
    } catch (e) {
      console.warn(`[${keyword}] page=${page} 호출 실패: ${e.message}`);
      break;
    }

    const prods = Array.isArray(data.productions)
      ? data.productions
      : data.result?.productions || [];

    if (!prods.length) break;

    prods.forEach((p, idx) => {
      const id = String(p.productionId || p.id || p.production?.id || "");
      if (id && id in rankMap && rankMap[id] === "") {
        rankMap[id] = String((page - 1) * PER_PAGE + idx + 1);
      }
    });

    if (mids.every((mid) => rankMap[mid] !== "")) break;
    await sleep(100);
  }

  // console.log(`[${keyword}] 결과:`, mids.map(m=>`${m}:${rankMap[m]||"-"}`).join(" , "));
  return rankMap;
}

// POST 요청 받는 엔드포인트
app.post("/ohouse_trigger", async (req, res) => {
  const { sheetId, sheetName, spreadsheetId } = req.body;
  if (!sheetId || !sheetName || !spreadsheetId) {
    return res.status(400).json({ error: "필수값 누락" });
  }

  let auth;
  try{
    // 구글 인증
    if (process.env.GOOGLE_KEY_JSON) {
      // 환경변수에 JSON이 있으면 credentials 옵션
      const keyObject = JSON.parse(process.env.GOOGLE_KEY_JSON);
      auth = new google.auth.GoogleAuth({
        credentials: keyObject,
        scopes: scopes,
      });
    } else {
      // 파일로 쓸 때만 keyFile 옵션
      auth = new google.auth.GoogleAuth({
        keyFile: path.join(__dirname, "package-google-key.json"),
        scopes: scopes,
      });
    }
    const sheets = google.sheets({ version: "v4", auth });
  
    // 구글 시트에서 데이터 가져오기
    const rows = await getRowsFromSheet(sheets, spreadsheetId, sheetName);
    if (!rows.length) {
      console.log("조회할 데이터가 없습니다.");
      return;
    }
  
    // 키워드별 그룹핑
    const groups = rows.reduce((acc, [kw, mid]) => {
      (acc[kw] = acc[kw] || []).push(mid);
      return acc;
    }, {});
  
    console.log("순위 조회 시작!");
  
    // 최신 쿠키 가져오기(한 번만)
    const cookieHeader = await fetchBrowserCookies();
  
    // feed.json 호출 & 순위 계산(병렬 처리)
    const limit = pLimit(MAX_CONCURRENCY);
    const tasks = Object.entries(groups).map(([kw, mids]) =>
      limit(() => getRanksViaFeedApi(kw, mids, cookieHeader))
    );
    const results = await Promise.all(tasks);
  
    // 결과 합치고 원본 순서대로 ranks 배열 생성
    const allMap = Object.assign({}, ...results);
    const ranks = rows.map(([_, mid]) => [allMap[mid] || ""]);
  
    // 구글 시트에 기록
    await sendDataToSheet(sheets, ranks, rows.length, sheetId,  sheetName,  spreadsheetId);
    console.log("순위 업데이트 완료!");
    return res.json({ status: "success" });
  } catch (e) {
    if (browser) await browser.close();
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

// 서버 실행
app.listen(PORT, () => {
  console.log(`서버가 실행중입니다. 포트: ${PORT}`);
});