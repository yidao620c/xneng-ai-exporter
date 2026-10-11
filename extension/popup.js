const $ = s => document.querySelector(s);
let busy = false;
const VERSION = chrome.runtime.getManifest().version;

$('#log').textContent = '准备就绪（v' + VERSION + '，仅导出一个 ZIP）。导出前请先在浏览器中登录对应站点。';

function log(t) {
  const d = $('#log');
  d.textContent += '\n' + t;
  d.scrollTop = d.scrollHeight;
}

// 根据当前标签页预选平台
chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  const url = (tabs[0] && tabs[0].url) || '';
  if (url.includes('doubao.com')) $('#platform').value = 'doubao';
  else if (url.includes('chat.deepseek.com')) $('#platform').value = 'deepseek';
});

$('#export').addEventListener('click', () => {
  if (busy) return;
  const dateStart = $('#dateStart').value;
  const dateEnd = $('#dateEnd').value;
  if (dateStart && dateEnd && dateStart > dateEnd) {
    log('❌ 日期范围无效：开始日期晚于结束日期');
    return;
  }
  busy = true;
  $('#export').disabled = true;
  const platform = $('#platform').value;
  const range = (dateStart || dateEnd) ? '（' + (dateStart || '最早') + ' 至 ' + (dateEnd || '今天') + '，按更新时间）' : '（全部会话）';
  log('▶ 开始导出：' + $('#platform').selectedOptions[0].textContent.trim() + range);
  chrome.runtime.sendMessage({ type: 'EXPORT', platform, dateStart, dateEnd });
});

$('#cancel').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CANCEL' });
});

chrome.runtime.onMessage.addListener(m => {
  if (m && m.type === 'PROGRESS') {
    log(m.text);
    if (/🎉|❌|⚠️/.test(m.text)) {
      busy = false;
      $('#export').disabled = false;
    }
  }
});
