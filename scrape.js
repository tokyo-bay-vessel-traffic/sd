// 東京湾 入出航予定 スクレイパー
// 海上保安庁 東京湾海上交通センター（東京MARTIS）の公開ページから
// 東航路・西航路の予定表を取得し、data.json にまとめて書き出す。
// 依存パッケージなし。Node.js 18 以上（標準の fetch を使用）。

const fs = require("fs");
const path = require("path");

const SOURCES = [
  { route: "東", url: "https://www6.kaiho.mlit.go.jp/tokyowan/schedule/TOKYOHIGASHI/schedule_1.html" },
  { route: "西", url: "https://www6.kaiho.mlit.go.jp/tokyowan/schedule/TOKYONISHI/schedule_1.html" },
];

// HTMLエンティティ・タグを除去してテキスト化
function clean(s) {
  return (s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/　/g, " ") // 全角スペース
    .replace(/\s+/g, " ")
    .trim();
}

// ページ本文から「最終更新 YYYY年M月D日 HH時MM分」を拾って "MM/DD HH:MM" に整形
function extractUpdated(html) {
  const m = html.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[^0-9]{0,6}(\d{1,2})\s*時\s*(\d{2})\s*分/);
  if (!m) return "";
  const [, , mo, d, h, mi] = m;
  return `${String(mo).padStart(2, "0")}/${String(d).padStart(2, "0")} ${String(h).padStart(2, "0")}:${mi}`;
}

function parseTable(html, route) {
  const table = html.match(/<table[^>]*generalTB[\s\S]*?<\/table>/i);
  if (!table) return [];
  const rows = [...table[0].matchAll(/<tr>([\s\S]*?)<\/tr>/gi)];
  const out = [];
  // 先頭行はヘッダーなので 1 から
  for (let i = 1; i < rows.length; i++) {
    const rawRow = rows[i][1];
    // 元サイトで取消・欠航・延期など明示的に無効化された行は除外（打消し線/取消文言）
    if (/text-decoration\s*:\s*line-through|<del\b|<s>|<strike/i.test(rawRow)) continue;
    const cells = [...rawRow.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => clean(c[1]));
    if (cells.length < 9) continue;
    if (/取消|取り消|中止|欠航|延期/.test(cells.join(" "))) continue;
    // 列: 0日時 1入出航 2バース 3船名 4長さ 5トン数 6喫水 7水先人 8船籍
    out.push({
      time: cells[0],
      dir: cells[1],
      berth: cells[2],
      ship: cells[3],
      length: cells[4],
      tons: cells[5],
      pilot: cells[7] === "有" ? "有" : "Ｘ",
      route,
    });
  }
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (TokyoBaySchedule/1.0)" },
    signal: AbortSignal.timeout(20000), // 20秒でタイムアウト（ハング防止）
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("utf-8");
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

// ===================== 気象・海象（現況パネル用） =====================
const LAT = 35.58, LON = 139.76; // 大井ふ頭付近
const pad2 = (n) => String(n).padStart(2, "0");
// GitHub Actions は UTC。JST の年月日時分を getUTC* で取り出せるようずらす
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const jymd = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

// 気象庁 府県予報 130000.json → 今日の天気・最高/最低気温・降水確率（東京地方 130010 / 東京 44132）
function buildWeather(fc) {
  const ymd = jymd(jstNow());
  const office = fc[0], week = fc[1];
  const ws = office.timeSeries[0];
  const wa = ws.areas.find((a) => a.area.code === "130010") || ws.areas[0];
  let wi = ws.timeDefines.findIndex((t) => t.slice(0, 10) === ymd);
  if (wi < 0) wi = 0;
  const text = (wa.weathers[wi] || "").replace(/[　\s]+/g, "");

  const ps = office.timeSeries[1];
  const pa = ps.areas.find((a) => a.area.code === "130010") || ps.areas[0];
  let pop = null;
  ps.timeDefines.forEach((t, i) => {
    if (t.slice(0, 10) === ymd) {
      const v = parseInt(pa.pops[i], 10);
      if (!isNaN(v)) pop = Math.max(pop == null ? 0 : pop, v);
    }
  });

  let max = null, min = null;
  const ts = week.timeSeries[1];
  const ta = ts.areas.find((a) => a.area.code === "44132") || ts.areas[0];
  const ti = ts.timeDefines.findIndex((t) => t.slice(0, 10) === ymd);
  if (ti >= 0) { max = ta.tempsMax[ti] || null; min = ta.tempsMin[ti] || null; }
  if (!max || !min) {
    // 当日は週間データが空のことがある → 短期予報の地点気温で補完
    const ss = office.timeSeries[2];
    const sa = ss && (ss.areas.find((a) => a.area.code === "44132") || ss.areas[0]);
    if (sa) {
      // まず当日の地点気温。無ければ短期予報にある気温（＝夜間は翌日分）を使う
      let vals = [];
      ss.timeDefines.forEach((t, i) => {
        if (t.slice(0, 10) === ymd) { const v = parseInt(sa.temps[i], 10); if (!isNaN(v)) vals.push(v); }
      });
      if (!vals.length) vals = sa.temps.map((v) => parseInt(v, 10)).filter((v) => !isNaN(v));
      if (vals.length) { if (!max) max = String(Math.max(...vals)); if (!min) min = String(Math.min(...vals)); }
    }
  }
  // 夕方以降は当日の最高/最低が配信されないため、直近（翌日）の予報値で補完
  if (!max) { const i = ta.tempsMax.findIndex((v) => v !== "" && v != null); if (i >= 0) max = ta.tempsMax[i]; }
  if (!min) { const i = ta.tempsMin.findIndex((v) => v !== "" && v != null); if (i >= 0) min = ta.tempsMin[i]; }
  return { text: text || "--", max: max || "--", min: min || "--", pop: pop == null ? "--" : String(pop) };
}

// 気象庁 潮位表（東京 TK）固定長テキスト → 今日の満潮・干潮（時刻・潮位cm）
function buildTide(txt) {
  const now = jstNow();
  const yy = pad2(now.getUTCFullYear() % 100), M = now.getUTCMonth() + 1, D = now.getUTCDate();
  const line = txt.split(/\r?\n/).find(
    (l) => l.length >= 136 && l.substr(72, 2) === yy && parseInt(l.substr(74, 2), 10) === M && parseInt(l.substr(76, 2), 10) === D
  );
  if (!line) return null;
  const decode = (block) => {
    const out = [];
    for (let k = 0; k < 4; k++) {
      const seg = block.substr(k * 7, 7);
      if (!seg || /^9+$/.test(seg.replace(/ /g, ""))) continue;
      const hh = parseInt(seg.substr(0, 2), 10);
      const mm = parseInt(seg.substr(2, 2).replace(/ /g, "0"), 10);
      const cm = parseInt(seg.substr(4, 3), 10);
      if (isNaN(hh) || isNaN(cm) || hh > 23) continue;
      out.push({ t: `${pad2(hh)}:${pad2(isNaN(mm) ? 0 : mm)}`, cm });
    }
    return out;
  };
  return { high: decode(line.substr(80, 28)), low: decode(line.substr(108, 28)) };
}

// 東京湾海上交通センターの観測ページ → 最新の風向・風速
async function fetchWind(url) {
  const html = await fetchText(url);
  const tbl = (html.match(/<table[\s\S]*?<\/table>/i) || [""])[0];
  const rows = [...tbl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const r of rows) {
    const tds = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => clean(c[1]));
    if (tds.length >= 4) {
      const spd = (tds[3].match(/\d+(?:\.\d+)?/) || [""])[0];
      if (spd === "") continue;
      return { t: tds[1], dir: tds[2], spd };
    }
  }
  return null;
}

// 日の出・日の入（NOAA sunrise equation）
function sunTimes(lat, lon, now) {
  const Y = now.getUTCFullYear(), M = now.getUTCMonth() + 1, D = now.getUTCDate();
  const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
  const a = Math.floor((14 - M) / 12), y = Y + 4800 - a, m = M + 12 * a - 3;
  const JDN = D + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  const n = JDN - 2451545.0 + 0.0008;
  const Jstar = n - lon / 360;
  let Mdeg = (357.5291 + 0.98560028 * Jstar) % 360; if (Mdeg < 0) Mdeg += 360;
  const Mr = rad(Mdeg);
  const C = 1.9148 * Math.sin(Mr) + 0.02 * Math.sin(2 * Mr) + 0.0003 * Math.sin(3 * Mr);
  let lam = (Mdeg + C + 180 + 102.9372) % 360; if (lam < 0) lam += 360;
  const lr = rad(lam);
  const Jtr = 2451545.0 + Jstar + 0.0053 * Math.sin(Mr) - 0.0069 * Math.sin(2 * lr);
  const dec = Math.asin(Math.sin(lr) * Math.sin(rad(23.44)));
  const latR = rad(lat);
  const cosH = (Math.sin(rad(-0.833)) - Math.sin(latR) * Math.sin(dec)) / (Math.cos(latR) * Math.cos(dec));
  if (cosH < -1 || cosH > 1) return { rise: "--:--", set: "--:--" };
  const H = deg(Math.acos(cosH));
  const toLocal = (jd) => {
    const frac = jd + 0.5 - Math.floor(jd + 0.5);
    let s = Math.round(frac * 86400) + 9 * 3600; s = ((s % 86400) + 86400) % 86400;
    return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}`;
  };
  return { rise: toLocal(Jtr - H / 360), set: toLocal(Jtr + H / 360) };
}

// 潮名（大潮・中潮・小潮・長潮・若潮）を月齢から近似（旧暦日ベース）
function tideName(now) {
  const Y = now.getUTCFullYear(), M = now.getUTCMonth() + 1, D = now.getUTCDate();
  const a = Math.floor((14 - M) / 12), y = Y + 4800 - a, m = M + 12 * a - 3;
  const JDN = D + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  const JD = JDN - 0.5 + 3 / 24; // 12:00 JST 相当
  let age = (JD - 2451550.1) % 29.530588853; // 2000-01-06 新月基準
  if (age < 0) age += 29.530588853;
  const names = ["大潮","大潮","中潮","中潮","中潮","中潮","小潮","小潮","小潮","長潮","若潮","中潮","中潮","中潮","大潮","大潮","大潮","中潮","中潮","中潮","中潮","小潮","小潮","小潮","長潮","若潮","中潮","中潮","大潮","大潮"];
  return names[Math.floor(age) % 30];
}

async function buildEnv() {
  const [fc, tideTxt] = await Promise.all([
    fetchJson("https://www.jma.go.jp/bosai/forecast/data/forecast/130000.json"),
    fetchText(`https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/${jstNow().getUTCFullYear()}/TK.txt`),
  ]);
  const [jugo, umi] = await Promise.all([
    fetchWind("https://www6.kaiho.mlit.go.jp/tokyowan/kisyou/10gochi_vtss.html").catch(() => null),
    fetchWind("https://www6.kaiho.mlit.go.jp/tokyowan/kisyou/umihotaru_radar.html").catch(() => null),
  ]);
  const tide = buildTide(tideTxt) || { high: [], low: [] };
  tide.name = tideName(jstNow());
  return {
    place: "品川・大井・青海ふ頭周辺",
    weather: buildWeather(fc),
    sun: sunTimes(LAT, LON, jstNow()),
    tide,
    wind: { jugouchi: jugo, umihotaru: umi },
    radar: "https://weathernews.jp/onebox/radar/tokyo/13103/",
  };
}

// ===================== 東京港港湾情報システム（着離岸予定） =====================
// ふ頭=航路 / 希望バース=バース / 着岸=入航 / 離岸=出航 / 総トン数=トン数
// 当日の日付で検索し、当日のイベントのみ抽出。長さ・水先人は無いので "-"。
// 全角英数→半角、空白除去、大文字化（東/西と港湾で同一船を突き合わせるため）
// 数字の表記ゆれを吸収して同一船を突き合わせる（例：7＝Ⅶ＝七、12＝Ⅻ＝十二）
const ROMAN_NUM = {
  "Ⅰ":"1","Ⅱ":"2","Ⅲ":"3","Ⅳ":"4","Ⅴ":"5","Ⅵ":"6","Ⅶ":"7","Ⅷ":"8","Ⅸ":"9","Ⅹ":"10","Ⅺ":"11","Ⅻ":"12",
  "ⅰ":"1","ⅱ":"2","ⅲ":"3","ⅳ":"4","ⅴ":"5","ⅵ":"6","ⅶ":"7","ⅷ":"8","ⅸ":"9","ⅹ":"10","ⅺ":"11","ⅻ":"12",
};
const KANJI_DIG = { "〇":0,"零":0,"一":1,"二":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9 };
function kanjiNumToArabic(run) {
  let total = 0, cur = 0;
  for (const ch of run) {
    if (ch in KANJI_DIG) cur = cur * 10 + KANJI_DIG[ch];
    else if (ch === "十") { total += (cur || 1) * 10; cur = 0; }
  }
  return String(total + cur);
}
// アルファベットのローマ数字（VII 等・単独の語のみ）を算用数字へ
function asciiRomanToArabic(tok) {
  const val = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0, prev = 0;
  for (let i = tok.length - 1; i >= 0; i--) {
    const v = val[tok[i]];
    if (v < prev) total -= v; else { total += v; prev = v; }
  }
  return String(total);
}
const canonNum = (s) =>
  (s || "")
    .replace(/[Ⅰ-ⅿ]/g, (c) => ROMAN_NUM[c] || c)             // Unicodeローマ数字→算用数字（Ⅶ→7）
    .replace(/\b[IVXLCDM]+\b/g, (m) => asciiRomanToArabic(m))  // アルファベットのローマ数字→算用数字（VII→7）
    .replace(/[〇零一二三四五六七八九十]+/g, kanjiNumToArabic); // 漢数字→算用数字（七→7、十二→12）
const shipKey = (s) =>
  canonNum(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, "")
    .toUpperCase();

async function fetchPortRows() {
  const base = "https://www.kouwan2.metro.tokyo.jp/app/";
  const jar = {};
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  const store = (res) => {
    const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie()
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
    sc.forEach((c) => { const kv = c.split(";")[0]; const i = kv.indexOf("="); if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); });
  };
  const dec = (buf) => new TextDecoder("shift_jis").decode(buf);
  const UA = { "User-Agent": "Mozilla/5.0 (TokyoBaySchedule/1.0)" };

  const TO = () => AbortSignal.timeout(20000);
  let res = await fetch(base + "keisen", { headers: { ...UA, Cookie: cookieHeader() }, signal: TO() });
  store(res); await res.arrayBuffer();
  res = await fetch(base + "keisen_search", {
    method: "POST", headers: { ...UA, Cookie: cookieHeader(), "Content-Type": "application/x-www-form-urlencoded" },
    body: "KeiCd=1&FuKbn=all", signal: TO(),
  });
  store(res);
  const searchHtml = dec(Buffer.from(await res.arrayBuffer()));
  const params = new URLSearchParams();
  for (const m of searchHtml.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/gi)) params.set(m[1], m[2]);
  const now = jstNow();
  const tomo = new Date(now.getTime() + 86400000);
  const y1 = String(now.getUTCFullYear()), m1 = pad2(now.getUTCMonth() + 1), d1 = pad2(now.getUTCDate());
  const y2 = String(tomo.getUTCFullYear()), m2 = pad2(tomo.getUTCMonth() + 1), d2 = pad2(tomo.getUTCDate());
  params.set("Sty", y1); params.set("Stm", m1); params.set("Std", d1);      // 当日
  params.set("Ety", y2); params.set("Etm", m2); params.set("Etd", d2);      // 翌日
  params.set("KeiCd", "1"); params.set("FuKbn", "all");
  res = await fetch(base + "keisen_result", {
    method: "POST", headers: { ...UA, Cookie: cookieHeader(), "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(), signal: TO(),
  });
  store(res);
  const html = dec(Buffer.from(await res.arrayBuffer()));

  const today = `${m1}/${d1}`, tomorrow = `${m2}/${d2}`;
  const onDay = (s) => s.startsWith(today) || s.startsWith(tomorrow);
  const table = (html.match(/<table[^>]*>[\s\S]*?<\/table>/i) || [""])[0];
  const trs = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const out = [];
  for (const tr of trs) {
    const c = [...tr[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((x) => clean(x[1]));
    if (c.length < 7 || c[0] === "ふ頭") continue;
    const fu = c[0], berth = c[1], arr = c[2], dep = c[3], ship = c[4], kind = c[5] || "";
    // 表示対象外の船種（客船／その他の船舶）※はしけ船（CFT）・貨客船 等は表示する
    const knorm = kind.replace(/（/g, "(").replace(/）/g, ")");
    if (knorm === "客船" || knorm === "その他の船舶") continue;
    const tons = (c[6] || "").replace(/,/g, "").replace(/\.\d+$/, "");
    const rowBase = { berth, ship, length: "-", tons, pilot: "-", route: fu, port: true };
    if (onDay(arr)) out.push({ time: arr, dir: "入航", ...rowBase });
    if (onDay(dep)) out.push({ time: dep, dir: "出航", ...rowBase });
  }
  return out;
}

(async () => {
  const rows = [];
  let updated = "";
  for (const src of SOURCES) {
    const html = await fetchText(src.url);
    if (!updated) updated = extractUpdated(html);
    const parsed = parseTable(html, src.route);
    if (parsed.length === 0) {
      console.error(`警告: ${src.route}航路のデータが0件でした（ページ構造の変更の可能性）`);
    }
    rows.push(...parsed);
    console.log(`${src.route}航路: ${parsed.length}件`);
  }

  if (rows.length === 0) {
    console.error("全航路で0件のため data.json は更新しません（既存データを保持）");
    process.exit(1);
  }

  // 東京港港湾情報システム（失敗しても予定表は出力する）
  try {
    const portRows = await fetchPortRows();
    const kaihoShips = new Set(rows.map((r) => shipKey(r.ship)));
    const merged = portRows.filter((r) => !kaihoShips.has(shipKey(r.ship))); // 東/西を優先
    rows.push(...merged);
    console.log(`港湾システム: ${portRows.length}件取得 → 重複除外後 ${merged.length}件を追加`);
  } catch (e) {
    console.error("港湾システムの取得に失敗:", e.message);
  }

  // 気象・海象（失敗しても予定表は出力する）
  let env = null;
  try {
    env = await buildEnv();
    console.log("気象・海象を取得しました");
  } catch (e) {
    console.error("気象・海象の取得に失敗:", e.message);
  }

  const payload = { updated: updated || "", fetchedAt: new Date().toISOString(), env, rows };
  const outPath = path.join(__dirname, "data.json");
  fs.writeFileSync(outPath, JSON.stringify(payload), "utf-8");
  console.log(`data.json を書き出しました（合計 ${rows.length}件, 最終更新 ${updated || "不明"}）`);
})();
