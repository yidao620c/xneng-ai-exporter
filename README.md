# AI 对话批量导出器

一款 Chrome 浏览器扩展（Manifest V3），一键将 **豆包** 和 **DeepSeek** 网页版中的全部会话批量导出为 Markdown 文件，打包成一个 ZIP 保存到本地下载目录。所有数据只在你自己的浏览器和电脑上处理，不上传任何服务器。

## 功能特性

- **批量导出全部会话**：自动翻页拉取账号下的所有会话，无需逐个打开。
- **双平台支持**：豆包（www.doubao.com）与 DeepSeek（chat.deepseek.com）。
- **日期范围筛选**：可选只导出某个时间段内有过更新的会话（两端均可留空）。
- **单个 ZIP 交付**：每个会话一个 Markdown，统一打包成一个 ZIP，整个导出只触发一次下载。
- **内容还原度高**：正文、用户/助手角色、搜索引用链接均会导出；思考过程按需求不导出。
- **进度可视与可取消**：弹窗内实时显示拉取进度和每条错误，随时可中断。
- **隐私安全**：请求只在目标站点页面内同源发起，使用浏览器当前登录态，不读取账号密码，不外发数据。

## 支持平台

| 平台 | 网址 | 会话列表接口 | 消息接口 |
| --- | --- | --- | --- |
| DeepSeek | https://chat.deepseek.com/ | `/api/v0/chat_session/fetch_page` | `/api/v0/chat/history_messages` |
| 豆包 | https://www.doubao.com/chat/ | `/im/chain/recent_conv` | `/im/chain/single` |

以上均为网页端非官方接口，站点改版后可能需要更新扩展。

## 环境要求

- Chrome 或 Edge 等基于 Chromium 且支持 Manifest V3 的现代浏览器。
- 在浏览器中保持目标平台已登录。

## 安装

1. 下载或克隆本仓库到本地。
2. 打开 `chrome://extensions/`，开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本仓库的 `extension/` 目录（即包含 `manifest.json` 的文件夹）。
4. 工具栏出现蓝色「AI 对话批量导出器」图标即安装成功。

> 修改扩展文件后，需要在 `chrome://extensions/` 点击扩展卡片上的刷新图标 ↻ 重新加载才会生效。弹窗日志首行会显示当前运行的版本号（如 v1.4.0），可用于确认加载的是否为新代码。

## 使用说明

### 基本流程

1. 先在浏览器中登录 [chat.deepseek.com](https://chat.deepseek.com/) 或 [www.doubao.com/chat](https://www.doubao.com/chat/)。
2. 点击工具栏扩展图标打开弹窗，确认平台选择正确（打开着对应网站时会自动预选）。
3. 可选：填写「开始 / 结束」日期筛选会话，留空则导出全部。
4. 点击「开始导出全部会话」，在日志区观察进度。
5. 完成后，ZIP 文件保存在浏览器默认下载目录的 `AI-exports/<平台>/` 文件夹中。

### 日期筛选规则

- 按**会话最近更新时间**过滤：只要会话在该时间段内有过新消息就会被导出（在范围内聊过的旧会话也算）。
- 开始、结束日期均**含当天**；两端都可以只填一个，留空表示不限。
- 筛选发生在拉取会话列表阶段，范围外的会话不会请求消息内容，节省时间。
- 因两个平台的列表都按时间倒序返回，翻页时发现整页早于开始日期会自动提前停止。

### 导出结果

ZIP 内按 `<平台>/序号-会话标题.md` 组织，例如：

```text
AI-exports/Doubao/豆包-全部会话-2026-10-11.zip
└── 豆包/
    ├── 001-帮忙写周报.md
    ├── 002-Python 异步问题.md
    └── 003-未命名会话.md
```

每份 Markdown 的格式：

```markdown
# 帮忙写周报

- 平台：豆包
- 会话 ID：7527276490371694618
- 消息数：6
- 导出时间：2026/10/11 20:30:00

## 👤 用户

帮我写一份本周工作总结

## 🤖 助手

好的，以下是本周工作总结的草稿……

**参考来源：**
1. [周报写作指南](https://example.com/article)
```

说明：

- 会话标题取自平台侧边栏显示的标题；无标题时用「会话-XXXXXX」（ID 末 6 位）。
- 序号按「最近更新在前」的顺序编号（001 为最新）。
- 助手回复中的搜索引用会整理成消息末尾的「参考来源」链接列表。
- 思考过程（深度思考内容）不导出。

## 工作原理

### 总体架构

```text
弹窗 popup ──点击导出──> 后台 Service Worker
                            │  复用或静默打开目标站点标签页
                            ▼
                    站点页面内中转 fetch（同源）
                            │  携带浏览器登录态
                            ▼
                    平台网页端接口（会话列表 + 消息分页）
                            │
                            ▼
                    生成 Markdown → 打包 ZIP → chrome.downloads 保存
```

扩展**不直接**从后台跨域请求平台接口，而是通过 `chrome.scripting` 在目标站点标签页的页面上下文中发起同源 fetch。这样请求的 Origin、Cookie、登录态与网页本身完全一致，是参考实现中被验证可行的路径。若浏览器中没有打开目标站点，扩展会自动在后台静默开一个标签页。

### 各平台细节

**DeepSeek**

- 认证：从页面 localStorage 读取 `userToken`，以 Bearer 方式附带（同时携带 Cookie）。
- 会话列表：`GET /api/v0/chat_session/fetch_page`，按 `updated_at` 游标翻页，读取 `data.biz_data.chat_sessions`。
- 会话消息：`GET /api/v0/chat/history_messages?chat_session_id=<id>`，读取 `data.biz_data.chat_messages`。
- 消息解析：`role` 为 USER/ASSISTANT 区分角色；用户消息取 `REQUEST` 片段，助手消息取 `RESPONSE` 片段（`THINK` 思考片段忽略）。

**豆包**

- 会话列表：`POST /im/chain/recent_conv`（cmd 3200），按 `next_conv_version` 游标翻页，读取 `downlink_body.pull_recent_conv_chain_downlink_body.cells`，每项含 `conversation_id / name / update_time`。
- 会话消息：`POST /im/chain/single`（cmd 3100），锚点从 `Number.MAX_SAFE_INTEGER` 开始按 `index_in_conv` 递减往回翻页，按 `message_id` 去重。
- 消息解析：`user_type` 1/2 区分用户/助手；正文取 `content_block[].content.text_block.text`；检测到思考块时只取最后一个文本块作为正文（前面的属于思考过程）；搜索引用取 `search_query_result_block` 内的卡片标题和 URL。
- 请求体中的 `pull_singe_chain` 拼写（singe 而非 single）是豆包接口的真实拼写，非笔误。

### ZIP 打包

为零依赖生成 ZIP，扩展内置了一个 store 模式（不压缩）的打包器：手写 local file header + central directory + EOCD，CRC32 校验，文件名带 UTF-8 标志。中文文件名、中文内容、大文件均已通过 Windows `Expand-Archive` 实测解压验证。

## 权限说明

| 权限 | 用途 |
| --- | --- | --- |
| `downloads` | 将 ZIP 保存到下载目录 |
| `scripting` | 在目标站点标签页内注入同源请求中转函数 |
| `tabs` | 查找/打开目标站点标签页，并根据当前页面预选平台 |
| `host_permissions`（两个站点） | 允许向豆包与 DeepSeek 发起请求 |

扩展不申请「读取所有网站数据」类权限，不读取账号密码，不内置、不保存 Cookie 或 Token 明文，不把任何对话内容发送到开发者服务器。

## 项目结构

```text
xneng-ai-exporter/
├── README.md               # 本文档
├── 需求说明书.md            # 原始需求
├── generate-icons.ps1      # 图标生成脚本（GDI+ 绘制，可改参数重新生成）
├── smoke-test.mjs          # 纯函数冒烟测试（Node 运行）
└── extension/              # 扩展本体（加载此目录）
    ├── manifest.json       # MV3 配置
    ├── background.js       # 核心逻辑：请求中转、翻页、解析、Markdown、ZIP、下载
    ├── popup.html          # 弹窗界面（内联样式）
    ├── popup.js            # 弹窗交互与日志
    ├── README.md           # 指向本文档的简版说明
    └── icons/              # 16/32/48/128 图标
```

## 开发与测试

```powershell
# 语法与 JSON 校验
node --check extension/background.js
node --check extension/popup.js
node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8'))"

# 冒烟测试（50 条断言：消息解析、日期过滤、Markdown、ZIP 结构、CRC32 等）
node smoke-test.mjs

# 重新生成图标（输出到 extension/icons/）
powershell -NoProfile -ExecutionPolicy Bypass -File generate-icons.ps1
```

接口请求与真实登录态相关的部分无法在 Node 中测试，需在浏览器中实际导出验证。

## 常见问题

**Q：每次下载都弹出保存窗口？**
扩展调用下载 API 时已指定 `saveAs: false` 并固定保存路径；若仍弹窗，是浏览器开启了「下载前询问每个文件的保存位置」（chrome://settings/downloads）。当前版本整个导出只下载一个 ZIP，最多弹一次；想完全静默可关闭该浏览器设置。

**Q：报「登录态失效 / 接口返回非 JSON」？**
先在浏览器中打开对应站点确认已登录且能正常对话，然后重试。若登录正常仍持续报错，说明站点接口结构变更，可依据弹窗日志中的 HTTP 状态与响应片段定位。

**Q：报「未获取到任何会话」？**
确认导出的平台与登录账号一致（例如浏览器登录的是 DeepSeek 但选了豆包），以及账号下确实存在会话。

**Q：为什么导出内容里没有思考过程？**
按需求设计，思考过程不导出；助手回复只保留最终正文和搜索引用。

**Q：豆包智能体（bot）会话能导出吗？**
当前以 `recent_conv` 返回的常规会话为主，智能体会话是否包含取决于账号数据结构，属已知边界。

**Q：导出会触发平台风控吗？**
扩展按顺序逐个请求并带有间隔（每页 250–400ms），节奏接近正常浏览。但批量拉取本质上仍是高频操作，会话量特别大时建议分段（用日期筛选）导出。

## 已知边界

- 只能导出当前账号可见的内容。
- 富媒体内容（图片、文件、语音等）不下载附件，只导出可提取的文本与链接。
- 两个平台的接口均为网页端非官方接口，站点改版后可能失效，需要更新扩展。
- 接口时间字段若缺失，设置了日期筛选时该会话会被跳过（宁缺勿滥）。

## 免责声明

本扩展不是豆包、DeepSeek 或字节跳动、深度求索的官方产品，也未获得任何官方授权或背书。接口参数参考 doubao-helper、AfterChat 等开源实现验证整理。请只导出你自己有权访问和保存的内容，导出结果仅供个人备份与学习使用，请遵守各平台服务条款。
