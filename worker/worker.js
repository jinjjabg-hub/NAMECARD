/* ─────────────────────────────────────────────────────────────
 * dica-editor — DiCA 비즈홈 셀프 수정 서버 (Cloudflare Worker)
 *
 * 배포: Cloudflare 대시보드 → Workers & Pages → dica-editor → Edit code
 *       → 이 파일 내용 전체를 붙여넣고 Deploy.
 *
 * 필요한 설정 (Settings → Variables, 이미 있는 것 그대로 사용)
 *   GITHUB_TOKEN        (Secret)  레포 쓰기 토큰
 *   ANTHROPIC_API_KEY   (Secret)  번역용
 *   ADMIN_KEY           (Secret)  /admin/* 호출용
 *   FIREBASE_PROJECT_ID (Text)    mandu-e7c3c
 *   DICA_OWNERS         (KV 바인딩) "레포/폴더" → 주인 이메일
 *   ADMIN_EMAILS        (Text, 선택) 관리자 이메일, 쉼표로 여러 개. 없으면 jinjjabg@gmail.com
 *
 * 규칙 (카드 쪽 dica-edit.js 와 짝)
 *   - 카드 주인(또는 관리자)만 저장 가능
 *   - 주인은 한 달(한국시간 달력)에 1번 저장. 관리자는 제한 없음
 *   - 저장 직전 원본 문구가 바뀌었으면 거절 (다른 칸 덮어쓰기 방지)
 *   - 허용 태그 외 HTML 은 글자로 바꿔 저장
 *   - 번역은 <br> 줄 단위로 맞춰서 받는다 (줄 누락 방지)
 *
 * 내 소식판 올리기 (프리미엄 전용, 횟수 제한 없음)
 *   - KV DICA_OWNERS 에 "premium:레포/폴더" = "1" 이 있는 카드만 허용 (관리자: /admin/premium)
 *   - POST /news/draft  설명 초안(AI)   POST /news/post  번역 후 폴더/news.json + 폴더/news/이미지 커밋
 *   - POST /news/list   올린 소식 목록   POST /news/manage  숨기기·보이기·삭제 (삭제는 고객이 올린 글만)
 * ───────────────────────────────────────────────────────────── */

const OWNER = "jinjjabg-hub";
const ALLOWED_REPOS = ["NAMECARD", "BNI-PIONEER-cards", "bni-giants"];
const COMMIT_PREFIX = "내 명함 관리";
const EDIT_SCRIPT_SRC = "https://jinjjabg-hub.github.io/NAMECARD/dica-edit.js";
const TRANSLATE_MODEL = "claude-haiku-4-5";
// 배포 확인용 — 브라우저에서 https://dica-editor.jinjjabg.workers.dev/health 를 열면 이 값이 보인다
const WORKER_VERSION = "2026-10-03 셀프수정 v3 + 소식 올리기 v2 (목록·숨기기·삭제)";

/* ── HTTP 공통 ───────────────────────────────────── */
function cors(res) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Key");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return res;
}
function json(obj, status = 200) {
  return cors(new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } }));
}
class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

/* ── 로그인 토큰 검증 (Firebase ID 토큰) ─────────── */
function b64urlToText(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function b64urlToBuffer(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
}
async function verifyFirebaseToken(idToken, projectId) {
  const [headerB64, payloadB64, sigB64] = (idToken || "").split(".");
  if (!headerB64 || !payloadB64 || !sigB64) throw new HttpError(401, "토큰 형식 오류");
  const header = JSON.parse(b64urlToText(headerB64));
  const payload = JSON.parse(b64urlToText(payloadB64));
  if (payload.aud !== projectId) throw new HttpError(401, "프로젝트 불일치");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new HttpError(401, "발급자 불일치");
  if (payload.exp * 1e3 < Date.now()) throw new HttpError(401, "로그인이 만료됐어요. 다시 로그인해주세요.");
  const jwks = await (await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")).json();
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, "서명 키를 찾을 수 없음");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBuffer(sigB64), new TextEncoder().encode(`${headerB64}.${payloadB64}`));
  if (!ok) throw new HttpError(401, "서명 검증 실패");
  if (!payload.email_verified) throw new HttpError(401, "이메일 미인증 계정");
  return payload.email.toLowerCase();
}

/* ── 권한 ────────────────────────────────────────── */
function adminEmails(env) {
  return (env.ADMIN_EMAILS || "jinjjabg@gmail.com").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function checkTarget(repo, slug) {
  // 토큰이 레포 쓰기 권한을 가지고 있으므로, 비즈홈 레포/폴더 밖으로는 절대 못 나가게 막는다
  if (!ALLOWED_REPOS.includes(repo)) throw new HttpError(400, "허용되지 않은 레포");
  if (!slug || /[\/\\]|\.\./.test(slug)) throw new HttpError(400, "잘못된 비즈홈 이름");
}
async function authorize(env, req, repo, slug) {
  checkTarget(repo, slug);
  const email = await verifyFirebaseToken((req.headers.get("Authorization") || "").replace(/^Bearer /, ""), env.FIREBASE_PROJECT_ID);
  const isAdmin = adminEmails(env).includes(email);
  const owner = await env.DICA_OWNERS.get(`${repo}/${slug}`);
  if (isAdmin) return { email, isAdmin, owner };
  if (!owner) throw new HttpError(403, "이 비즈홈에 등록된 계정이 없습니다.", "not-registered");
  if (owner.toLowerCase() !== email) throw new HttpError(403, "본인 비즈홈이 아닙니다.", "mismatch");
  return { email, isAdmin, owner };
}

/* ── GitHub ──────────────────────────────────────── */
const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");
function ghHeaders(env) {
  return { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "dica-editor-worker", Accept: "application/vnd.github+json" };
}
async function githubGetFile(env, repo, path) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${repo}/contents/${encodePath(path)}`, { headers: ghHeaders(env) });
  if (!res.ok) throw new HttpError(502, `GitHub 조회 실패 (${res.status})`, res.status === 404 ? "notfound" : undefined);
  const data = await res.json();
  const bin = atob(data.content.replace(/\n/g, ""));
  return { content: new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))), sha: data.sha };
}
async function githubPutFile(env, repo, path, content, sha, message) {
  const bytes = new TextEncoder().encode(content);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${repo}/contents/${encodePath(path)}`, {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify({ message, content: btoa(bin), sha }),
  });
  if (res.status === 409) throw new HttpError(409, "그 사이 비즈홈이 업데이트됐어요. 다시 열어 수정해주세요.", "stale");
  if (!res.ok) throw new HttpError(502, `GitHub 저장 실패 (${res.status}) ${(await res.text()).slice(0, 200)}`);
}

// 이미 base64 인 파일(이미지) 새로 올리기
async function githubPutBase64(env, repo, path, b64, message) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${repo}/contents/${encodePath(path)}`, {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify({ message, content: b64 }),
  });
  if (!res.ok) throw new HttpError(502, `이미지 저장 실패 (${res.status}) ${(await res.text()).slice(0, 200)}`);
}

async function githubDeleteFile(env, repo, path, message) {
  const { sha } = await githubGetFile(env, repo, path);
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${repo}/contents/${encodePath(path)}`, {
    method: "DELETE",
    headers: ghHeaders(env),
    body: JSON.stringify({ message, sha }),
  });
  if (!res.ok) throw new HttpError(502, `파일 삭제 실패 (${res.status})`);
}

/* ── 월 1회 제한 (한국시간 달력 기준) ─────────────── */
function kstMonthStartIso() {
  const now = new Date(Date.now() + 9 * 3600e3);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 9 * 3600e3).toISOString();
}
function nextMonthLabel() {
  const now = new Date(Date.now() + 9 * 3600e3);
  return `${((now.getUTCMonth() + 1) % 12) + 1}월 1일`;
}
// 이번 달 주인이 직접 한 셀프 수정 커밋이 있는지 (관리자가 대신 고친 건 세지 않음)
async function usedThisMonth(env, repo, slug) {
  const url = `https://api.github.com/repos/${OWNER}/${repo}/commits?path=${encodeURIComponent(`${slug}/index.html`)}&since=${encodeURIComponent(kstMonthStartIso())}&per_page=100`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (!res.ok) throw new HttpError(502, `수정 이력 확인 실패 (${res.status})`);
  const admins = adminEmails(env);
  return (await res.json()).some((c) => {
    const msg = (c.commit && c.commit.message) || "";
    return msg.startsWith(COMMIT_PREFIX) && msg.includes("문구 수정") && !admins.some((a) => msg.includes(`(${a})`));
  });
}

/* ── 문구 묶음 (카드 dica-edit.js 와 완전히 같은 규칙) ── */
const SPAN = /<span data-lang="([a-z]{2})"( class="active")?>([\s\S]*?)<\/span>/g;
const GROUP = new RegExp(`(?:${SPAN.source}\\s*)+`, "g");
function extractGroups(html) {
  const groups = {};
  let n = 0;
  html.replace(GROUP, (block) => {
    const spans = [...block.matchAll(SPAN)];
    if (spans.length < 2) return block;
    n++;
    const langs = {};
    spans.forEach((s) => { langs[s[1]] = s[3]; });
    groups["T" + String(n).padStart(3, "0")] = langs;
    return block;
  });
  return groups;
}
function applyChanges(html, changes) {
  let n = 0;
  return html.replace(GROUP, (block) => {
    const spans = [...block.matchAll(SPAN)];
    if (spans.length < 2) return block;
    n++;
    const patch = changes["T" + String(n).padStart(3, "0")];
    if (!patch) return block;
    const parts = block.split(SPAN);
    let out = parts[0];
    for (let i = 0; i < spans.length; i++) {
      const lang = spans[i][1];
      const active = spans[i][2] ? ' class="active"' : "";
      const text = patch[lang] !== undefined ? patch[lang] : spans[i][3];
      out += `<span data-lang="${lang}"${active}>${text}</span>` + parts[4 * i + 4];
    }
    return out;
  });
}

/* ── HTML 정리: 허용 태그 + 원래 문구에 있던 태그만 통과 ── */
const BASIC_TAG = /^<\/?(strong|b|em)>$|^<br\s*\/?>$/i;
function sanitize(text, original) {
  return String(text).replace(/\r/g, "").replace(/<[^>]*>|</g, (t) => {
    if (BASIC_TAG.test(t) || (t.length > 1 && original.includes(t))) return t;
    return t.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }).replace(/\n/g, "<br>");
}
const BR = /\s*<br\s*\/?>\s*/i;
const splitLines = (s) => s.split(BR);

/* ── 번역 (Claude, 구조화 출력) ──────────────────── */
const LANG_NAMES = {
  en: "English", jp: "Japanese", cn: "Chinese (Simplified)", mn: "Mongolian", vi: "Vietnamese",
  ur: "Urdu", si: "Sinhala", th: "Thai", id: "Indonesian", ru: "Russian", hi: "Hindi",
};

// items: [[줄1, 줄2, ...], ...] → 같은 모양의 번역 배열
async function translateLines(env, items, langName, kind = "business-card") {
  const schema = {
    type: "object",
    properties: { translations: { type: "array", items: { type: "array", items: { type: "string" } } } },
    required: ["translations"],
    additionalProperties: false,
  };
  const prompt =
    `Translate the Korean ${kind} text below into ${langName}.\n` +
    `The input is a JSON array of items; each item is an array of lines. Return the same shape: ` +
    `exactly ${items.length} items, and each item must have exactly as many lines as the input item — ` +
    `never merge, drop, or add lines. Keep numbers, license codes, and proper nouns (company and product names) as they are. ` +
    `Keep any inline HTML tags such as <strong>…</strong> or <em class="acc">…</em> unchanged around the translated words. ` +
    `Keep it short and natural, as on a business card.\n\n` +
    JSON.stringify(items);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: TRANSLATE_MODEL,
      max_tokens: 8000,
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error ? `${data.error.type}: ${data.error.message}` : `HTTP ${res.status}`);
  if (data.stop_reason !== "end_turn") throw new Error(`번역 중단 (${data.stop_reason})`);
  const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const out = JSON.parse(text).translations;
  // 줄 수가 하나라도 다르면 실패로 본다 → 호출한 쪽에서 재시도
  const bad = items.findIndex((lines, i) => !Array.isArray(out[i]) || out[i].length !== lines.length);
  if (out.length !== items.length || bad >= 0) throw new Error(`줄 수 불일치 (항목 ${bad + 1})`);
  return out;
}

async function translateChanges(env, changes, current) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(500, "번역 키(ANTHROPIC_API_KEY)가 설정되지 않았어요.");
  const byLang = {};
  for (const [key, patch] of Object.entries(changes)) {
    for (const lang of Object.keys(current[key])) {
      if (lang !== "kr") (byLang[lang] ||= []).push(key);
    }
  }
  for (const [lang, keys] of Object.entries(byLang)) {
    const items = keys.map((k) => splitLines(changes[k].kr));
    let result, lastErr;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try { result = await translateLines(env, items, LANG_NAMES[lang] || lang); } catch (e) { lastErr = e; }
    }
    // 번역이 불완전하면 저장 자체를 하지 않는다 (수정 기회도 차감되지 않음)
    if (!result) throw new HttpError(502, `${LANG_NAMES[lang] || lang} 번역 실패: ${lastErr.message}. 잠시 후 다시 저장해주세요.`);
    keys.forEach((k, i) => {
      changes[k][lang] = result[i].map((line) => sanitize(line, current[k][lang] || "")).join("<br>");
    });
  }
}

/* ── 저장 ────────────────────────────────────────── */
async function handleSave(env, req) {
  const body = await req.json();
  const { repo, slug } = body;
  const { email, isAdmin } = await authorize(env, req, repo, slug);

  if (!isAdmin && (await usedThisMonth(env, repo, slug))) {
    throw new HttpError(429, `이번 달 수정은 이미 사용하셨어요. ${nextMonthLabel()}부터 다시 수정할 수 있어요.`, "monthly-limit");
  }

  const path = `${slug}/index.html`;
  const { content, sha } = await githubGetFile(env, repo, path);
  const current = extractGroups(content);

  // 받은 값에서 필요한 것만 골라 새로 만든다 (번역문을 클라이언트가 직접 넣는 것은 허용하지 않음)
  const changes = {};
  for (const [key, patch] of Object.entries(body.changes || {})) {
    const cur = current[key];
    if (!cur || cur.kr === undefined) throw new HttpError(409, "비즈홈 구조가 바뀌었어요. 다시 열어 수정해주세요.", "stale");
    if (typeof patch._base === "string" && patch._base !== cur.kr) {
      throw new HttpError(409, "그 사이 비즈홈이 업데이트됐어요. 다시 열어 수정해주세요.", "stale");
    }
    const kr = sanitize(String(patch.kr || ""), cur.kr);
    if (!kr.replace(/<[^>]*>/g, "").trim()) throw new HttpError(400, "빈 칸으로는 저장할 수 없어요.");
    if (kr.length > 2000) throw new HttpError(400, "문구가 너무 길어요.");
    if (kr !== cur.kr) changes[key] = { kr };
  }
  if (!Object.keys(changes).length) throw new HttpError(400, "바뀐 내용이 없습니다.");
  if (Object.keys(changes).length > 80) throw new HttpError(400, "한 번에 고칠 수 있는 항목 수를 넘었어요.");

  await translateChanges(env, changes, current);
  const updated = applyChanges(content, changes);
  await githubPutFile(env, repo, path, updated, sha, `${COMMIT_PREFIX}: ${slug} 문구 수정 (${email})`);
  // 저장된 전체 언어 문구를 돌려줘서, 카드 화면이 새로고침 없이 바로 보여줄 수 있게 한다
  return json({ ok: true, count: Object.keys(changes).length, admin: isAdmin, changes });
}

/* ── 내 소식판 올리기 ───────────────────────────── */
const NEWS_LANGS = ["en", "jp", "cn", "hi"]; // 소식판(news-board.js)이 지원하는 언어. kr 은 원문
const NEWS_TYPES = ["product", "event", "case", "news"];
const NEWS_MAX_ITEMS = 200;
const NEWS_MAX_IMAGE_BYTES = 1.5 * 1024 * 1024; // 클라이언트가 1200px 로 줄여 보내므로 보통 100KB 안팎

async function isPremium(env, repo, slug) {
  return (await env.DICA_OWNERS.get(`premium:${repo}/${slug}`)) === "1";
}
async function authorizePremium(env, req, repo, slug) {
  const auth = await authorize(env, req, repo, slug);
  if (!(await isPremium(env, repo, slug))) {
    throw new HttpError(403, "내 소식판 올리기는 프리미엄 전용 기능이에요.", "not-premium");
  }
  return auth;
}

const todayKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

function cleanText(v, max, label, required) {
  const t = String(v == null ? "" : v).replace(/\r/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  if (required && !t) throw new HttpError(400, `${label}을(를) 입력해주세요.`);
  if (t.length > max) throw new HttpError(400, `${label}이(가) 너무 길어요. (${max}자 이내)`);
  return t;
}
function cleanUrl(v, label) {
  const t = String(v || "").trim();
  if (!t) return "";
  let u;
  try { u = new URL(t); } catch (e) { throw new HttpError(400, `${label} 주소 형식이 올바르지 않아요.`); }
  if (!/^https?:$/.test(u.protocol) || t.length > 300) throw new HttpError(400, `${label}은(는) http(s):// 로 시작하는 주소만 쓸 수 있어요.`);
  return u.href;
}
function youtubeUrl(v) {
  const t = String(v || "").trim();
  if (!t) return "";
  const m = t.match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/);
  if (!m) throw new HttpError(400, "유튜브 링크 형식이 올바르지 않아요.");
  return `https://youtu.be/${m[1]}`;
}

// 'data:image/webp;base64,...' → { ext, b64 }  (파일 앞부분 서명까지 확인해 이미지가 아닌 파일은 막는다)
function parseImage(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw new HttpError(400, "사진은 JPG·PNG·WEBP 만 올릴 수 있어요.");
  const b64 = m[2];
  if (b64.length * 0.75 > NEWS_MAX_IMAGE_BYTES) throw new HttpError(400, "사진 용량이 너무 커요. 더 작은 사진을 골라주세요.");
  const head = atob(b64.slice(0, 24));
  const ok = m[1] === "webp" ? head.startsWith("RIFF") && head.slice(8, 12) === "WEBP"
    : m[1] === "png" ? head.startsWith("\x89PNG")
    : head.startsWith("\xff\xd8\xff");
  if (!ok) throw new HttpError(400, "올바른 사진 파일이 아니에요.");
  return { ext: m[1] === "jpeg" ? "jpg" : m[1], b64 };
}

async function callClaudeText(env, prompt, maxTokens) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(500, "AI 키(ANTHROPIC_API_KEY)가 설정되지 않았어요.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: TRANSLATE_MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new HttpError(502, `AI 호출 실패: ${data.error ? data.error.message : res.status}`);
  return data.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

// 제목·메모로 설명 초안을 만든다. 사실을 지어내지 않도록 입력에 없는 가격·날짜·수치는 쓰지 않게 한다.
async function handleNewsDraft(env, req) {
  const body = await req.json();
  await authorizePremium(env, req, body.repo, body.slug);
  const title = cleanText(body.title, 80, "제목", true);
  const memo = cleanText(body.memo, 600, "메모", false);
  const typeLabel = { product: "상품 소개", event: "이벤트", case: "고객 사례", news: "소식" }[body.type] || "소식";
  const text = await callClaudeText(env,
    `당신은 소상공인·영업인의 디지털 비즈홈에 올라가는 "${typeLabel}" 글을 돕는 카피라이터입니다.\n` +
    `아래 제목과 메모만 근거로 한국어 설명 초안을 2~3문장(200자 안팎)으로 쓰세요.\n` +
    `규칙: 메모에 없는 가격·날짜·수치·효과를 지어내지 말 것. 과장 광고 문구, 이모지, 따옴표, 머리말 없이 본문만 출력. ` +
    `읽는 사람이 "그래서 나에게 무슨 도움이 되는지"가 보이게 쓸 것.\n\n` +
    `제목: ${title}\n메모: ${memo || "(없음)"}`, 600);
  return json({ ok: true, draft: text.replace(/^["“]|["”]$/g, "") });
}

async function translateNews(env, fields) {
  // fields: { title, desc, price, labels:[...] }  → 언어별로 같은 모양의 번역
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(500, "번역 키(ANTHROPIC_API_KEY)가 설정되지 않았어요.");
  const items = [[fields.title], fields.desc.split("\n")];
  if (fields.price) items.push([fields.price]);
  fields.labels.forEach((l) => items.push([l]));
  const out = {};
  for (const lang of NEWS_LANGS) {
    let result, lastErr;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try { result = await translateLines(env, items, LANG_NAMES[lang], "news-post"); } catch (e) { lastErr = e; }
    }
    if (!result) throw new HttpError(502, `${LANG_NAMES[lang]} 번역 실패: ${lastErr.message}. 잠시 후 다시 올려주세요.`);
    out[lang] = result;
  }
  return out;
}

async function handleNewsPost(env, req) {
  const body = await req.json();
  const { repo, slug } = body;
  const { email } = await authorizePremium(env, req, repo, slug);

  const type = NEWS_TYPES.includes(body.type) ? body.type : "news";
  const title = cleanText(body.title, 80, "제목", true);
  const desc = cleanText(body.desc, 1200, "설명", false);
  const price = cleanText(body.price, 60, "가격", false);
  const video = youtubeUrl(body.video);
  const image = parseImage(body.image);
  const links = (Array.isArray(body.links) ? body.links : []).slice(0, 3).map((l, i) => ({
    url: cleanUrl(l && l.url, `링크 ${i + 1}`),
    label: cleanText(l && l.label, 40, `링크 ${i + 1} 이름`, false),
  })).filter((l) => l.url);
  let until = String(body.until || "").trim();
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new HttpError(400, "노출 기간 날짜 형식이 올바르지 않아요.");
  if (until && until < todayKst()) throw new HttpError(400, "노출 기간이 이미 지난 날짜예요.");
  if (!desc && !image && !video) throw new HttpError(400, "사진, 설명, 유튜브 중 하나는 있어야 해요.");

  // 번역을 먼저 끝낸다 → 실패하면 아무것도 저장하지 않음
  const labelsToTranslate = links.filter((l) => l.label).map((l) => l.label);
  const tr = await translateNews(env, { title, desc: desc || title, price, labels: labelsToTranslate });
  const ml = (kr, pick) => {
    const o = { kr };
    NEWS_LANGS.forEach((lang) => { o[lang] = pick(tr[lang]); });
    return o;
  };
  const hasDesc = !!desc, hasPrice = !!price;
  const item = {
    id: "n" + Date.now().toString(36),
    type,
    date: todayKst(),
    title: ml(title, (t) => t[0][0]),
    owner_post: true,
  };
  if (hasDesc) item.desc = ml(desc, (t) => t[1].join("\n"));
  if (hasPrice) item.price = ml(price, (t) => t[2][0]);
  if (video) item.video = video;
  if (until) item.until = until;
  let li = 0;
  const labelBase = 2 + (hasPrice ? 1 : 0);
  item.links = links.map((l) => {
    const label = l.label
      ? ml(l.label, (t) => t[labelBase + li][0])
      : (() => { try { return new URL(l.url).hostname.replace(/^www\./, ""); } catch (e) { return l.url; } })();
    if (l.label) li++;
    return { url: l.url, label };
  });
  if (!item.links.length) delete item.links;

  const msg = `${COMMIT_PREFIX}: ${slug} 소식 올리기 (${email})`;
  if (image) {
    const rel = `news/${item.id}.${image.ext}`;
    await githubPutBase64(env, repo, `${slug}/${rel}`, image.b64, msg);
    item.images = [rel];
  }

  // news.json 갱신 — 그 사이 다른 커밋이 있으면 (409) 다시 읽어 최대 3번 재시도
  const path = `${slug}/news.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let data, sha;
    try {
      const f = await githubGetFile(env, repo, path);
      data = JSON.parse(f.content);
      sha = f.sha;
    } catch (e) {
      if (e.code !== "notfound") throw e;
      data = { version: 1, maxVisible: 10, items: [] };
    }
    if (!Array.isArray(data.items)) data.items = [];
    if (data.items.length >= NEWS_MAX_ITEMS) throw new HttpError(400, "소식이 너무 많이 쌓였어요. 관리자에게 정리를 요청해주세요.");
    data.items.unshift(item);
    try {
      await githubPutFile(env, repo, path, JSON.stringify(data, null, 2) + "\n", sha, msg);
      return json({ ok: true, id: item.id });
    } catch (e) {
      if (e.code !== "stale" || attempt === 2) throw e;
    }
  }
}

// 올린 소식 목록 (숨긴 것 포함)
async function handleNewsList(env, req) {
  const body = await req.json();
  const { isAdmin } = await authorizePremium(env, req, body.repo, body.slug);
  let data;
  try { data = JSON.parse((await githubGetFile(env, body.repo, `${body.slug}/news.json`)).content); }
  catch (e) { if (e.code !== "notfound") throw e; data = { items: [] }; }
  const today = todayKst();
  const items = (data.items || []).map((it) => ({
    id: it.id, type: it.type, date: it.date,
    title: (it.title && (it.title.kr || Object.values(it.title)[0])) || "",
    hidden: !!it.hidden, expired: !!(it.until && it.until < today),
    mine: !!it.owner_post,
    canDelete: !!it.owner_post || isAdmin, // 삭제는 고객이 직접 올린 글만 (관리자는 전부)
  }));
  return json({ ok: true, items });
}

// 숨기기·보이기·삭제. 숨기기는 모든 글, 삭제는 고객이 올린 글(owner_post)만 (관리자는 전부)
async function handleNewsManage(env, req) {
  const body = await req.json();
  const { repo, slug } = body;
  const { email, isAdmin } = await authorizePremium(env, req, repo, slug);
  const action = body.action, id = String(body.id || "");
  if (!["hide", "show", "delete"].includes(action) || !id) throw new HttpError(400, "잘못된 요청이에요.");
  const path = `${slug}/news.json`;
  let removedImages = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await githubGetFile(env, repo, path);
    const data = JSON.parse(f.content);
    const idx = (data.items || []).findIndex((it) => it.id === id);
    if (idx < 0) throw new HttpError(404, "이미 없는 소식이에요. 목록을 새로고침해주세요.");
    const it = data.items[idx];
    if (action === "delete") {
      if (!it.owner_post && !isAdmin) throw new HttpError(403, "관리자가 올린 소식은 삭제할 수 없어요. 숨기기를 사용해주세요.");
      removedImages = (it.images || []).filter((p) => /^news\/[\w.-]+$/.test(p));
      data.items.splice(idx, 1);
    } else if (action === "hide") it.hidden = true;
    else delete it.hidden;
    const verb = { hide: "숨기기", show: "보이기", delete: "삭제" }[action];
    try {
      await githubPutFile(env, repo, path, JSON.stringify(data, null, 2) + "\n", f.sha, `${COMMIT_PREFIX}: ${slug} 소식 ${verb} (${email})`);
      break;
    } catch (e) {
      if (e.code !== "stale" || attempt === 2) throw e;
    }
  }
  // 삭제한 소식의 사진도 함께 정리 (실패해도 소식 삭제는 이미 끝났으므로 무시)
  for (const rel of removedImages) {
    try { await githubDeleteFile(env, repo, `${slug}/${rel}`, `${COMMIT_PREFIX}: ${slug} 소식 사진 삭제 (${email})`); } catch (e) { /* ignore */ }
  }
  return json({ ok: true });
}

/* ── 관리자: 카드에 공통 수정 스크립트 설치 ─────── */
function installEditScript(html, repo, slug) {
  // 예전 방식(카드 안에 통째로 넣은 수정 코드)은 제거
  html = html.replace(/<div[^>]*>\s*<button id="dica-edit-btn"[\s\S]*?<\/div>\s*/, "");
  html = html.replace(/<style>\s*#dica-edit-modal[\s\S]*?<\/script>\s*/, "");
  if (html.includes(EDIT_SCRIPT_SRC)) return html;
  if ((html.match(/<\/body>/g) || []).length !== 1) throw new Error("</body> 태그를 정확히 하나 찾지 못함 (카드 구조 확인 필요)");
  const tag = `<script src="${EDIT_SCRIPT_SRC}" data-repo="${repo}" data-slug="${slug}" defer></script>\n`;
  return html.replace("</body>", tag + "</body>");
}

async function handleAdmin(env, req, url) {
  if (req.headers.get("X-Admin-Key") !== env.ADMIN_KEY) throw new HttpError(401, "관리자 인증 실패");

  if (url.pathname === "/admin/register" && req.method === "POST") {
    const { repo, slug, email } = await req.json();
    checkTarget(repo, slug);
    await env.DICA_OWNERS.put(`${repo}/${slug}`, String(email).toLowerCase().trim());
    return json({ ok: true });
  }

  // 프리미엄(소식 올리기) 켜기/끄기: { repo, slug, on: true|false }
  if (url.pathname === "/admin/premium" && req.method === "POST") {
    const { repo, slug, on } = await req.json();
    checkTarget(repo, slug);
    if (on === false) await env.DICA_OWNERS.delete(`premium:${repo}/${slug}`);
    else await env.DICA_OWNERS.put(`premium:${repo}/${slug}`, "1");
    return json({ ok: true, premium: on !== false });
  }

  if (url.pathname === "/admin/list" && req.method === "GET") {
    const list = await env.DICA_OWNERS.list();
    const rows = await Promise.all(list.keys.map(async (k) => ({ key: k.name, email: await env.DICA_OWNERS.get(k.name) })));
    return json({ ok: true, rows });
  }

  if (url.pathname === "/admin/translate-test" && req.method === "GET") {
    const out = await translateLines(env, [["안녕하세요", "반갑습니다"]], "English");
    return json({ ok: true, out });
  }

  if (url.pathname === "/admin/install" && req.method === "POST") {
    const body = await req.json();
    let targets;
    if (body.all) {
      const list = await env.DICA_OWNERS.list();
      targets = list.keys.filter((k) => !k.name.startsWith("premium:")).map((k) => ({ repo: k.name.slice(0, k.name.indexOf("/")), slug: k.name.slice(k.name.indexOf("/") + 1) }));
    } else if (Array.isArray(body.targets)) targets = body.targets;
    else if (body.repo && body.slug) targets = [{ repo: body.repo, slug: body.slug }];
    else throw new HttpError(400, "repo/slug 또는 all:true 또는 targets 배열이 필요합니다.");
    const results = [];
    for (const t of targets) {
      try {
        checkTarget(t.repo, t.slug);
        const path = `${t.slug}/index.html`;
        const { content, sha } = await githubGetFile(env, t.repo, path);
        const patched = installEditScript(content, t.repo, t.slug);
        if (patched === content) { results.push({ ...t, ok: true, skipped: "이미 설치됨" }); continue; }
        await githubPutFile(env, t.repo, path, patched, sha, `${COMMIT_PREFIX}: ${t.slug} 수정 버튼 설치/갱신`);
        results.push({ ...t, ok: true });
      } catch (e) {
        results.push({ ...t, ok: false, error: e.message });
      }
    }
    return json({ ok: true, results });
  }

  throw new HttpError(404, "not found");
}

/* ── 라우터 ──────────────────────────────────────── */
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    const url = new URL(req.url);
    try {
      if (url.pathname === "/health") return json({ ok: true, version: WORKER_VERSION });
      if (url.pathname === "/owner-check" && req.method === "GET") {
        try {
          const repo = url.searchParams.get("repo"), slug = url.searchParams.get("slug");
          const { isAdmin } = await authorize(env, req, repo, slug);
          return json({ ok: true, admin: isAdmin, premium: await isPremium(env, repo, slug) });
        } catch (e) {
          if (e.code === "not-registered" || e.code === "mismatch") return json({ ok: false, reason: e.code });
          throw e;
        }
      }
      if (url.pathname === "/save" && req.method === "POST") return await handleSave(env, req);
      if (url.pathname === "/news/draft" && req.method === "POST") return await handleNewsDraft(env, req);
      if (url.pathname === "/news/post" && req.method === "POST") return await handleNewsPost(env, req);
      if (url.pathname === "/news/list" && req.method === "POST") return await handleNewsList(env, req);
      if (url.pathname === "/news/manage" && req.method === "POST") return await handleNewsManage(env, req);
      if (url.pathname.startsWith("/admin/")) return await handleAdmin(env, req, url);
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: e.message, code: e.code }, e.status || 400);
    }
  },
};
