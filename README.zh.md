# dsh-github-projects

**v0.4.1** · 把当前会话绑定的 GitHub Project 和 Issue，放进 DSH 会话头部的两个页签。

这个 DSH 插件向会话头部追加两个视图：`projects` 以**泳道看板**（默认）展示绑定到**工作区**的
GitHub Project，可切换列表视图并支持 milestone 过滤；`issue` 展示绑定到**会话**的 Issue，并在会话
标题下显示一行 **Issue 副标题**（v0.4.1 起左侧栏会话列表的会话行标题下也会显示）。点卡片会用 DSH 内置右侧浏览器打开 GitHub（不再直接绑定），绑定由
显式「绑定」按钮或 3 个 agent 工具完成。对 GitHub 全程只读——它是查看面板，不是写入工具。

```
会话头部： [ 对话 ] [ 轨迹 ] [ projects ] [ issue ] [ … ]
```

> 第三方插件，非 DeepSeek / DeepSeek Harness 官方组件。

![会话头部的 projects 与 issue 页签](artifacts/screenshots/01-tabs.png)

## 工作方式

绑定分两层，对应 GitHub 上下文真实的两种粒度：

| 层级 | 绑定到 | 从哪里选 | 持久化 |
|---|---|---|---|
| Project | 一个**工作区**（该工作区的所有会话共享） | `projects` 页签 → Project 选择器 | DSH profile 内的 `state.json` |
| Issue | 一个**会话** | 卡片/行的「绑定」按钮、**agent 工具**，或在 `issue` 页签粘贴链接 | DSH profile 内的 `state.json` |

`projects` 页签一次读取 `GET /items`，在前端完成所有派生：按 Projects v2 的 `Status` 字段分成泳道列、
按 `milestone` 字段生成过滤选项、文本/状态筛选与计数；不额外调用 GitHub。**点卡片主体或列表行**
会在 DSH 内置右侧浏览器打开 GitHub 页面（不改变绑定）；点**显式的「绑定」按钮**才会把 Issue 绑到
当前会话、切到 `issue` 页签并在会话标题下显示副标题。两个页签都是追加的：停用插件后会话头部完全
恢复原样。

所有 GitHub 读取都通过你本机已登录的 [`gh` CLI](https://cli.github.com/) 完成。插件不保存 token、
不上报遥测、也不直接访问 GitHub。

## 0.4.1 新特性：副标题同时出现在左侧会话列表

- **左侧栏的每个已绑定会话行**（无论是否选中、属于哪个工作区）都会在标题下显示与头部一致的
  Issue 副标题：`#N`（tint chip）+ Issue 标题，单行省略，tooltip 带完整 `repo#N title`。有副标题的
  行从 32px 变为约 41px 的两行（≥40px），第一行（状态点、标题、时间、pin、操作）保持不变。
- 点侧栏副标题在 **DSH 内置右侧浏览器**打开 Issue，**不会切换当前选中的会话**。
- 绑定变化（包括 agent 工具的 bind/switch/unbind）通过新增的本地 `GET /bindings`（约 4s 轮询 +
  `binding-changed` 事件立即刷新）在 **≤4s** 内反映到侧栏，不需要重新展开会话树，也不调用 `gh`。
- 诚实说明：出厂侧栏没有 subtitle slot，客户端用受控 DOM decorator（`[data-row-key^="session:"]`
  行锚点 + `:has()` 行高覆盖 + `MutationObserver` 扫描）注入第二行；宿主结构变化时自动降级为
  不显示，不报错、不影响会话行本身。

## 0.4.0 新特性：会话 Issue 副标题、Agent 工具、内置浏览器打开与更快读取

- **会话 Issue 副标题。** 已绑定 Issue 的会话在标题下显示 `#N`（tint chip）+ Issue 标题，单行省略，
  `title` 属性带完整 `repo#N title`；点击在内置右侧浏览器打开 GitHub。agent 工具改绑后约 4 秒内
  自动更新，插件自身的绑定/解绑则立即更新。
- **点击=内置浏览器，绑定=显式按钮。** 点 Issue/PR 卡片或列表行现在在 DSH 右侧栏浏览器打开 GitHub
  页面（与普通链接使用同一个浏览器 tab），不再直接绑定；要绑定请点卡片/行上的「绑定」按钮，绑定后
  跳到 `issue` 页签。PR/Draft 行只有查看动作。
- **Agent 工具。** 模型可以用 `github_issue_bind` / `github_issue_switch` / `github_issue_unbind`
  管理**当前会话**的 Issue 绑定（参数为 Issue URL 或 `owner/repo#123`）。工具只作用于当前会话、
  不写 GitHub，界面在 ≤4s 内反映变化。示例：「把 https://github.com/acme/web/issues/228 绑定到
  当前会话」「当前会话换成 acme/web#240」「解除当前会话的 Issue 绑定」。
- **读取更快。** `/projects` 改为单次 GraphQL（约 1.4s，旧 ~3.1s）；`/items` 用分页 GraphQL
  （冷启动约 3.4s，旧 ~4.6s，且不再单独调用 project view）；宿主 SWR 立即返回旧数据并后台刷新
  （`staleTtlMs` 10 分钟）、磁盘缓存跨重启；`/config` 不等 `gh`；warm 打开 projects **无骨架**
  （宿主响应 <300ms，由 e2e `projects-warm` 门禁保证）。

## 0.3.0 新特性：状态配色与视觉层次 + 空 No status 泳道自动隐藏

- **一套真正的状态配色。** 泳道、列表段、类型图标与 `issue` 页使用明确的调色板：`No status`
  中性、`TODO` 蓝、`In Progress` 琥珀、`In Review` 紫、`Done` 绿、自定义状态青；Issue 绿、PR 紫、
  Draft 中性；绑定/选中使用品牌强调色。tint 用 `color-mix` 生成，DSH 浅色与深色主题都成立，
  不写死深色背景。
- **颜色只编码状态，不做装饰。** 饱和色只用于状态/类型/绑定/主操作；标题、元信息、标签文字与正文
  保持中性主题色（不给正文上彩色，也不存在只靠颜色传递的信息——每个彩色圆点旁边都有文字标签）。
- **空 `No status` 泳道自动隐藏。** 过滤后 `No status` 计数为 0 时不再占一列；其余四个规范列始终
  显示（空列显示「无条目」），自定义状态列只在有条目时出现。被隐藏的规范列键可通过
  `data-ghp-hidden-lanes` 读取。
- **浅色与深色都成立。** accent 与主题无关，所有 tint 都用 `color-mix` 从当前 DSH 主题派生；浅色主题同样保持可读层级（已用 CDP probe 检查：tint/hairline/色点在浅色下可读、无深色面渗漏；probe 文件仅作证据、不随包发布；自动 harness 只跑深色）。
- **层级整理。** 泳道头加状态色 hairline 与 tint 计数 pill；卡片改为 sunken 泳道上的 raised 卡片；
  工具栏项目 icon 使用品牌 tint；空态/错误态使用 tint 图标块。动效仅 120ms 颜色/边框过渡，并尊重
  `prefers-reduced-motion`。

## 0.2.1（v1.1.1）新特性：全宽自适应

- `projects` 页（泳道与列表）和 `issue` 页现在**铺满会话主体宽度**：`width: 100%`、**无 `max-width`
  上限**、不做居中固定列。宽屏 Desktop 窗口下五列泳道均分整个可用宽度，不再被挤在约 1000px 的居中
  一列里（修复 v1.1 的页面宽度缺陷）。
- 176px 的列最小宽度只是**横向滚动的下限**（窗口窄于约 960px 时出现横向滚动），不是页面宽度上限。
  空态文案本身可以保留可读宽度，但页面不再是窄列。
- 回归门禁：新增 e2e `projects-wide` 阶段，在 2200×1300 下断言页面宽度 ≥ body 的 85%
  → `artifacts/screenshots/11-projects-wide.png`。

## 0.2.0（v1.1）新特性

- **泳道看板（默认视图）。** 固定五列，从左到右 `No status` / `TODO` / `In Progress` / `In Review` /
  `Done`。Project 自定义的其它 Status 不会被丢弃，会追加到最右侧成为额外列。列头显示当前过滤后的
  卡片数；每列内部纵向滚动，列宽不够时看板整体横向滚动。只读：不支持拖拽。
- **列表视图。** 工具栏「泳道 / 列表」随时切回原来的分组布局（按状态分段 + 状态 chips）。
- **Milestone 过滤。** `全部` / `Backlog`（无 milestone）/ 已加载条目中出现的每个 milestone 标题，
  自然排序并带计数；与文本筛选叠加，刷新后所选 milestone 消失时自动回退 `全部` 并提示。
- **整卡操作。** Issue 卡片点击即绑定到当前会话（等价列表「绑定」）；PR/Draft 卡片打开 GitHub；
  卡片支持键盘操作。

## 界面

| | |
|---|---|
| ![projects 未绑定空态](artifacts/screenshots/02-projects-empty.png) | ![Project 选择器](artifacts/screenshots/03-projects-picker.png) |
| 未绑定工作区：选择一个 Project | 选择器：按 owner 分组、可过滤 |
| ![泳道看板](artifacts/screenshots/04-projects-board.png) | ![列表视图](artifacts/screenshots/05-projects-list.png) |
| 真实项目 #9：状态配色；空 No status 泳道自动隐藏（4 条泳道：TODO 27 / In Progress 1 / In Review 1 / Done 166，共 195） | 列表视图：状态色分组段 + 状态 chips |
| ![milestone 过滤](artifacts/screenshots/06-projects-milestone.png) | ![Issue 未绑定空态](artifacts/screenshots/07-issue-empty.png) |
| milestone `v1.2.0` 筛选生效（195→19），No status 保持隐藏 | 未绑定会话：从项目选择或粘贴链接 |
| ![Issue 详情](artifacts/screenshots/08-issue-detail.png) | ![Issue 评论区](artifacts/screenshots/09-issue-comments.png) |
| 已绑定 Issue：绿色 Open 徽章、吸顶头部、正文、标签 | 评论：作者、相对时间与 GitHub 链接 |
| ![宽窗口全宽布局](artifacts/screenshots/11-projects-wide.png) | |
| 宽窗口（2200×1300）：页面铺满会话区域（旧 1000px 居上限宽已修复） | |
| ![内置浏览器打开](artifacts/screenshots/12-browser-open.png) | ![Issue 副标题](artifacts/screenshots/13-issue-subtitle.png) |
| 点 Issue 卡片正文在内置右侧浏览器打开 GitHub，**不创建绑定**。Web 版用 iframe，github.com 的 `X-Frame-Options: DENY` 会拒绝内嵌（空白 pane，地址栏 URL 正确）；Desktop 版 Electron webview 正常渲染。绑定请用卡片上的「绑定」按钮 | 已绑定会话标题下显示 `#N` chip + Issue 标题（单行省略，tooltip 带全文，点击打开内置浏览器） |
| ![侧栏会话行副标题](artifacts/screenshots/14-sidebar-subtitle.png) | |
| 左侧栏已绑定会话行：标题下第二行 `#240` chip + Issue 标题（行高 32→41px）；绑定变化经 `/bindings` 约 4s 轮询/绑定事件同步；点击打开内置浏览器、不改变选中会话 | |

截图 01–09、12–14 由隔离 e2e 在 **real 模式**下对真实 `gh` 采集（真实 Project #9 与 Issue #240；
1280×800；`09` 需 `--extra-comments`）；`13` 是会话头部副标题、`14` 是左侧栏会话行副标题。`11-projects-wide.png` 是 harness 在 **2200×1300** 下采集的
全宽布局证据。`10-desktop-tabs.png` 不同：它是 v0.4.1 重装后**真实 Desktop 应用**的 2560×1370
全窗口手动截图（sha256 `5347164c…8226`），左侧栏两个已绑定会话行各显示第二行 `#240 [v1.2.0]…`
副标题，打开会话的头部也显示同一副标题，另有四个页签。截图在 agent 工具绑定期间拍摄（测试绑定随后
解绑，用户自己的绑定保留）：

![安装后 Desktop 会话头部](artifacts/screenshots/10-desktop-tabs.png)

## 前置条件

- **DeepSeek Harness 0.2.1-rc.3**（Web 或 Desktop；这是唯一实测版本，见[兼容性](#兼容性)）。
  插件依赖 `conversation.view` slot 与会话标准 props，这些是宿主 API，DSH 升级后可能变化。
- **GitHub CLI（`gh`）**——需要支持 GitHub Projects v2 JSON 输出的版本
  （`gh project list --format json`、`gh project item-list --format json`）；实测 **2.96.0**
  （2026-07-02）。要求位于 DSH 进程的 `PATH` 中，或通过 `ghCommand` 配置绝对路径。
- `gh` 登录且 token 含 **`project`** scope；读私有仓库 Issue 需要 `repo`，读组织 Project 通常还需要
  `read:org`：

  ```sh
  gh auth login
  gh auth refresh -s project          # 仅当 gh auth status 中没有 project scope
  gh auth status                      # 期望看到：Token scopes: ... 'project' ...
  ```

  没装 `gh`？macOS 上 `brew install gh`，其他平台见 <https://cli.github.com/>。用独立二进制也可以：
  DSH 看不到你 shell 的 `PATH` 时，把绝对路径填进 `ghCommand`。

## 安装

插件是本地包（`@local/dsh-github-projects`），未发布到 npm。把它装到你实际运行的 DSH profile
（默认 Desktop 安装的 profile 名为 `desktop`；跑 `web` / `headless` 就用对应名字）。

**命令行（DSH 0.2.1-rc.3 上已验证的方式）：**

```sh
# 安装到指定 profile
dsh plugin --profile desktop add /绝对路径/dsh-github-projects

# 确认已安装到该 profile
dsh plugin --profile desktop why @local/dsh-github-projects

# 卸载
dsh plugin --profile desktop remove @local/dsh-github-projects
```

`dsh plugin ... add` 会把包记录为 `link:` 依赖，并追加到 profile `package.json` 的
`dsh.profile.bundles`；运行中的 Desktop 会热重组并加载两个半身，无需重启；移除后即时回退。
安装时窗口会重载并回到工作区首页（HMR 重组的正常表现，会话数据不受影响），重新点开会话即可看到页签。
命令也接受已发布的包名代替本地路径；安装需要对 profile 目录的写权限。

**Plugin Manager：** 插件管理界面的「添加」是等价的 UI 路径，适合不走命令行的用户；
本机验收走的是上面的命令行路径。

## 使用

1. 打开一个会话，点 `projects` 页签。
2. 点「选择 Project」，从个人账号和组织里选一个 Project（`gh project list` 看不到时，可手动填
   owner + number 绑定）。
3. 绑定后默认是**泳道看板**：从左到右扫五列状态；用工具栏的「泳道 / 列表」切换可在分组列表与看板间切换。
4. 用工具栏的 **milestone 下拉**（`全部` / `Backlog` / 具体 milestone）和文本筛选收窄范围，
   两种视图的计数会同步更新；空列显示「无条目」但列不消失。
5. 点卡片主体或列表行：在 DSH **内置右侧浏览器**打开该 Issue/PR 的 GitHub 页面（不改变绑定）。
   点卡片/行上的「绑定」按钮才把 Issue 绑到当前会话，界面自动切到 `issue` 页签，并在会话标题下
   出现 Issue 副标题。
6. 另一条路径：在未绑定的 `issue` 页签直接粘贴 Issue 链接或 `owner/repo#123`，点「绑定」；
   也可以直接对模型说「把 https://github.com/acme/web/issues/228 绑定到当前会话」「当前会话换成
   acme/web#240」「解除当前会话的 Issue 绑定」（agent 工具）。
7. 之后随时点会话标题下的副标题，可在内置浏览器重新打开该 Issue。

点「刷新」强制新鲜读取（缓存过期后最多 10 分钟内可能先显示旧数据再后台刷新）；「更换」切换工作区
绑定的 Project；「解绑」（需确认）清除绑定。解绑 Project 不会影响已绑定的 Issue。

## 配置

默认值在 bundle 的 `cordis.patch.yml` 中。要覆盖时，在 profile 的 `cordis.patch.yml` 里按
`id: github-projects` 写配置。**覆盖会整体替换 `config`**，所以需要的键要全部重述。

| 键 | 默认值 | 说明 |
|---|---|---|
| `ghCommand` | `gh` | `gh` 可执行文件。建议写绝对路径——GUI 应用继承的 `PATH` 常比终端短 |
| `requestTimeoutMs` | `20000` | 单次 `gh` 调用超时（毫秒） |
| `cacheTtlMs` | `60000` | 内存缓存的 **fresh** 窗口（毫秒）；`refresh=1` 等待新鲜读取 |
| `staleTtlMs` | `600000` | **stale-serve** 窗口（10 分钟）：过期条目立即返回旧值 + `stale:true`，同时后台刷新一次 |
| `diskCache` | `true` | 是否把读取结果持久化到 `cacheFile`，供 DSH 重启后快速首屏 |
| `cacheFile` | `null` | 磁盘缓存文件；`null` 解析为 `$DSH_HOME/plugin-data/github-projects/cache.json` |
| `maxProjectItems` | `200` | 单次读取 Project 条目上限 |
| `maxComments` | `30` | 单次读取 Issue 评论上限 |
| `healthCacheTtlMs` | `5000` | `gh` 健康快照 TTL（`/config`、`/health` 共享） |
| `healthFirstReadTimeoutMs` | `3000` | **legacy，已不再使用**（0.4.0 起 `/config` 永不等待探测）；仅为兼容旧配置保留 |
| `statePath` | `null` | 绑定存储文件；`null` 解析为 `$DSH_HOME/plugin-data/github-projects/state.json` |

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: github-projects
  name: '@local/dsh-github-projects'
  config:
    ghCommand: /opt/homebrew/bin/gh
    requestTimeoutMs: 30000
    cacheTtlMs: 120000
    staleTtlMs: 600000
    diskCache: true
    cacheFile: null
    maxProjectItems: 200
    maxComments: 30
    healthCacheTtlMs: 5000
    healthFirstReadTimeoutMs: 3000
    statePath: null
```

## 隐私与网络

- **只有 `gh` 与 GitHub 通信。** 插件自身的网络面是一条本机回环 HTTP 路由
  （`/plugin/github-projects`），供 DSH Web 客户端调用；不向任何外部服务器发送数据。
- **不接触 token。** 插件从不读取 `GITHUB_TOKEN`/`GH_TOKEN`，不保存、不打印 token；认证和 scope
  完全交给 `gh`。
- **无遥测**、无统计、不加载外部图片/头像。Issue 正文按安全 Markdown 子集渲染（不执行 HTML、不加载远程图片）。
- **本地状态很小：** `state.json` 只存 Project/Issue 的标题、链接、编号、状态摘要和绑定时间；
  删除该文件即重置全部绑定。
- **只读：** 所有 GitHub 调用都是读取，插件没有任何写 GitHub 的端点。

## 常见问题

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `gh-missing` /「未找到 gh CLI」 | 没装 `gh`，或 DSH 进程的 `PATH` 找不到它 | 安装 `gh`；把 `ghCommand` 配成绝对路径（`which gh`） |
| `gh-auth` /「请先运行 gh auth login」 | 未登录，或缺少 `project` scope | `gh auth login`；`gh auth refresh -s project`（组织 Project 再加 `read:org`） |
| `gh-failed` /「GitHub 读取失败」 | 网络、GitHub 报错或触发限流 | 重试；在终端跑 `gh project list --owner <你>` 复核；限流则等待 |
| `timeout` | 网络慢 / Project 很大 | 重试；调大 `requestTimeoutMs` |
| 「这是 Pull Request」 | 绑定目标是 PR 而不是 Issue | 改绑 Issue；PR 行直接跳 GitHub |
| 安装后 Desktop 回到工作区首页 | HMR 重组 profile 的正常表现 | 重新点开会话即可，数据未受影响 |
| 安装后没有页签 | profile 里 bundle 未启用，或 DSH 未重组 | 检查 `dsh.profile.bundles`，在插件管理里启用，重新加载 |
| `projects` 页签显示「当前会话不属于任何工作区」 | Project 绑定以工作区为归属，当前会话没有工作区 | 先把会话放进一个工作区，再绑定 |
| 刚打开时闪一下「gh CLI 不可用」警告 | 冷启动时 `/config` 不等待 `gh`，先返回 `error:"pending"` 占位，后台探测 | 正常现象；探测完成后重新读取即恢复 |
| 列表是旧数据 | 60 秒缓存 | 点「刷新」 |
| 「绑定保存失败」 | `statePath` 不可写（权限/磁盘） | 检查路径与权限，或把 `statePath` 指到可写文件 |

## 开发

纯 ESM JavaScript，**无构建步骤、无捆绑的 npm 运行时依赖**（浏览器半使用宿主提供的
`react` / `react-dom`），Node ≥ 22。

```sh
node --check index.js && node --check client.js   # 语法检查
node --test test/host/*.test.mjs                  # 宿主单元测试（离线，用 gh fixtures）
node scripts/e2e/run.mjs                          # 隔离 e2e：临时 DSH_HOME + headless Chrome
node scripts/e2e/run.mjs --mode=real              # 同上，但使用真实 gh CLI
```

目录结构：

| 文件 | 作用 |
|---|---|
| `index.js` | Cordis 宿主插件：HTTP API、请求门禁、缓存/单飞 |
| `github.js` | `gh` CLI 适配器、规范化器、Issue 引用解析 |
| `state.js` | 绑定存储（原子 JSON 写入） |
| `client.js` | 浏览器半：`conversation.view` 注册、React 视图、安全 Markdown 渲染 |
| `dev/mock-host.js` | 契约形状的 mock 宿主，无 `gh` 也能做 UI/e2e |
| `test/` | 宿主单元测试 + 采集的 `gh` fixtures |
| `artifacts/screenshots/` | e2e 验收截图 |

### 本地 API

浏览器半通过本机回环 JSON API 与插件通信（前缀 `/plugin/github-projects`；`application/json`、
`cache-control: no-store`，错误体为 `{"error":{"code","message"}}`）。共 10 个端点：

| 方法 + 路径 | 用途 |
|---|---|
| `GET /health` | `gh` 可用性 |
| `GET /config?sessionId=&workspaceId=` | 当前绑定 + 缓存的 `gh` 健康快照（永不等待 `gh`） |
| `GET /bindings` | 全部会话→Issue 绑定（纯本地；侧栏副标题约 4s 轮询一次） |
| `GET /projects?refresh=1` | 可访问的 Projects（按 owner 分组；SWR，带 `stale`） |
| `GET /items?owner=&number=&refresh=1` | 一个 Project 的条目（分页 GraphQL；带 `stale`） |
| `GET /issue?repo=owner/name&number=N&refresh=1` | 一个 Issue + 评论（带 `stale`） |
| `POST /bind-workspace` | 绑定 Project 到工作区 |
| `POST /unbind-workspace` | 清除工作区绑定 |
| `POST /bind-issue` | 绑定 Issue 到会话 |
| `POST /unbind-issue` | 清除会话绑定 |

只有插件自己的浏览器半使用它；POST 有 Origin/Content-Type/大小门禁，且不会写 GitHub。

e2e 在独立的临时 `DSH_HOME` 和工作区、独立端口上运行，不会碰你正在使用的 profile 和窗口。
更多设计细节见 [`docs/DESIGN.zh.md`](docs/DESIGN.zh.md)，冻结接口见 [`docs/CONTRACT.md`](docs/CONTRACT.md)。

## 兼容性

| | |
|---|---|
| 插件版本 | 0.4.1（侧栏会话行副标题 + 本地 `GET /bindings`；0.4.0：头部副标题 / Agent 工具 / 内置浏览器 / SWR 更快读取；0.3.0：视觉系统 + 空泳道隐藏） |
| 实测 DSH | 0.2.1-rc.3（Desktop + `dsh web`） |
| 实测 `gh` | 2.96.0（2026-07-02） |
| 实测系统 | macOS（e2e 使用 headless Chrome 156） |
| Node（宿主半） | ≥ 22 |
| 运行时依赖 | 无（浏览器半使用宿主提供的 `react` / `react-dom`） |
| 验收 | 2026-10-28 通过 v0.4.1 验收：宿主测试 91/91；e2e fixture/real 均 PASS（各 18/18 阶段；冻结 client `e1ae2410…`、index `b52964f7…`）；侧栏副标题已验证（行高 41px、chip `#240`、点击不切换会话）；`/bindings` 本地 1–7ms；warm 打开 17–56ms 无骨架；14 张截图——见[验收证据](docs/DESIGN.zh.md#8-验收与验证证据) |

目前还没有 `engines.dsh` 版本门禁：如果 DSH 升级改动了 `conversation.view` slot 或会话标准 props，
可能需要同步更新插件。

## 已知限制

- **只读。** 不写 GitHub：不改状态、不评论、不建 Issue、不改字段。
- **泳道只读：** 不支持拖拽换列，也不支持手动排序。
- **泳道数量随过滤变化：** `No status` 过滤后为空时自动隐藏（其余四个规范列常驻），自定义状态列
  只在有条目时出现，因此泳道数量会随 milestone/文本筛选变化。
- **颜色只作辅助：** 状态/类型色都有文字标签兜底（彩色圆点为装饰），标题与正文保持中性色，
  不存在只靠颜色传递的信息。
- **看板布局：** 0.2.1 起页面无宽度上限，泳道、列表与 issue 页都铺满会话主体宽度；列最小宽度
  176px，窗口窄于约 960px 时整个看板横向滚动，宽屏下五列均分。未知自定义状态只做只读扩展列；
  空列保留列头与 0 计数，并显示「无条目」。
- **宿主布局不变：** DSH 自身的输入框（composer）仍保持宿主 shell 的居中宽度；本次修复只加宽
  插件页面，不改变侧边栏、页签栏与输入框等宿主框架。
- **milestone 过滤范围：** 选项与计数只来自已加载条目（受 `maxProjectItems` 上限约束），
  超出上限的条目不会出现在下拉里。
- **视图偏好是本地偏好：** 「泳道 / 列表」的选择只在当前客户端记住，不写入 profile 绑定文件。
- **一个工作区一个 Project，一个会话一个 Issue。**
- **只做 Issue 详情。** PR / Draft 条目只能跳转 GitHub，PR 不能绑定到会话。
- **列表不含条目状态。** 条目 payload 不返回每个条目的开闭状态，看板/列表不展示；`issue` 页签
  （走 REST）是准的。
- **有上限：** 单次最多 `maxProjectItems` 个条目（GraphQL 分页到上限即停）、`maxComments` 条评论
  （只取最早一页）；没有客户端的「加载更多」；超长 Issue 正文截断到 100 000 字符。
- **Issue 副标题在两处都依赖宿主私有 DOM：** 出厂头部没有 subtitle slot，插件用受控 portal 在标题行后
  插入副标题；左侧栏同样没有 slot，用受控 DOM decorator（`[data-row-key^="session:"]` 行锚点 +
  `:has()` 行高覆盖 + `MutationObserver`）注入第二行。若 DSH 升级改变任一 DOM，对应副标题会降级为
  不显示（不报错、不影响其它功能），需随版本复核。
- **侧栏副标题有约 4s 轮询延迟：** 本插件自己的绑定/解绑由 `binding-changed` 事件立即生效；agent
  工具改绑最迟下一轮轮询（≤4s）反映到侧栏。有副标题的会话行约 41px、未绑定的仍 32px。
- **Agent 工具只作用于当前会话：** 没有跨会话参数，不能给其它会话绑定/解绑；工具需要宿主提供
  `ctx.tools` 与 owning agent，界面通过本地轮询（≤4s）反映，不是推送。
- **内置浏览器兜底：** 卡片/行点击使用 DSH 右侧栏 browser tab；宿主没有该能力时回退 `window.open`
  （普通新标签页，会离开当前界面）。
- **Web 版内置浏览器受 X-Frame-Options 限制：** Web 构建用 iframe 承载浏览器，github.com 返回
  `X-Frame-Options: DENY`，内嵌 GitHub 页面可能显示空白（地址栏 URL 正确）；Desktop 版 Electron
  webview 正常渲染。只影响"在界面内查看"，不影响 URL 本身。
- **SWR 新鲜度：** `staleTtlMs`（10 分钟）内可能先看到缓存数据再后台刷新；DSH 重启后还可能先用
  磁盘缓存渲染。需要最新数据请点「刷新」。磁盘缓存保存 GitHub 读取结果（不含 token），位于 DSH
  profile 下；可删除或设 `diskCache: false` 关闭。
- **延迟数字是参考值：** 单次 GraphQL `/projects` ~1.4s、分页 `/items` 冷启动 ~3.4s、warm 打开
  27–72ms（无骨架）均来自本机实测，随网络、项目规模与 `gh` 版本变化；real 数据冷启动看板实测
  3.70s，略高于 3.5s 期望，按记录处理（不判失败）。
- **不跨 Project 搜索**，也没有全局看板。
- **绑定属于当前 profile**，不随仓库走；换机器/换 profile 需要重新绑定。
- **仅 Markdown 子集：** 正文不渲染 HTML、图片、表格；任务列表勾选框只做展示、不可点击。
- **不轮询、不推送：** GitHub 侧的变化要手动刷新才可见。
- **依赖 `gh`：** 没有可用且已登录的 `gh` 时，仍能看到已绑定项的摘要（本地状态），但看不到列表和详情。

## 许可证

MIT。设计文档（中文）：[docs/DESIGN.zh.md](docs/DESIGN.zh.md)。
