/* ─────────────────────────────────────────────────────────────
 * dica-editor — DiCA 명함 셀프 수정 서버 (Cloudflare Worker)
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
 * ───────────────────────────────────────────────────────────── */

const OWNER = "jinjjabg-hub";
const ALLOWED_REPOS = ["NAMECARD", "BNI-PIONEER-cards", "bni-giants"];
const COMMIT_PREFIX = "내 명함 관리";
const EDIT_SCRIPT_SRC = "https://jinjjabg-hub.github.io/NAMECARD/dica-edit.js";
const TRANSLATE_MODEL = "claude-haiku-4-5";

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
  // 토큰이 레포 쓰기 권한을 가지고 있으므로, 명함 레포/폴더 밖으로는 절대 못 나가게 막는다
  if (!ALLOWED_REPOS.includes(repo)) throw new HttpError(400, "허용되지 않은 레포");
  if (!slug || /[\/\\]|\.\./.test(slug)) throw new HttpError(400, "잘못된 명함 이름");
}
async function authorize(env, req, repo, slug) {
  checkTarget(repo, slug);
  const email = await verifyFirebaseToken((req.headers.get("Authorization") || "").replace(/^Bearer /, ""), env.FIREBASE_PROJECT_ID);
  const isAdmin = adminEmails(env).includes(email);
  const owner = await env.DICA_OWNERS.get(`${repo}/${slug}`);
  if (isAdmin) return { email, isAdmin, owner };
  if (!owner) throw new HttpError(403, "이 명함에 등록된 계정이 없습니다.", "not-registered");
  if (owner.toLowerCase() !== email) throw new HttpError(403, "본인 명함이 아닙니다.", "mismatch");
  return { email, isAdmin, owner };
}

/* ── GitHub ──────────────────────────────────────── */
const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");
function ghHeaders(env) {
  return { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "dica-editor-worker", Accept: "application/vnd.github+json" };
}
async function githubGetFile(env, repo, path) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${repo}/contents/${encodePath(path)}`, { headers: ghHeaders(env) });
  if (!res.ok) throw new HttpError(502, `GitHub 조회 실패 (${res.status})`);
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
  if (res.status === 409) throw new HttpError(409, "그 사이 명함이 업데이트됐어요. 다시 열어 수정해주세요.", "stale");
  if (!res.ok) throw new HttpError(502, `GitHub 저장 실패 (${res.status}) ${(await res.text()).slice(0, 200)}`);
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
  ur: "Urdu", si: "Sinhala", th: "Thai", id: "Indonesian", ru: "Russian",
};

// items: [[줄1, 줄2, ...], ...] → 같은 모양의 번역 배열
async function translateLines(env, items, langName) {
  const schema = {
    type: "object",
    properties: { translations: { type: "array", items: { type: "array", items: { type: "string" } } } },
    required: ["translations"],
    additionalProperties: false,
  };
  const prompt =
    `Translate the Korean business-card text below into ${langName}.\n` +
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
    if (!cur || cur.kr === undefined) throw new HttpError(409, "명함 구조가 바뀌었어요. 다시 열어 수정해주세요.", "stale");
    if (typeof patch._base === "string" && patch._base !== cur.kr) {
      throw new HttpError(409, "그 사이 명함이 업데이트됐어요. 다시 열어 수정해주세요.", "stale");
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
  return json({ ok: true, count: Object.keys(changes).length, admin: isAdmin });
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
      targets = list.keys.map((k) => ({ repo: k.name.slice(0, k.name.indexOf("/")), slug: k.name.slice(k.name.indexOf("/") + 1) }));
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
      if (url.pathname === "/owner-check" && req.method === "GET") {
        try {
          const { isAdmin } = await authorize(env, req, url.searchParams.get("repo"), url.searchParams.get("slug"));
          return json({ ok: true, admin: isAdmin });
        } catch (e) {
          if (e.code === "not-registered" || e.code === "mismatch") return json({ ok: false, reason: e.code });
          throw e;
        }
      }
      if (url.pathname === "/save" && req.method === "POST") return await handleSave(env, req);
      if (url.pathname.startsWith("/admin/")) return await handleAdmin(env, req, url);
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: e.message, code: e.code }, e.status || 400);
    }
  },
};
