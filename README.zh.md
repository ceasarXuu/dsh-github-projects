# dsh-github-projects

**v0.2.1** · 把当前会话绑定的 GitHub Project 和 Issue，放进 DSH 会话头部的两个页签。

这个 DSH 插件向会话头部追加两个视图：`projects` 以**泳道看板**（默认）展示绑定到**工作区**的
GitHub Project，可切换列表视图并支持 milestone 过滤；`issue` 展示绑定到**会话**的 Issue。
对 GitHub 全程只读——它是查看面板，不是写入工具。

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
| Issue | 一个**会话** | `projects` 页签里某个 Issue 行点「绑定」，或在 `issue` 页签粘贴链接 | DSH profile 内的 `state.json` |

`projects` 页签一次读取 `GET /items`，在前端完成所有派生：按 Projects v2 的 `Status` 字段分成泳道列、
按 `milestone` 字段生成过滤选项、文本/状态筛选与计数；不额外调用 GitHub。点 Issue 卡片（或列表行的
「绑定」）后，插件把该 Issue 绑到当前会话并自动切到 `issue` 页签，展示标题、状态、正文、标签和评论。
两个页签都是追加的：停用插件后会话头部完全恢复原样。

所有 GitHub 读取都通过你本机已登录的 [`gh` CLI](https://cli.github.com/) 完成。插件不保存 token、
不上报遥测、也不直接访问 GitHub。

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
| 默认泳道看板（五列状态） | 列表视图：分组段 + 状态 chips |
| ![milestone 过滤](artifacts/screenshots/06-projects-milestone.png) | ![Issue 未绑定空态](artifacts/screenshots/07-issue-empty.png) |
| milestone 过滤（全部 / Backlog / 各里程碑） | 未绑定会话：从项目选择或粘贴链接 |
| ![Issue 详情](artifacts/screenshots/08-issue-detail.png) | ![Issue 评论区](artifacts/screenshots/09-issue-comments.png) |
| 已绑定 Issue：吸顶头部、正文、标签 | 评论：作者、相对时间与 GitHub 链接 |
| ![宽窗口全宽布局](artifacts/screenshots/11-projects-wide.png) | |
| 宽窗口（2200×1300）：`projects` 页面铺满会话区域（窗口宽 86.6%；旧版 1000px 居中限宽仅 45.5%） | |

截图 01–09 由隔离 e2e 在 **real 模式**下对真实 `gh` 采集（真实 Project #9 与 Issue #240；
1280×800；`09` 需 `--extra-comments`）。`11-projects-wide.png` 是 harness 在 **2200×1300** 下采集的
全宽布局证据。`10-desktop-tabs.png` 不同：它是重装 v0.2.1 后**真实 Desktop 应用**的手动现场截图，
展示用户当前会话头部的两个页签：

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
5. 点 Issue 卡片（或列表行的「绑定」）：Issue 绑到当前会话并自动切到 `issue` 页签；
   PR/Draft 卡片则打开 GitHub。
6. 另一条路径：在未绑定的 `issue` 页签直接粘贴 Issue 链接或 `owner/repo#123`，点「绑定」。

点「刷新」绕过 60 秒缓存；「更换」切换工作区绑定的 Project；「解绑」（需确认）清除绑定。
解绑 Project 不会影响已绑定的 Issue。

## 配置

默认值在 bundle 的 `cordis.patch.yml` 中。要覆盖时，在 profile 的 `cordis.patch.yml` 里按
`id: github-projects` 写配置。**覆盖会整体替换 `config`**，所以需要的键要全部重述。

| 键 | 默认值 | 说明 |
|---|---|---|
| `ghCommand` | `gh` | `gh` 可执行文件。建议写绝对路径——GUI 应用继承的 `PATH` 常比终端短 |
| `requestTimeoutMs` | `20000` | 单次 `gh` 调用超时（毫秒） |
| `cacheTtlMs` | `60000` | GitHub 读取的内存缓存 TTL（毫秒）；`refresh=1` 可绕过 |
| `maxProjectItems` | `200` | 单次读取 Project 条目上限 |
| `maxComments` | `30` | 单次读取 Issue 评论上限 |
| `healthCacheTtlMs` | `5000` | `gh` 健康快照 TTL（`/config`、`/health` 共享） |
| `healthFirstReadTimeoutMs` | `3000` | 首次 `/config` 等待健康探测的上限；超时先返回 `error:"pending"`，探测在后台继续 |
| `statePath` | `null` | 绑定存储文件；`null` 解析为 `$DSH_HOME/plugin-data/github-projects/state.json` |

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: github-projects
  name: '@local/dsh-github-projects'
  config:
    ghCommand: /opt/homebrew/bin/gh
    requestTimeoutMs: 30000
    cacheTtlMs: 120000
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
| 刚打开时闪一下「gh CLI 不可用」警告 | 首次 `/config` 健康探测超过 `healthFirstReadTimeoutMs`，返回了 `error:"pending"` 占位 | 正常现象；探测完成后重新读取即恢复 |
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

e2e 在独立的临时 `DSH_HOME` 和工作区、独立端口上运行，不会碰你正在使用的 profile 和窗口。
更多设计细节见 [`docs/DESIGN.zh.md`](docs/DESIGN.zh.md)，冻结接口见 [`docs/CONTRACT.md`](docs/CONTRACT.md)。

## 兼容性

| | |
|---|---|
| 插件版本 | 0.2.1（v1.1.1：全宽自适应；v1.1：泳道看板 + milestone 过滤） |
| 实测 DSH | 0.2.1-rc.3（Desktop + `dsh web`） |
| 实测 `gh` | 2.96.0（2026-07-02） |
| 实测系统 | macOS（e2e 使用 headless Chrome 156） |
| Node（宿主半） | ≥ 22 |
| 运行时依赖 | 无（浏览器半使用宿主提供的 `react` / `react-dom`） |
| 验收 | 2026-10-28 通过 v1.1.1（0.2.1）验收：宿主测试 69/69；e2e fixture/real 均 PASS（冻结 client `4f41dc9d…`）；`projects-wide` 2200×1300 下页面占窗口 86.6%（旧版 1000px 上限仅 45.5%）；11 张截图齐全（含 Desktop 手动现场图）——见[验收证据](docs/DESIGN.zh.md#8-验收与验证证据) |

目前还没有 `engines.dsh` 版本门禁：如果 DSH 升级改动了 `conversation.view` slot 或会话标准 props，
可能需要同步更新插件。

## 已知限制

- **只读。** 不写 GitHub：不改状态、不评论、不建 Issue、不改字段。
- **泳道只读：** 不支持拖拽换列，也不支持手动排序。
- **看板布局：** 0.2.1 起页面无宽度上限，泳道、列表与 issue 页都铺满会话主体宽度；列最小宽度
  176px，窗口窄于约 960px 时整个看板横向滚动，宽屏下五列均分。未知自定义状态只做只读扩展列；
  空列保留列头与 0 计数，并显示「无条目」。
- **milestone 过滤范围：** 选项与计数只来自已加载条目（受 `maxProjectItems` 上限约束），
  超出上限的条目不会出现在下拉里。
- **视图偏好是本地偏好：** 「泳道 / 列表」的选择只在当前客户端记住，不写入 profile 绑定文件。
- **一个工作区一个 Project，一个会话一个 Issue。**
- **只做 Issue 详情。** PR / Draft 条目只能跳转 GitHub，PR 不能绑定到会话。
- **列表不含条目状态。** `gh project item-list` 的 JSON 不返回每个条目的开闭状态，列表不展示；
  `issue` 页签（走 REST）是准的。
- **有上限：** 单次最多 `maxProjectItems` 个条目、`maxComments` 条评论（评论只取最早一页）；没有分页和「加载更多」；
  超长 Issue 正文截断到 100 000 字符。
- **不跨 Project 搜索**，也没有全局看板。
- **绑定属于当前 profile**，不随仓库走；换机器/换 profile 需要重新绑定。
- **仅 Markdown 子集：** 正文不渲染 HTML、图片、表格；任务列表勾选框只做展示、不可点击。
- **不轮询、不推送：** GitHub 侧的变化要手动刷新才可见。
- **依赖 `gh`：** 没有可用且已登录的 `gh` 时，仍能看到已绑定项的摘要（本地状态），但看不到列表和详情。

## 许可证

MIT。设计文档（中文）：[docs/DESIGN.zh.md](docs/DESIGN.zh.md)。
