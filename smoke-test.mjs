// 纯函数冒烟测试：Node 环境直接驱动 extension/background.js 中无副作用的逻辑。
// 用法：node smoke-test.mjs
import { readFileSync } from 'node:fs';

globalThis.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    sendMessage: () => ({ catch() {} })
  },
  downloads: { download: async () => {} }
};

globalThis.__eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL ${label}\n  actual:   ${a}\n  expected: ${e}`);
    process.exitCode = 1;
  } else {
    console.log(`ok - ${label}`);
  }
};

const src = readFileSync(new URL('./extension/background.js', import.meta.url), 'utf8');

// 直接 eval 源码 + 追加测试，测试代码与源码共享同一作用域以访问内部函数。
eval(src + `
;(function () {
  const eq = globalThis.__eq;

  // deepseekMessageToParts
  const dsUser = deepseekMessageToParts({
    role: 'USER',
    fragments: [{ type: 'REQUEST', content: '你好' }, { type: 'RESPONSE', content: '不应出现' }]
  });
  eq(dsUser.role, 'user', 'deepseek 用户角色');
  eq(dsUser.text, '你好', 'deepseek 用户取 REQUEST 片段');

  const dsAssistant = deepseekMessageToParts({
    role: 'ASSISTANT',
    fragments: [
      { type: 'THINK', content: '想一想' },
      { type: 'RESPONSE', content: '回答一' },
      { type: 'RESPONSE', content: '回答二' }
    ]
  });
  eq(dsAssistant.role, 'assistant', 'deepseek 助手角色');
  eq('thought' in dsAssistant, false, 'deepseek 不导出思考过程');
  eq(dsAssistant.text, '回答一\\n\\n回答二', 'deepseek 多个 RESPONSE 合并');
  eq(deepseekMessageToParts({ role: 'SYSTEM' }), null, 'deepseek 忽略其他角色');

  // doubaoMessageToParts
  const dbUser = doubaoMessageToParts({
    user_type: 1,
    content_block: [{ content: { text_block: { text: '豆包问题' } } }]
  });
  eq(dbUser.role, 'user', 'doubao user_type=1 为用户');
  eq(dbUser.text, '豆包问题', 'doubao 取 text_block 文本');

  const dbAssistant = doubaoMessageToParts({
    user_type: 2,
    content_block: [
      { content: { text_block: { text: '思考内容' } }, block_type: 10040 },
      { content: { text_block: { text: '正式回答' } } },
      { content: { search_query_result_block: { results: [
        { text_card: { title: '参考', url: 'https://example.com/a' } }
      ] } } }
    ]
  });
  eq(dbAssistant.role, 'assistant', 'doubao user_type=2 为助手');
  eq('thought' in dbAssistant, false, 'doubao 不导出思考过程');
  eq(dbAssistant.text, '正式回答', 'doubao 最后一个文本块为正文');
  eq(dbAssistant.refs, [{ title: '参考', url: 'https://example.com/a' }], 'doubao 搜索引用提取');
  eq(doubaoMessageToParts({ user_type: 9 }), null, 'doubao 未知 user_type 忽略');

  // sanitizeName
  eq(sanitizeName('a/b:c*d?"<>|\\\\'), 'a_b_c_d_', 'sanitizeName 非法字符折叠');
  eq(sanitizeName(''), 'untitled', 'sanitizeName 空串');

  // doubaoEndpoint
  const ep = new URL(doubaoEndpoint('/im/chain/single'));
  eq(ep.pathname, '/im/chain/single', 'doubaoEndpoint 路径');
  eq(ep.searchParams.get('aid'), '497858', 'doubaoEndpoint 查询参数');
  eq(Boolean(ep.searchParams.get('web_tab_id')), true, 'doubaoEndpoint 生成 web_tab_id');

  // buildConversationMarkdown
  const md = buildConversationMarkdown('豆包', {
    id: 'c1',
    title: '测试会话',
    parts: [
      { role: 'user', text: '你好', refs: [] },
      { role: 'assistant', text: '世界', refs: [{ title: 't', url: 'https://e.com' }] }
    ]
  });
  eq(md.includes('# 测试会话'), true, 'markdown 会话标题');
  eq(md.includes('## 👤 用户'), true, 'markdown 用户小节');
  eq(md.includes('## 🤖 助手'), true, 'markdown 助手小节');
  eq(md.includes('💭'), false, 'markdown 不包含思考过程');
  eq(md.includes('[t](https://e.com)'), true, 'markdown 参考来源链接');
  eq((md.match(/## /g) || []).length, 2, 'markdown 小节数量');

  // bytesToBase64 往返与大输入分块（超过 0x8000 字节边界）
  const enc3 = new TextEncoder();
  const input = '中文导出测试 \\n emoji ✅';
  eq(Buffer.from(bytesToBase64(enc3.encode(input)), 'base64').toString('utf8'), input, 'bytesToBase64 编码往返');
  const big = enc3.encode('中'.repeat(20000));
  eq(Buffer.from(bytesToBase64(big), 'base64').toString('utf8'), new TextDecoder().decode(big), 'bytesToBase64 大输入分块');

  // crc32
  eq(crc32(new TextEncoder().encode('123456789')), 0xCBF43926, 'crc32 标准测试向量');

  // 日期范围过滤
  eq(normalizeTimeValue(1760000000), 1760000000, 'normalizeTimeValue 秒级透传');
  eq(normalizeTimeValue(1760000000123), 1760000000, 'normalizeTimeValue 毫秒转秒');
  eq(normalizeTimeValue(0), 0, 'normalizeTimeValue 零值');
  eq(normalizeTimeValue(undefined), 0, 'normalizeTimeValue 缺失');

  const s1 = dateStrToTs('2026-01-01', false);
  const e1 = dateStrToTs('2026-01-01', true);
  eq(new Date(s1 * 1000).toLocaleDateString('zh-CN'), '2026/1/1', 'dateStrToTs 当天零点');
  eq(e1 - s1, 86399, 'dateStrToTs 结束取当天 23:59:59');
  eq(dateStrToTs('', true), 0, 'dateStrToTs 空串返回 0');
  eq(dateStrToTs('bad-input', false), 0, 'dateStrToTs 非法输入返回 0');

  const start = dateStrToTs('2026-01-01', false);
  const end = dateStrToTs('2026-01-31', true);
  eq(timeInRange(dateStrToTs('2026-01-15', false), start, end), true, 'timeInRange 范围内');
  eq(timeInRange(start, start, end), true, 'timeInRange 含开始当天');
  eq(timeInRange(end, start, end), true, 'timeInRange 含结束当天');
  eq(timeInRange(dateStrToTs('2025-12-31', true), start, end), false, 'timeInRange 早于范围');
  eq(timeInRange(dateStrToTs('2026-02-01', false), start, end), false, 'timeInRange 晚于范围');
  eq(timeInRange(0, 0, 0), true, 'timeInRange 无筛选保留无时间会话');
  eq(timeInRange(0, start, end), false, 'timeInRange 有筛选丢弃无时间会话');
  eq(timeInRange(dateStrToTs('2026-01-15', false), start, 0), true, 'timeInRange 只设开始日期');
  eq(timeInRange(dateStrToTs('2025-06-15', false), start, 0), false, 'timeInRange 只设开始日期早于');
  eq(timeInRange(dateStrToTs('2026-01-15', false), 0, end), true, 'timeInRange 只设结束日期');
  eq(timeInRange(dateStrToTs('2026-06-15', false), 0, end), false, 'timeInRange 只设结束日期晚于');

  // buildZip
  const enc2 = new TextEncoder();
  const zip = buildZip([
    { name: '豆包/中文.md', bytes: enc2.encode('你好') },
    { name: 'b.md', bytes: enc2.encode('hello') }
  ]);
  eq(String.fromCharCode(zip[0], zip[1], zip[2], zip[3]), 'PK\u0003\u0004', 'zip local header 签名');
  const eocd = zip.slice(zip.length - 22);
  eq(String.fromCharCode(eocd[0], eocd[1], eocd[2], eocd[3]), 'PK\u0005\u0006', 'zip EOCD 签名');
  const dvZip = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength);
  eq(dvZip.getUint16(8, true), 2, 'zip 条目数');
  eq(dvZip.getUint16(10, true), 2, 'zip 总条目数');
  const lv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const nameLen = lv.getUint16(26, true);
  const fileSize = lv.getUint32(18, true);
  const dataStart = 30 + nameLen;
  eq(new TextDecoder().decode(zip.slice(dataStart, dataStart + fileSize)), '你好', 'zip store 内容可解回');

  console.log('全部断言通过');
})();
`);
