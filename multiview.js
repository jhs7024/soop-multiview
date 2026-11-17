// 멀티뷰 화면: 선택한 방송을 격자로 보여주고, 칸마다 교체/닫기, 방송 종료 표시, 채팅
// 즐겨찾기·로그인은 확장 프로그램에 부탁한다 (soop-player.js 의 askExtension)

const MAX_SLOTS = 4;
const REFRESH_MS = 60 * 1000;   // 방송 종료 확인 주기
const LAYOUT_KEY = 'multiview.layout';

const state = {
  ids: [],         // 화면에 나오는 순서대로
  layout: 'grid',  // 'row' (세로 일렬) | 'grid' (2×2)
  chatId: null,
};
let favorites = [];               // 가장 최근에 불러온 즐겨찾기
const slotEls = new Map();        // 방송 아이디 → 칸 요소 (칸을 다시 만들지 않아야 다른 방송이 안 끊김)
const readyIds = new Set();       // 플레이어가 "준비됨" 신호를 보낸 방송 (채팅은 플레이어가 준비된 뒤에 연결)
const liveNicks = new Map();      // 플레이어가 알려준 닉네임 (즐겨찾기에 없는 방송용)
let pickerTarget = null;          // null 이면 추가, 아이디면 그 칸 교체
const MAX_CHAT_RETRIES = 3;       // 채팅이 안 붙을 때 자동으로 다시 연결하는 최대 횟수
let chatRetries = 0;

const $ = (id) => document.getElementById(id);

// ---------- 주소(#ids=...&layout=...)에 상태 저장: 새로고침해도 유지 ----------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  state.ids = [...new Set((p.get('ids') || '').split(',').filter(Boolean))].slice(0, MAX_SLOTS);
  state.layout = p.get('layout') || loadPref(LAYOUT_KEY) || 'grid';
}
function writeHash() {
  const p = new URLSearchParams({ ids: state.ids.join(','), layout: state.layout });
  history.replaceState(null, '', '#' + p);
}
function loadPref(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

const nickOf = (id) => favorites.find((f) => f.id === id)?.nick || liveNicks.get(id) || id;

// ---------- 화면 그리기 ----------
function render() {
  const stage = $('stage');
  const n = state.ids.length;
  stage.dataset.layout = state.layout;
  // 세로 일렬: n줄 / 2×2: 1~2명은 위아래로, 3~4명은 2줄
  const rows = state.layout === 'row' ? n : n <= 2 ? n : 2;
  stage.style.setProperty('--rows', Math.max(rows, 1));

  // 빠진 방송의 칸 제거
  for (const [id, el] of slotEls) {
    if (!state.ids.includes(id)) { el.remove(); slotEls.delete(id); readyIds.delete(id); }
  }
  // 있는 방송은 순서만 맞추고, 새 방송만 칸을 만든다
  state.ids.forEach((id, i) => {
    let el = slotEls.get(id);
    if (!el) {
      el = makeSlot(id);
      slotEls.set(id, el);
      stage.append(el);
    }
    el.style.order = i;
    // 2×2 에서 1~2명이면 모두, 3명이면 마지막 칸이 가로 한 줄을 다 차지
    const fullWidth = state.layout === 'grid' && (n <= 2 || (n === 3 && i === 2));
    el.style.gridColumn = fullWidth ? '1 / -1' : '';
    updateSlot(el, id);
  });

  // 방송이 하나도 없을 때만 "방송 추가" 칸을 보여준다
  stage.querySelectorAll('.empty').forEach((e) => e.remove());
  if (n === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '＋ 방송 추가';
    e.addEventListener('click', () => openPicker(null));
    stage.append(e);
  }

  document.querySelectorAll('.seg').forEach((b) => b.classList.toggle('on', b.dataset.layout === state.layout));
  $('addBtn').disabled = n >= MAX_SLOTS;
  document.title = n ? `멀티뷰 · ${state.ids.map(nickOf).join(', ')}` : '멀티뷰';
  renderChat();
  writeHash();
}

function makeSlot(id) {
  const el = document.createElement('div');
  el.className = 'slot';
  el.innerHTML = `
    <iframe allow="autoplay; fullscreen; encrypted-media; local-network-access; loopback-network"></iframe>
    <div class="slot-bar">
      <span class="slot-name"></span>
      <button data-act="swap">⇄ 교체</button>
      <button data-act="close">✕</button>
    </div>
    <div class="ended" hidden>
      <span>방송이 종료됐어요</span>
      <button data-act="swap">다른 방송으로 교체</button>
      <button data-act="close" class="plain">닫기</button>
    </div>`;
  setPlayer(el, id);
  el.addEventListener('click', (ev) => {
    const act = ev.target.closest('button')?.dataset.act;
    if (act === 'swap') openPicker(el.dataset.id);
    if (act === 'close') removeStream(el.dataset.id);
  });
  return el;
}

// 칸의 플레이어를 이 방송으로 연다. iframe 이름은 채팅 화면이 자기 플레이어를 찾는 데 쓰인다.
function setPlayer(el, id) {
  if (el.dataset.id) readyIds.delete(el.dataset.id);
  readyIds.delete(id);
  el.dataset.id = id;
  const iframe = el.querySelector('iframe');
  iframe.name = SOOP.frameName(id);
  iframe.src = SOOP.playerUrl(id);
}

function updateSlot(el, id) {
  el.querySelector('.slot-name').textContent = nickOf(id);
  const fav = favorites.find((f) => f.id === id);
  // 즐겨찾기에 있는데 방송 중이 아니면 종료 표시 (즐겨찾기에 없는 방송은 알 수 없으니 표시 안 함)
  el.querySelector('.ended').hidden = !(fav && !fav.isLive);
}

// ---------- 플레이어와 신호 주고받기 ----------
// SOOP 플레이어는 "준비됨(PonReady)" 을 보내고, 우리가 "재생할 방송(Pload)" 으로 답해야 재생을 시작한다.
window.addEventListener('message', (e) => {
  if (e.origin !== SOOP.PLAYER_ORIGIN || !e.data) return;
  if (e.data.cmd === 'smvLoginNeeded') {  // 채팅 화면이 로그인 창을 띄웠을 때 (확장 프로그램의 soop-frame.js)
    $('loginNotice').hidden = false;
    return;
  }
  if (e.data.cmd === 'smvChatStalled' && e.source === $('chatFrame').contentWindow) {
    // 채팅이 플레이어와 연결되지 못함 (soop-frame.js 가 알려줌) → 몇 번까지 자동으로 다시 연결
    if (chatRetries < MAX_CHAT_RETRIES) {
      chatRetries++;
      console.warn(`[멀티뷰] 채팅이 비어 있어서 다시 연결합니다 (${chatRetries}/${MAX_CHAT_RETRIES})`);
      reloadChat(false);
    } else {
      console.warn('[멀티뷰] 채팅 자동 재연결 실패. 채팅 칸의 ⟳ 를 눌러주세요.');
    }
    return;
  }
  const el = [...slotEls.values()].find((s) => s.querySelector('iframe').contentWindow === e.source);
  if (!el) return;
  const id = el.dataset.id;
  if (e.data.cmd === 'PonReady') {
    e.source.postMessage(SOOP.ploadMessage(id), SOOP.PLAYER_ORIGIN);
    const reloaded = readyIds.has(id); // 이미 준비됐던 플레이어가 다시 로딩됨 (재접속, 방송 재시작 등)
    readyIds.add(id);
    if (id === state.chatId) {
      // 플레이어가 다시 로딩되면 채팅과의 연결이 끊기므로 채팅도 다시 연다
      if (reloaded && !$('chat').hidden) reloadChat(false);
      else renderChat();
    }
  }
  if (e.data.cmd === 'PupdateBroadInfo' && e.data.data?.nick) {
    liveNicks.set(id, e.data.data.nick);
    render();
  }
});

// ---------- 방송 추가 / 교체 / 제거 ----------
function addStream(id) {
  if (state.ids.includes(id) || state.ids.length >= MAX_SLOTS) return;
  state.ids.push(id);
  render();
}

// 칸을 그대로 두고 플레이어만 바꾼다 → 다른 방송은 끊기지 않음
function replaceStream(oldId, newId) {
  const idx = state.ids.indexOf(oldId);
  if (idx < 0 || state.ids.includes(newId)) return;
  const el = slotEls.get(oldId);
  slotEls.delete(oldId);
  setPlayer(el, newId);
  slotEls.set(newId, el);
  state.ids[idx] = newId;
  if (state.chatId === oldId) state.chatId = newId;
  render();
}

function removeStream(id) {
  state.ids = state.ids.filter((x) => x !== id);
  render();
}

// ---------- 방송 고르기 창 ----------
function openPicker(targetId) {
  pickerTarget = targetId;
  $('pickerTitle').textContent = targetId ? `${nickOf(targetId)} → 교체할 방송 선택` : '방송 추가';
  $('pickerBackdrop').hidden = false;
  $('pickerSearch').value = '';
  renderPicker();
  $('pickerSearch').focus();
  if (!favorites.length) refreshFavorites(true);
}
function closePicker() {
  $('pickerBackdrop').hidden = true;
}
function choose(id) {
  closePicker();
  if (pickerTarget) replaceStream(pickerTarget, id);
  else addStream(id);
}

// message 에 link 를 주면 그 뒤에 링크를 붙인다
function renderPicker(message, link) {
  const list = $('pickerList');
  list.replaceChildren();
  if (message) {
    const msg = document.createElement('div');
    msg.className = 'picker-msg';
    msg.textContent = message;
    if (link) {
      const a = document.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.textContent = ` ${link.text}`;
      msg.append(a);
    }
    list.append(msg);
    return;
  }
  const q = $('pickerSearch').value.trim().toLowerCase();
  const items = favorites
    .filter((f) => f.isLive && !state.ids.includes(f.id))
    .filter((f) => !q || f.nick.toLowerCase().includes(q) || f.id.toLowerCase().includes(q))
    .sort((a, b) => b.viewers - a.viewers);

  if (!items.length) {
    renderPicker(favorites.length ? '고를 수 있는 방송 중인 즐겨찾기가 없어요.' : '불러오는 중…');
    return;
  }
  for (const f of items) {
    const b = document.createElement('button');
    b.className = 'pick';
    const img = document.createElement('img');
    img.src = f.thumb;
    img.onerror = () => { img.removeAttribute('src'); };
    const meta = document.createElement('div');
    meta.className = 'meta';
    const nick = document.createElement('div');
    nick.className = 'nick';
    nick.textContent = f.nick;
    const viewers = document.createElement('div');
    viewers.className = 'viewers';
    viewers.textContent = `${f.viewers.toLocaleString('ko-KR')}명`;
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = f.title;
    title.title = f.title;
    meta.append(nick, viewers, title);
    b.append(img, meta);
    b.addEventListener('click', () => choose(f.id));
    list.append(b);
  }
}

// ---------- 즐겨찾기 새로고침 (방송 종료 확인 + 고르기 창 목록) ----------
async function refreshFavorites(userAction = false) {
  const pickerOpen = () => !$('pickerBackdrop').hidden;
  let res;
  try {
    // 자동 새로고침 때는 SOOP 탭을 새로 열지 않는다 (1분마다 탭이 깜빡이지 않도록)
    res = await askExtension('getFavorites', { openTabIfNeeded: userAction });
  } catch (e) {
    if (userAction && pickerOpen()) {
      renderPicker(e.message === 'no-extension'
        ? '확장 프로그램이 없어서 즐겨찾기를 불러올 수 없어요. 아래에 아이디를 직접 입력할 수 있어요.'
        : '즐겨찾기를 불러오지 못했어요. ⟳ 를 눌러 다시 시도하세요.');
    }
    return;
  }
  if (res?.ok) {
    favorites = res.favorites;
    render();
    if (pickerOpen()) renderPicker();
  } else if (userAction && pickerOpen()) {
    if (res?.kind === 'login') renderPicker('SOOP에 먼저 로그인하세요.', { href: res.loginUrl, text: '로그인하기 ↗' });
    else renderPicker('즐겨찾기를 불러오지 못했어요. ⟳ 를 눌러 다시 시도하세요.');
  }
}

// ---------- 채팅 ----------
// SOOP 채팅 전용 화면을 열고, 확장 프로그램의 soop-frame.js 가 그 화면을 같은 방송의 플레이어 칸에 연결한다.
// 그래서 플레이어가 준비된 뒤에 채팅을 연다.
function renderChat() {
  if (!state.ids.includes(state.chatId)) state.chatId = state.ids[0] || null;
  const select = $('chatSelect');
  select.replaceChildren(...state.ids.map((id) => new Option(nickOf(id), id, false, id === state.chatId)));
  const open = !$('chat').hidden;
  const want = open && state.chatId && readyIds.has(state.chatId) ? SOOP.chatUrl(state.chatId) : 'about:blank';
  const frame = $('chatFrame');
  if (frame.src !== want) frame.src = want;
  $('chatBtn').classList.toggle('on', open);
}

// manual: 사용자가 ⟳ 를 눌렀으면 자동 재연결 횟수도 처음부터 다시 센다
function reloadChat(manual = true) {
  if (manual) chatRetries = 0;
  $('loginNotice').hidden = true;
  $('chatFrame').src = 'about:blank';
  setTimeout(renderChat, 100);
}

// ---------- 버튼 연결 ----------
document.querySelectorAll('.seg').forEach((b) => b.addEventListener('click', () => {
  state.layout = b.dataset.layout;
  savePref(LAYOUT_KEY, state.layout);
  render();
}));
$('addBtn').addEventListener('click', () => openPicker(null));
$('chatBtn').addEventListener('click', () => { $('chat').hidden = !$('chat').hidden; renderChat(); });
$('chatSelect').addEventListener('change', (e) => { state.chatId = e.target.value; chatRetries = 0; renderChat(); });
$('chatReload').addEventListener('click', () => reloadChat(true));
$('noticeReload').addEventListener('click', () => reloadChat(true));
$('backBtn').addEventListener('click', () => askExtension('openApp').catch(() => {}));
$('pickerClose').addEventListener('click', closePicker);
$('pickerBackdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) closePicker(); });
$('pickerSearch').addEventListener('input', () => renderPicker());
$('pickerRefresh').addEventListener('click', () => { favorites = []; renderPicker(); refreshFavorites(true); });
$('manualForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('manualId').value.trim().toLowerCase();
  if (!id) return;
  $('manualId').value = '';
  choose(id);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });

// 플레이어/채팅을 열기 전에 로그인 복사본부터 맞춘다 (확장 프로그램의 background.js)
async function syncLogin() {
  if (!hasExtension()) {
    $('noExtension').hidden = false;
    return;
  }
  try {
    const res = await askExtension('syncLogin');
    if (!res?.ok) console.warn('[멀티뷰] 로그인 연결 실패:', res?.error);
    else if (res.copied === 0) console.warn('[멀티뷰] SOOP 로그인 정보가 없어요. SOOP에 로그인돼 있는지 확인하세요.');
  } catch (e) {
    console.warn('[멀티뷰] 로그인 연결 실패:', e);
  }
}

readHash();
syncLogin().finally(() => {
  render();
  refreshFavorites(false);
  setInterval(() => refreshFavorites(false), REFRESH_MS);
});
