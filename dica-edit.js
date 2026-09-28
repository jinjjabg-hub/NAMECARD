/* ─────────────────────────────────────────────────────────────
 * DiCA 명함 셀프 수정 (카드 주인 전용) — 공통 스크립트
 *
 * 사용법 (카드 index.html 의 </body> 바로 위에 한 줄):
 *   <script src="https://jinjjabg-hub.github.io/NAMECARD/dica-edit.js"
 *           data-repo="BNI-PIONEER-cards" data-slug="송승훈" defer></script>
 *
 * 왜 공통 파일인가: 카드마다 코드를 복사하면 버그 하나에 39곳을 고쳐야 한다.
 * 이 파일 하나만 고치면 모든 카드에 즉시 반영된다.
 *
 * 버튼 표시
 *  - 방문자에게는 안 보임. 주인 전용 링크(카드주소?edit)로 열면 보임.
 *  - 주인 인증에 한 번 성공하면 그 기기에서는 다음부터 ?edit 없이도 보임.
 *
 * 규칙
 *  - 텍스트(<span data-lang> 묶음)만 수정 가능. 사진·링크·레이아웃은 불가.
 *  - 카드 1장당 한 달(달력 기준, 한국시간)에 1회 저장. 관리자 계정은 예외.
 *  - 한국어만 고치면 나머지 언어는 Worker가 자동 번역.
 * ───────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var me = document.currentScript;
  var CFG = {
    workerUrl: 'https://dica-editor.jinjjabg.workers.dev',
    owner: 'jinjjabg-hub',
    repo: me && me.dataset.repo,
    slug: me && me.dataset.slug,
    branch: (me && me.dataset.branch) || 'main',
    admins: ['jinjjabg@gmail.com'],
    commitPrefix: '내 명함 관리',
  };
  if (!CFG.repo || !CFG.slug) {
    console.warn('[dica-edit] data-repo / data-slug 가 없어 수정 버튼을 만들지 않습니다.');
    return;
  }
  var FILE_PATH = CFG.slug + '/index.html';

  // 서버(worker.js)의 그룹핑 규칙과 완전히 동일한 정규식 — 이 순서로 T001,T002... 번호가 매겨져야 저장이 정확히 반영됨
  var SPAN_RE = /<span data-lang="([a-z]{2})"( class="active")?>([\s\S]*?)<\/span>/g;
  var GROUP_RE = new RegExp('(?:' + SPAN_RE.source + '\\s*)+', 'g');

  var state = { token: null, email: '', groups: [], isAdmin: false };

  /* ── 유틸 ─────────────────────────────────────────── */
  function extractGroups(html) {
    var groups = [];
    var n = 0;
    html.replace(GROUP_RE, function (block) {
      var spans = Array.from(block.matchAll(SPAN_RE));
      if (spans.length < 2) return block;
      n++;
      var langs = {};
      spans.forEach(function (s) { langs[s[1]] = s[3]; });
      groups.push({ key: 'T' + String(n).padStart(3, '0'), langs: langs });
      return block;
    });
    return groups;
  }

  function plain(html) {
    var d = document.createElement('div');
    d.innerHTML = html;
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // 편집창에는 <br>을 줄바꿈으로 보여준다 (태그를 몰라도 고칠 수 있게)
  function toEditable(html) {
    return html.replace(/\s*<br\s*\/?>\s*/gi, '\n').trim();
  }

  // 저장 전 정리: 허용 태그(<br>, <strong>, <b>)만 남기고 나머지 '<'는 글자로 바꾼다
  var ALLOWED_TAG = /^<\/?(strong|b)>$|^<br\s*\/?>$/i;
  function toSavable(text, original) {
    var out = text.replace(/\r/g, '').replace(/<[^>]*>|</g, function (t) {
      var keep = ALLOWED_TAG.test(t) || (t.length > 1 && original.indexOf(t) >= 0); // 원래 있던 태그는 유지
      return keep ? t : t.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    });
    out = out.replace(/\n/g, '<br>');
    // 원래 문구와 줄바꿈 표현만 다르면(= 사실상 변경 없음) 원본을 그대로 유지
    return toEditable(original) === text ? original : out;
  }

  function kstMonthStart() {
    var now = new Date(Date.now() + 9 * 3600e3); // KST 벽시계
    var y = now.getUTCFullYear(), m = now.getUTCMonth();
    return { iso: new Date(Date.UTC(y, m, 1) - 9 * 3600e3).toISOString(), y: y, m: m };
  }

  function nextMonthLabel() {
    var s = kstMonthStart();
    var nm = (s.m + 1) % 12 + 1;
    return nm + '월 1일';
  }

  function ownerKey() { return 'dica-owner:' + CFG.repo + '/' + CFG.slug; }
  function canShowButton() {
    if (/[?&]edit(=|&|$)/.test(location.search)) return true;
    try { return localStorage.getItem(ownerKey()) === '1'; } catch (e) { return false; }
  }
  function rememberOwner() {
    try { localStorage.setItem(ownerKey(), '1'); } catch (e) {}
    var w = document.getElementById('dica-edit-wrap');
    if (w) w.style.display = '';
  }

  function localKey() { return 'dica-edit:' + CFG.repo + '/' + CFG.slug; }

  /* ── GitHub (읽기 전용, 공개 API) ─────────────────── */
  // Pages(CDN)는 몇 분씩 옛 버전을 보여줄 수 있어서, Worker가 보는 것과 같은 GitHub 원본을 읽는다.
  function fetchSource() {
    var url = 'https://api.github.com/repos/' + CFG.owner + '/' + CFG.repo + '/contents/' +
      FILE_PATH.split('/').map(encodeURIComponent).join('/') + '?ref=' + CFG.branch + '&t=' + Date.now();
    return fetch(url, { headers: { Accept: 'application/vnd.github.raw' }, cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('원본 불러오기 실패 (' + r.status + ')');
        return r.text();
      })
      .catch(function () {
        // API 한도 초과 등 → 현재 페이지로 대체
        return fetch(location.href.split('#')[0], { cache: 'no-store' }).then(function (r) { return r.text(); });
      });
  }

  // 이번 달(한국시간) 이미 셀프 수정 커밋이 있는지 확인
  function usedThisMonth() {
    try {
      var saved = localStorage.getItem(localKey());
      if (saved && saved >= kstMonthStart().iso) return Promise.resolve(true);
    } catch (e) {}
    var url = 'https://api.github.com/repos/' + CFG.owner + '/' + CFG.repo + '/commits?sha=' + CFG.branch +
      '&path=' + encodeURIComponent(FILE_PATH) + '&since=' + encodeURIComponent(kstMonthStart().iso) + '&per_page=100';
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        return (list || []).some(function (c) {
          var msg = (c.commit && c.commit.message) || '';
          // 관리자가 대신 고친 건 주인의 횟수에서 빼준다
          return msg.indexOf(CFG.commitPrefix) === 0 &&
            !CFG.admins.some(function (a) { return msg.indexOf('(' + a + ')') >= 0; });
        });
      })
      .catch(function () { return false; });
  }

  /* ── 카드 화면과 항목 연결 (라벨 + 위치 보기) ────── */
  // 섹션 제목(예: "왜 T.M이어야 하는가")을 라벨로 쓴다. 같은 섹션 안에서는 순번을 붙인다.
  var HEADING_SEL = '.sec-title, .section-title, .block-label, section > h2';

  function mapToPage(groups) {
    var live = Array.from(document.querySelectorAll('span[data-lang="kr"]'))
      .filter(function (el) { return !el.closest('#dica-edit-modal'); });
    var liveText = live.map(function (el) { return plain(el.innerHTML); });
    var headings = Array.from(document.querySelectorAll(HEADING_SEL))
      .filter(function (h) { return h.querySelector('[data-lang="kr"]'); });
    var ptr = 0, lastSection = null, seq = 0;
    groups.forEach(function (g) {
      var t = plain(g.langs.kr || '');
      for (var i = ptr; i < live.length; i++) {
        if (liveText[i] === t) { g.el = live[i]; ptr = i + 1; break; }
      }
      var section = '상단 프로필', isTitle = false;
      if (g.el) {
        headings.forEach(function (h) {
          if (h.contains(g.el)) { section = plain(h.querySelector('[data-lang="kr"]').innerHTML); isTitle = true; }
          else if (h.compareDocumentPosition(g.el) & Node.DOCUMENT_POSITION_FOLLOWING) {
            section = plain(h.querySelector('[data-lang="kr"]').innerHTML); isTitle = false;
          }
        });
      } else if (lastSection) section = lastSection;
      if (section.length > 18) section = section.slice(0, 18) + '…';
      if (section !== lastSection) { lastSection = section; seq = 0; }
      g.label = isTitle ? section + ' · 섹션 제목' : section + ' · ' + (++seq);
    });
  }

  function flash(el) {
    closeModal();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.transition = 'background-color .3s';
    var prev = el.style.backgroundColor;
    el.style.backgroundColor = 'rgba(255,214,0,.55)';
    setTimeout(function () { el.style.backgroundColor = prev; }, 1600);
    setTimeout(openModalOnly, 1900);
  }

  /* ── UI ───────────────────────────────────────────── */
  var CSS =
    '#dica-edit-wrap{padding:4px 20px 4px;text-align:center;}' +
    '#dica-edit-btn{background:none;border:1px solid rgba(128,128,128,.35);color:#888;font-size:10.5px;padding:7px 14px;border-radius:20px;cursor:pointer;font-family:inherit;}' +
    '#dica-edit-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483000;align-items:flex-end;justify-content:center;}' +
    '#dica-edit-modal.open{display:flex;}' +
    '#dica-edit-sheet{background:#fff;color:#111;width:100%;max-width:480px;max-height:86vh;border-radius:16px 16px 0 0;display:flex;flex-direction:column;font-family:inherit;}' +
    '#dica-edit-head{padding:16px 18px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;}' +
    '#dica-edit-head b{font-size:14px;}' +
    '#dica-edit-close{background:none;border:none;font-size:20px;cursor:pointer;color:#888;}' +
    '#dica-edit-info{padding:10px 18px;background:#fff8e1;font-size:11.5px;line-height:1.5;color:#7a5b00;}' +
    '#dica-edit-list{overflow-y:auto;padding:12px 18px;flex:1;}' +
    '.dica-edit-item{margin-bottom:14px;}' +
    '.dica-edit-item .lb{display:flex;justify-content:space-between;align-items:center;font-size:10.5px;color:#999;margin-bottom:4px;}' +
    '.dica-edit-item .lb button{background:none;border:none;color:#3b82f6;font-size:10.5px;cursor:pointer;padding:0;}' +
    '.dica-edit-item textarea{width:100%;box-sizing:border-box;border:1px solid #ddd;border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;resize:vertical;min-height:38px;color:#111;background:#fff;}' +
    '.dica-edit-item textarea.changed{border-color:#3b82f6;background:#f0f6ff;}' +
    '#dica-edit-foot{padding:12px 18px 18px;border-top:1px solid #eee;}' +
    '#dica-edit-save{width:100%;padding:12px;border:none;border-radius:10px;background:#111;color:#fff;font-size:14px;cursor:pointer;font-family:inherit;}' +
    '#dica-edit-save:disabled{opacity:.5;cursor:default;}' +
    '#dica-edit-note{font-size:10.5px;color:#999;text-align:center;margin-top:8px;line-height:1.5;}';

  function buildUI() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // 버튼: 카드에 #dica-edit-slot 이 있으면 그 자리, 없으면 만두 버튼 아래 → 푸터 위 → body 끝
    var wrap = document.createElement('div');
    wrap.id = 'dica-edit-wrap';
    wrap.innerHTML = '<button id="dica-edit-btn" type="button">✏️ 내 명함 수정</button>';
    var slot = document.getElementById('dica-edit-slot');
    var mandu = document.getElementById('mandu-activate-btn');
    var footer = document.querySelector('footer');
    if (slot) slot.appendChild(wrap);
    else if (mandu && mandu.parentElement) mandu.parentElement.insertAdjacentElement('afterend', wrap);
    else if (footer) footer.parentElement.insertBefore(wrap, footer);
    else document.body.appendChild(wrap);
    wrap.querySelector('button').addEventListener('click', openEdit);
    // 방문자에게는 숨긴다. 주인 전용 링크(?edit)로 들어왔거나, 이 기기에서 주인 인증을 한 적이 있을 때만 보인다.
    if (!canShowButton()) wrap.style.display = 'none';

    var modal = document.createElement('div');
    modal.id = 'dica-edit-modal';
    modal.innerHTML =
      '<div id="dica-edit-sheet">' +
      '  <div id="dica-edit-head"><b>명함 문구 수정</b><button id="dica-edit-close" type="button">✕</button></div>' +
      '  <div id="dica-edit-info"></div>' +
      '  <div id="dica-edit-list"></div>' +
      '  <div id="dica-edit-foot">' +
      '    <button id="dica-edit-save" type="button">저장하기</button>' +
      '    <div id="dica-edit-note">한국어만 고치면 다른 언어는 자동으로 번역돼요.<br>저장 후 반영까지 1~2분 걸릴 수 있어요.</div>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
    document.getElementById('dica-edit-close').addEventListener('click', closeModal);
    document.getElementById('dica-edit-save').addEventListener('click', save);
  }

  function openModalOnly() { document.getElementById('dica-edit-modal').classList.add('open'); }
  function closeModal() { document.getElementById('dica-edit-modal').classList.remove('open'); }

  function renderList() {
    var list = document.getElementById('dica-edit-list');
    list.innerHTML = '';
    state.groups.forEach(function (g) {
      if (!g.langs.kr) return;
      var wrap = document.createElement('div');
      wrap.className = 'dica-edit-item';
      var lb = document.createElement('div');
      lb.className = 'lb';
      var name = document.createElement('span');
      name.textContent = g.label;
      lb.appendChild(name);
      if (g.el) {
        var go = document.createElement('button');
        go.type = 'button';
        go.textContent = '📍 위치 보기';
        go.addEventListener('click', function () { flash(g.el); });
        lb.appendChild(go);
      }
      var ta = document.createElement('textarea');
      ta.value = toEditable(g.langs.kr);
      ta.rows = Math.min(6, ta.value.split('\n').length + Math.floor(ta.value.length / 34));
      ta.dataset.key = g.key;
      ta.addEventListener('input', function () {
        ta.classList.toggle('changed', ta.value !== toEditable(g.langs.kr));
      });
      wrap.appendChild(lb);
      wrap.appendChild(ta);
      list.appendChild(wrap);
    });
  }

  /* ── 로그인 ───────────────────────────────────────── */
  var FIREBASE_CONFIG = {
    apiKey: 'AIzaSyAZoWSGSA81daZydNgzegct2aaeFbDajr0',
    authDomain: 'mandu-e7c3c.firebaseapp.com',
    projectId: 'mandu-e7c3c',
    storageBucket: 'mandu-e7c3c.firebasestorage.app',
    messagingSenderId: '196338490174',
    appId: '1:196338490174:web:78dc77e684945aca362a6f',
  };
  function loadScript(src) {
    return new Promise(function (res) {
      if (document.querySelector('script[src="' + src + '"]')) return res();
      var el = document.createElement('script');
      el.src = src; el.onload = res; el.onerror = res;
      document.head.appendChild(el);
    });
  }
  // 보통은 카드의 save-to-cardbook.js 가 Firebase 를 준비한다. 그게 없는 카드면 직접 불러와 초기화.
  function waitFirebase() {
    var hasCardbook = !!document.querySelector('script[src*="save-to-cardbook"]');
    var boot = (typeof firebase === 'undefined' && !hasCardbook)
      ? loadScript('https://www.gstatic.com/firebasejs/11.0.1/firebase-app-compat.js')
          .then(function () { return loadScript('https://www.gstatic.com/firebasejs/11.0.1/firebase-auth-compat.js'); })
      : Promise.resolve();
    return boot.then(function () {
      return new Promise(function (resolve) {
        var tries = 0;
        (function loop() {
          if (typeof firebase !== 'undefined' && firebase.apps) {
            if (!firebase.apps.length && (!hasCardbook || tries > 30)) {
              try { firebase.initializeApp(FIREBASE_CONFIG); } catch (e) { /* 다른 스크립트가 먼저 초기화 */ }
            }
            if (firebase.apps.length && firebase.auth) return resolve(true);
          }
          if (++tries > 80) return resolve(false);
          setTimeout(loop, 150);
        })();
      });
    });
  }

  var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  var PENDING_KEY = '_dicaPending:' + CFG.repo + '/' + CFG.slug;

  function openEdit() {
    var btn = document.getElementById('dica-edit-btn');
    var orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '로그인 중...';
    waitFirebase()
      .then(function (ready) {
        if (!ready) throw new Error('로그인 준비 실패. 잠시 후 다시 시도해주세요.');
        var auth = firebase.auth();
        return auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).then(function () {
          var provider = new firebase.auth.GoogleAuthProvider();
          // 휴대폰(특히 카톡 안 브라우저)은 팝업이 막히는 경우가 많아 화면 전환 방식으로 로그인한다.
          // 돌아오면 아래 resumeAfterRedirect() 가 이어서 편집창을 연다.
          if (isMobile) {
            try { sessionStorage.setItem(PENDING_KEY, '1'); } catch (e) {}
            return auth.signInWithRedirect(provider).then(function () { return null; });
          }
          return auth.signInWithPopup(provider).then(function (r) { return afterLogin(r.user, btn); });
        });
      })
      .catch(function (e) { alert('로그인/불러오기 실패: ' + e.message); })
      .then(function () { btn.disabled = false; btn.textContent = orig; });
  }

  // 로그인 후: 주인 확인 → 이번 달 사용 여부 → 원본 불러와 편집창 열기
  function afterLogin(user, btn) {
    state.email = (user.email || '').toLowerCase();
    state.isAdmin = CFG.admins.indexOf(state.email) >= 0;
    if (btn) btn.textContent = '확인 중...';
    return user.getIdToken()
      .then(function (token) {
        state.token = token;
        return fetch(CFG.workerUrl + '/owner-check?repo=' + encodeURIComponent(CFG.repo) + '&slug=' + encodeURIComponent(CFG.slug), {
          headers: { Authorization: 'Bearer ' + token },
        }).then(function (r) { return r.json(); });
      })
      .then(function (check) {
        if (!check.ok) {
          alert(check.reason === 'not-registered'
            ? '이 명함에 등록된 계정이 없습니다. 관리자(송승훈)에게 문의하세요.'
            : '이 명함의 주인 계정으로 로그인해주세요.');
          return null;
        }
        if (check.admin) state.isAdmin = true;
        else rememberOwner(); // 주인 인증 성공 → 다음부터 이 기기에서는 ?edit 없이도 버튼이 보임
        return Promise.all([state.isAdmin ? false : usedThisMonth(), fetchSource()]);
      })
      .then(function (res) {
        if (!res) return;
        if (res[0]) {
          alert('이번 달 수정은 이미 사용하셨어요.\n' + nextMonthLabel() + '부터 다시 수정할 수 있어요.\n\n급한 수정은 관리자(송승훈)에게 문의해주세요.');
          return;
        }
        state.groups = extractGroups(res[1]);
        if (!state.groups.length) throw new Error('수정할 수 있는 문구를 찾지 못했습니다.');
        mapToPage(state.groups);
        renderList();
        document.getElementById('dica-edit-info').innerHTML = state.isAdmin
          ? '🔑 관리자 계정 — 횟수 제한 없음'
          : '📅 수정은 <b>한 달에 1번</b> 저장할 수 있어요. 고칠 곳을 모두 고친 뒤 한 번에 저장해주세요.';
        openModalOnly();
      });
  }

  // 휴대폰에서 구글 로그인하고 돌아왔을 때 이어서 편집창 열기
  function resumeAfterRedirect() {
    var pending = false;
    try { pending = sessionStorage.getItem(PENDING_KEY) === '1'; } catch (e) {}
    if (!pending) return;
    try { sessionStorage.removeItem(PENDING_KEY); } catch (e) {}
    waitFirebase().then(function (ready) {
      if (!ready) return;
      var unsub = firebase.auth().onAuthStateChanged(function (user) {
        if (!user) return;
        unsub();
        afterLogin(user, null).catch(function (e) { alert('편집창 열기 실패: ' + e.message); });
      });
    });
  }

  /* ── 저장 ─────────────────────────────────────────── */
  function save() {
    var btn = document.getElementById('dica-edit-save');
    var changes = {}, edited = [];
    document.querySelectorAll('#dica-edit-list textarea').forEach(function (ta) {
      var g = state.groups.find(function (x) { return x.key === ta.dataset.key; });
      if (!g) return;
      var newVal = toSavable(ta.value, g.langs.kr || '');
      if (newVal === (g.langs.kr || '')) return; // 안 바뀐 항목은 건너뜀
      if (!newVal.trim()) return;               // 빈칸으로 지우는 건 막는다 (레이아웃 깨짐 방지)
      // _base: 내가 불러온 원래 문구 — 서버가 현재 문구와 다르면 저장을 거절한다 (덮어쓰기 방지)
      changes[g.key] = { kr: newVal, _base: g.langs.kr, _langs: Object.keys(g.langs).filter(function (l) { return l !== 'kr'; }) };
      edited.push({ g: g, val: newVal });
    });
    if (!edited.length) { alert('바뀐 내용이 없습니다.'); return; }
    if (!state.isAdmin && !confirm(edited.length + '개 항목을 저장합니다.\n저장하면 이번 달 수정 기회를 사용하게 돼요. 계속할까요?')) return;

    btn.disabled = true;
    btn.textContent = '최신 버전 확인 중...';
    // 그 사이 관리자가 파일을 바꿨으면 번호(T001…)가 밀려 엉뚱한 칸이 덮어써질 수 있다 → 저장 직전에 다시 확인
    fetchSource()
      .then(function (html) {
        var fresh = extractGroups(html);
        var stale = fresh.length !== state.groups.length || edited.some(function (e) {
          var f = fresh.find(function (x) { return x.key === e.g.key; });
          return !f || f.langs.kr !== e.g.langs.kr;
        });
        if (stale) throw new Error('그 사이 명함이 업데이트됐어요. 창을 닫고 다시 열어 수정해주세요. (수정 기회는 사용되지 않았어요)');
        btn.textContent = '저장 중... (번역 포함, 몇 초 걸릴 수 있어요)';
        return fetch(CFG.workerUrl + '/save', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: CFG.repo, slug: CFG.slug, changes: changes }),
        }).then(function (r) { return r.json(); });
      })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || '저장 실패');
        try { localStorage.setItem(localKey(), new Date().toISOString()); } catch (e) {}
        edited.forEach(function (e) { if (e.g.el) e.g.el.innerHTML = e.val; e.g.langs.kr = e.val; });
        alert('저장됐습니다! 다른 언어 번역까지 반영되기까지 1~2분 정도 걸릴 수 있어요.');
        closeModal();
      })
      .catch(function (e) { alert('저장 실패: ' + e.message); })
      .then(function () { btn.disabled = false; btn.textContent = '저장하기'; });
  }

  function start() { buildUI(); resumeAfterRedirect(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
