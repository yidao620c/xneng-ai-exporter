// AI 对话批量导出器 — Service Worker
// 接口请求通过目标站点标签页内的 content-script 上下文中转（同源 + 当前登录态），不上传任何数据。

const state = { running: false, cancel: false };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function checkCancel() { if (state.cancel) throw new Error('已取消导出'); }
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
}
function progress(text) {
  try { chrome.runtime.sendMessage({ type: 'PROGRESS', text }).catch(() => {}); } catch (e) {}
}

/* ---------------- 日期范围过滤 ---------------- */

// 时间戳归一化为秒（毫秒时间戳自动转换）
function normalizeTimeValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

// 'YYYY-MM-DD' → 本地时间秒级时间戳；endOfDay 为 true 时取当天 23:59:59
function dateStrToTs(dateStr, endOfDay) {
  if (!dateStr) return 0;
  const parts = String(dateStr).split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return 0;
  const d = endOfDay
    ? new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999)
    : new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// ts 为归一化后的秒；无时间信息时仅在未设置筛选的情况下保留
function timeInRange(ts, startTs, endTs) {
  if (!ts) return !(startTs || endTs);
  if (startTs && ts < startTs) return false;
  if (endTs && ts > endTs) return false;
  return true;
}

/* ---------------- 页面内中转请求 ---------------- */

// 在目标站点标签页里执行同源 fetch（函数会被序列化注入，不能引用外部作用域）
function pageRelay(url, bodyStr, authMode) {
  return (async () => {
    const headers = { 'accept': 'application/json, text/plain, */*' };
    if (bodyStr !== null) headers['content-type'] = 'application/json; encoding=utf-8';
    if (authMode === 'doubao') headers['agw-js-conv'] = 'str';
    if (authMode === 'deepseek') {
      try {
        const t = JSON.parse(localStorage.getItem('userToken') || 'null');
        if (t && t.value) {
          headers['authorization'] = 'Bearer ' + t.value;
          headers['x-client-platform'] = 'web';
          headers['x-client-version'] = '2.2.0';
        }
      } catch (e) { /* 未登录时走 cookie */ }
    }
    const resp = await fetch(url, {
      method: bodyStr !== null ? 'POST' : 'GET',
      credentials: 'include',
      headers,
      body: bodyStr !== null ? bodyStr : undefined
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 保留 textHead 用于报错 */ }
    return { status: resp.status, ok: resp.ok, json, textHead: text.slice(0, 300) };
  })();
}

async function relayJSON(tabId, url, body, authMode) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageRelay,
      args: [url, body == null ? null : JSON.stringify(body), authMode]
    });
  } catch (e) {
    throw new Error('页面请求注入失败：' + (e && e.message || e));
  }
  const r = results && results[0] && results[0].result;
  if (!r) throw new Error('页面请求无返回：' + url);
  if (r.status === 401 || r.status === 403) {
    throw new Error('登录态失效（HTTP ' + r.status + '），请先在浏览器中登录对应站点');
  }
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url + ' ' + (r.textHead || ''));
  if (!r.json) throw new Error('接口返回非 JSON：' + url + ' ' + (r.textHead || ''));
  if (r.json.status_code !== undefined && r.json.status_code !== 0) {
    throw new Error('接口错误 ' + r.json.status_code + '：' + (r.json.status_desc || r.json.status_msg || url));
  }
  return r.json;
}

async function getSiteTab(urlPattern, homeUrl) {
  const tabs = await chrome.tabs.query({ url: urlPattern });
  let tab = tabs.find(t => t.status === 'complete') || tabs[0];
  if (!tab) {
    progress('🌐 正在后台打开 ' + homeUrl);
    tab = await chrome.tabs.create({ url: homeUrl, active: false });
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tab.id);
    if (t.status === 'complete') return t;
    await sleep(500);
  }
  throw new Error('页面加载超时：' + homeUrl);
}

/* ---------------- DeepSeek ---------------- */

async function listDeepSeekConversations(tabId, filter) {
  const sessions = [];
  const seen = new Set();
  let cursor = '';
  let guard = 0;
  while (guard++ < 500) {
    checkCancel();
    const url = cursor
      ? 'https://chat.deepseek.com/api/v0/chat_session/fetch_page?lte_cursor.pinned=false&lte_cursor.updated_at=' + encodeURIComponent(cursor)
      : 'https://chat.deepseek.com/api/v0/chat_session/fetch_page';
    const json = await relayJSON(tabId, url, null, 'deepseek');
    const biz = json && json.data && json.data.biz_data;
    const list = (biz && biz.chat_sessions) || [];
    if (!list.length) break;
    let added = 0;
    for (const s of list) {
      if (!s.id || seen.has(String(s.id))) continue;
      if (!timeInRange(normalizeTimeValue(s.updated_at), filter.startTs, filter.endTs)) continue;
      seen.add(s.id);
      sessions.push({ id: String(s.id), title: (s.title || '').trim() || '未命名会话' });
      added++;
    }
    progress('DeepSeek：已获取 ' + sessions.length + ' 个会话');
    const pageMax = Math.max(0, ...list.map(s => normalizeTimeValue(s.updated_at)));
    if (filter.startTs && pageMax && pageMax < filter.startTs) break; // 列表按时间倒序，整页早于开始日期即止
    if (!biz || !biz.has_more) break;
    if (!added && !(filter.startTs || filter.endTs)) break;
    cursor = String(list[list.length - 1].updated_at);
    await sleep(400);
  }
  return sessions;
}

async function fetchDeepSeekMessages(tabId, sessionId) {
  const url = 'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=' +
    encodeURIComponent(sessionId);
  const json = await relayJSON(tabId, url, null, 'deepseek');
  const biz = (json && json.data && json.data.biz_data) || {};
  const raw = Array.isArray(biz.chat_messages) ? biz.chat_messages : [];
  const parts = [];
  for (const m of raw) {
    const p = deepseekMessageToParts(m);
    if (p) parts.push(p);
  }
  return parts;
}

function deepseekMessageToParts(m) {
  const frags = Array.isArray(m.fragments) ? m.fragments : [];
  if (m.role === 'USER') {
    const f = frags.find(x => x.type === 'REQUEST');
    const text = String((f && f.content) || m.content || '').trim();
    return { role: 'user', text, refs: [] };
  }
  if (m.role === 'ASSISTANT') {
    const text = frags.filter(x => x.type === 'RESPONSE' && x.content)
      .map(x => String(x.content).trim()).join('\n\n');
    return { role: 'assistant', text, refs: [] };
  }
  return null;
}

/* ---------------- 豆包 ---------------- */

function doubaoEndpoint(path) {
  const p = new URLSearchParams({
    version_code: '20800',
    language: 'zh',
    device_platform: 'web',
    doubao_device_platform: 'web',
    aid: '497858',
    real_aid: '497858',
    pkg_type: 'release_version',
    pc_version: '3.29.13',
    doubao_pc_version: '3.29.13',
    region: 'CN',
    sys_region: 'CN',
    samantha_web: '1',
    web_platform: 'browser',
    'use-olympus-account': '1',
    web_tab_id: uuid()
  });
  return 'https://www.doubao.com' + path + '?' + p.toString();
}

async function listDoubaoConversations(tabId, filter) {
  const convs = [];
  const seen = new Set();
  let convVersion = 0;
  let guard = 0;
  while (guard++ < 500) {
    checkCancel();
    const isFirst = convVersion === 0;
    const body = {
      cmd: 3200,
      uplink_body: {
        pull_recent_conv_chain_uplink_body: {
          limit: 20,
          message_count_per_conv: 10,
          api_version: 1,
          conv_version: convVersion,
          direction: isFirst ? 3 : 1,
          option: {
            not_need_message: true,
            need_complete_conversation: true,
            need_coco_conversation: isFirst,
            need_coco_bot: isFirst,
            need_pc_pin_chain: true,
            pc_pin_query_type: 0
          }
        }
      },
      sequence_id: uuid(),
      channel: 2,
      version: '1'
    };
    const json = await relayJSON(tabId, doubaoEndpoint('/im/chain/recent_conv'), body, 'doubao');
    const dl = (json && json.downlink_body) || {};
    const b = dl.pull_recent_conv_chain_downlink_body || {};
    const cells = Array.isArray(b.cells) ? b.cells : [];
    if (!cells.length) break;
    let added = 0;
    for (const cell of cells) {
      const conv = (cell && cell.conversation) || {};
      const id = conv.conversation_id || (cell && cell.id);
      if (!id || seen.has(String(id))) continue;
      const convTime = normalizeTimeValue(conv.update_time || conv.create_time);
      if (!timeInRange(convTime, filter.startTs, filter.endTs)) continue;
      seen.add(String(id));
      const name = String(conv.name || '').trim();
      convs.push({
        id: String(id),
        title: name || ('会话-' + String(id).slice(-6)),
        updateTime: conv.update_time || 0
      });
      added++;
    }
    progress('豆包：已获取 ' + convs.length + ' 个会话');
    const pageMax = Math.max(0, ...cells.map(cell => {
      const c = (cell && cell.conversation) || {};
      return normalizeTimeValue(c.update_time || c.create_time);
    }));
    if (filter.startTs && pageMax && pageMax < filter.startTs) break; // 列表按时间倒序，整页早于开始日期即止
    if (!b.has_more || !b.next_conv_version) break;
    if (!added && !(filter.startTs || filter.endTs)) break;
    convVersion = Number(b.next_conv_version) || 0;
    if (!convVersion) break;
    await sleep(400);
  }
  return convs;
}

async function fetchDoubaoMessages(tabId, convId) {
  const messages = [];
  const seen = new Set();
  let anchor = 9007199254740991; // Number.MAX_SAFE_INTEGER，从最新往回翻
  let guard = 0;
  while (guard++ < 2000) {
    checkCancel();
    const body = {
      cmd: 3100,
      uplink_body: {
        pull_singe_chain_uplink_body: { // "singe" 是豆包接口的官方拼写
          conversation_id: convId,
          anchor_index: anchor,
          conversation_type: 3,
          direction: 1,
          limit: 50,
          ext: {},
          filter: { index_list: [] },
          evaluate_ab_params: '',
          evaluate_common_params: ''
        }
      },
      sequence_id: uuid(),
      channel: 2,
      version: '1'
    };
    const json = await relayJSON(tabId, doubaoEndpoint('/im/chain/single'), body, 'doubao');
    const dl = (json && json.downlink_body) || {};
    const b = dl.pull_singe_chain_downlink_body || dl.pull_single_chain_downlink_body || {};
    const batch = Array.isArray(b.messages) ? b.messages : [];
    if (!batch.length) break;
    let minIndex = Infinity;
    let added = 0;
    for (const msg of batch) {
      const idx = Number(msg && msg.index_in_conv);
      if (Number.isFinite(idx)) minIndex = Math.min(minIndex, idx);
      if (!msg || !msg.message_id || seen.has(msg.message_id)) continue;
      seen.add(msg.message_id);
      messages.push(msg);
      added++;
    }
    if (!b.has_more || !added || !Number.isFinite(minIndex) || minIndex <= 1) break;
    anchor = minIndex - 1;
    await sleep(300);
  }
  messages.sort((a, b2) => (Number(a.index_in_conv) || 0) - (Number(b2.index_in_conv) || 0));
  const parts = [];
  for (const m of messages) {
    const p = doubaoMessageToParts(m);
    if (p) parts.push(p);
  }
  return parts;
}

function doubaoMessageToParts(m) {
  const ut = String(m.user_type);
  const role = ut === '1' ? 'user' : ut === '2' ? 'assistant' : null;
  if (!role) return null;
  const blocks = Array.isArray(m.content_block) ? m.content_block : [];
  const textBlocks = blocks
    .filter(b => b && b.content && b.content.text_block)
    .map(b => String(b.content.text_block.text || '').trim())
    .filter(Boolean);
  const refs = [];
  for (const b of blocks) {
    const results = (b && b.content && b.content.search_query_result_block && b.content.search_query_result_block.results) || [];
    for (const r of results) {
      const card = (r && (r.text_card || r.image_card || r.video_card)) || null;
      if (card && card.url) refs.push({ title: card.title || card.url, url: card.url });
    }
  }
  // 思考块存在时，正文只取最后一个文本块（前面的文本块属于思考过程，不导出）
  const hasThinking = blocks.some(b =>
    (b && b.content && b.content.thinking_block) || (b && b.block_type === 10040));
  const text = (role === 'assistant' && hasThinking && textBlocks.length > 1)
    ? textBlocks[textBlocks.length - 1]
    : textBlocks.join('\n\n').trim();
  if (!text && typeof m.content === 'string') text = m.content.trim();
  return { role, text, refs };
}

/* ---------------- Markdown 生成与下载 ---------------- */

function sanitizeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').slice(0, 60) || 'untitled';
}

function buildConversationMarkdown(platformLabel, conv) {
  const lines = [];
  lines.push('# ' + (conv.title || '未命名会话'), '');
  lines.push('- 平台：' + platformLabel);
  lines.push('- 会话 ID：' + conv.id);
  lines.push('- 消息数：' + conv.parts.length);
  lines.push('- 导出时间：' + new Date().toLocaleString('zh-CN'), '');
  for (const p of conv.parts) {
    if (!p.text) continue;
    lines.push(p.role === 'user' ? '## 👤 用户' : '## 🤖 助手', '');
    if (p.text) {
      lines.push(p.text, '');
    }
    if (p.refs && p.refs.length) {
      lines.push('**参考来源：**');
      p.refs.forEach((r, i) => lines.push((i + 1) + '. [' + r.title + '](' + r.url + ')'));
      lines.push('');
    }
  }
  return lines.join('\n');
}

function bytesToBase64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

async function downloadBytes(filename, bytes, mime) {
  const url = 'data:' + mime + ';charset=utf-8;base64,' + bytesToBase64(bytes);
  await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
  await sleep(150);
}

/* ---------------- ZIP 打包（无压缩，store 模式） ---------------- */

function crc32(bytes) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

function concatBytes(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) { out.set(a, pos); pos += a.length; }
  return out;
}

function buildZip(files) { // files: [{name: string, bytes: Uint8Array}]
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);  // local file header signature
    dv.setUint16(4, 20, true);          // version needed
    dv.setUint16(6, 0x0800, true);      // flags: UTF-8 文件名
    dv.setUint16(8, 0, true);           // method: store
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, f.bytes.length, true);
    dv.setUint32(22, f.bytes.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);          // extra length
    local.set(nameBytes, 30);
    chunks.push(local, f.bytes);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);  // central directory header signature
    cv.setUint16(4, 20, true);          // version made by
    cv.setUint16(6, 20, true);          // version needed
    cv.setUint16(8, 0x0800, true);      // flags: UTF-8
    cv.setUint16(10, 0, true);          // method: store
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.bytes.length, true);
    cv.setUint32(24, f.bytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);          // extra
    cv.setUint16(32, 0, true);          // comment
    cv.setUint16(34, 0, true);          // disk number
    cv.setUint16(36, 0, true);          // internal attrs
    cv.setUint32(38, 0, true);          // external attrs
    cv.setUint32(42, offset, true);     // local header offset
    cen.set(nameBytes, 46);
    central.push(cen);

    offset += local.length + f.bytes.length;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);    // EOCD signature
  ev.setUint16(8, files.length, true);  // entries on this disk
  ev.setUint16(10, files.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);       // central directory offset
  return concatBytes([...chunks, ...central, end]);
}

/* ---------------- 导出流程 ---------------- */

async function runExport(platform, filter) {
  if (state.running) throw new Error('已有导出任务在进行中');
  state.running = true;
  state.cancel = false;
  try {
    progress('🗜 每会话一个 Markdown，打包为一个 ZIP');
    let convs = [];
    let folderName, platformLabel;

    if (platform === 'deepseek') {
      platformLabel = 'DeepSeek';
      folderName = 'AI-exports/DeepSeek';
      const tab = await getSiteTab('https://chat.deepseek.com/*', 'https://chat.deepseek.com/');
      const sessions = await listDeepSeekConversations(tab.id, filter);
      if (!sessions.length) { progress('⚠️ 未获取到任何会话，请确认已登录 DeepSeek'); return; }
      let i = 0;
      for (const s of sessions) {
        checkCancel();
        i++;
        const parts = await fetchDeepSeekMessages(tab.id, s.id);
        convs.push({ id: s.id, title: s.title, parts });
        progress('(' + i + '/' + sessions.length + ') ' + s.title + ' · ' + parts.length + ' 条消息');
      }
    } else {
      platformLabel = '豆包';
      folderName = 'AI-exports/Doubao';
      const tab = await getSiteTab('https://www.doubao.com/*', 'https://www.doubao.com/chat/');
      const list = await listDoubaoConversations(tab.id, filter);
      if (!list.length) { progress('⚠️ 未获取到任何会话，请确认已登录豆包'); return; }
      let i = 0;
      for (const c of list) {
        checkCancel();
        i++;
        const parts = await fetchDoubaoMessages(tab.id, c.id);
        convs.push({ id: c.id, title: c.title, parts });
        progress('(' + i + '/' + list.length + ') ' + c.title + ' · ' + parts.length + ' 条消息');
      }
    }

    if (!convs.length) { progress('⚠️ 未获取到任何会话内容'); return; }
    progress('✅ 共 ' + convs.length + ' 个会话，正在生成 Markdown…');
    const enc = new TextEncoder();
    const files = convs.map((c, i) => ({
      name: platformLabel + '/' + String(i + 1).padStart(3, '0') + '-' + sanitizeName(c.title) + '.md',
      bytes: enc.encode(buildConversationMarkdown(platformLabel, c))
    }));
    const day = new Date().toISOString().slice(0, 10);
    await downloadBytes(folderName + '/' + platformLabel + '-全部会话-' + day + '.zip',
      buildZip(files), 'application/zip');
    progress('🎉 导出完成，ZIP 已保存到下载目录的 ' + folderName + ' 文件夹');
  } finally {
    state.running = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'EXPORT') {
    const startTs = dateStrToTs(msg.dateStart, false);
    const endTs = dateStrToTs(msg.dateEnd, true);
    if (startTs && endTs && startTs > endTs) {
      progress('❌ 日期范围无效：开始日期晚于结束日期');
    } else {
      runExport(msg.platform, { startTs, endTs }).catch(e => progress('❌ ' + (e && e.message || e)));
    }
    sendResponse({ ok: true });
  } else if (msg && msg.type === 'CANCEL') {
    state.cancel = true;
    progress('⏹ 已请求取消，正在等待当前请求结束…');
  }
  return false;
});
