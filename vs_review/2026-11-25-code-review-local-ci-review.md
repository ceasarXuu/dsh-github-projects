# Subagent VS Review: DSH 本地 Code Review 方案

- Created: 2026-11-25T10:20:18+08:00
- Updated: 2026-11-25T10:28:32+08:00
- Report schema: adversarial-v2
- Task: 审查 `prd/2026-11-25-code-review-local-ci.md` 是否可直接、安全地实施
- Report path: `vs_review/2026-11-25-code-review-local-ci-review.md`
- Review mode: fresh internal subagents
- Source session policy: no inherited main-agent context; reviewer receives only the review packet
- Status: blocked
- Control outcome: user-decision-required
- Automatic round budget: 2
- Completed rounds: 1
- Last known-good checkpoint: `4da3d88e941db8aa10edb070840203c70a2bb8e9`

## Review Control Contract

### Frozen Objective

判断方案是否满足用户目标：在 DSH 内提供一个默认关闭、复用本机 `gh` 凭据、随 DSH 启停的本地 PR Code Review 工具，并识别实施前必须解决的阻断问题。

### Acceptance Criteria

- 结论能区分阻断问题、非阻断风险和可选改进。
- 每个重要结论给出文件路径与行号、失败场景、影响和所需证据。
- 核对产品权威、默认行为、用户控制、写入权限、隐私、并发/取消、幂等、失败恢复和验收可执行性。
- 核对方案对现有插件契约、DSH `llm` 服务、客户端槽位和 GitHub API 的假设。
- 不把未实施功能或未验证收益表述为已完成。

### Explicit Non-goals

- 不实施 Code Review 功能。
- 不修改 PRD、源代码、配置、已确认产品决定或发布版本。
- 不新增依赖、公共 API、持久化格式或跨模块抽象。
- 不执行真实 GitHub 写入、付费模型调用、集成测试或 e2e。
- 不发布、不部署、不推送代码。

### Frozen Target Locations

- `prd/2026-11-25-code-review-local-ci.md`
- `prd/2026-11-19-github-projects-desktop.md`
- `docs/CONTRACT.md`
- `docs/DESIGN.zh.md`
- `package.json`、`cordis.patch.yml`
- `index.js`、`github.js`、`state.js`、`client.js`
- `/Users/zhangxu/.dsh/closure/0.1.5-rc.3/node_modules/@deepseek-ai/dsh-llm/`
- `/Users/zhangxu/.dsh/closure/0.1.5-rc.3/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js`
- `/Users/zhangxu/.dsh/closure/0.1.5-rc.3/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js`
- GitHub 官方 REST API 文档（只读）

### Allowed Change Categories

- 仅创建和更新本审查报告。
- 只读检查代码、文档、已安装包和官方文档。

### Approval-required Changes

- 修改 PRD 或任何已确认产品决定。
- 修改源代码、配置、测试或发布文件。
- 新增顶层模块、外部依赖、公共 API、持久化数据格式或跨模块抽象。
- 改变审查目标、验收标准或非目标。

### Authoritative Sources

| Authority | Source | What It Controls |
|---|---|---|
| E0 | 用户要求「审查一下这个方案」 | 本次只读审查目标与范围 |
| E1 | 本 PRD、既有 PRD、`docs/CONTRACT.md`、项目 `AGENTS.md` | 项目意图、现有接口约束、已确认产品决定 |
| E2 | 当前仓库代码与已安装 DSH 运行时源码 | 实际代码路径和接口行为 |
| E3 | DSH 包 README/API、GitHub 官方 API 文档 | 外部平台事实与限制 |
| E4 | 审查者或主代理推理 | 仅作为待验证假设 |

### Baseline And Rollback

- Baseline revision: `4da3d88e941db8aa10edb070840203c70a2bb8e9`
- Baseline commit: `4da3d88 docs(prd): Code Review as a local CI inside DSH`
- Rollback checkpoint: 不修改被审查文件；如仅需撤销审查产物，可移除本报告。
- Expected benefit: 在开工前发现会导致错误审阅、重复/错位评论、隐私或权限问题的方案缺口。
- Acceptable side effects: 一个只读审查报告；不改变运行时、测试、数据或发布行为。
- Automatic round budget: 2

## Round 1: 初始对抗审查

### Round Control

- Round type: initial
- Round number: 1
- Completed automatic rounds before launch: 0
- User approval for this round: n/a（Round 1 在自动预算内）
- Closure finding IDs: n/a
- Permitted closure relation: n/a
- Target scope delta allowed: none

### Review Input

#### Objective

审查 `prd/2026-11-25-code-review-local-ci.md` 是否可直接、安全地实施，并尝试证伪其关键假设。

#### Acceptance Criteria

- 输出阻断问题、非阻断风险、用户视角检查、实施完整性检查和收益验证检查。
- 重要问题必须包含反例、触发条件、影响、证明所需证据、E0–E4 证据等级和来源。
- 覆盖产品权威、默认安全、写入门禁、并发/取消、幂等、失败恢复、数据/隐私、验收与回滚。
- 所有结论只读，不修改被审查方案或代码。

#### Explicit Non-goals

- 不实施功能。
- 不改变产品决定。
- 不运行真实写入、付费调用、集成测试或 e2e。
- 不新增依赖或架构。

#### Review Target

产品设计、架构计划、用户体验、测试/验收计划和运维/安全边界的实施前审查。

#### Target Locations

- `prd/2026-11-25-code-review-local-ci.md`
- `prd/2026-11-19-github-projects-desktop.md`
- `docs/CONTRACT.md`、`docs/DESIGN.zh.md`
- `package.json`、`cordis.patch.yml`
- `index.js`、`github.js`、`state.js`、`client.js`
- `/Users/zhangxu/.dsh/closure/0.1.5-rc.3/node_modules/@deepseek-ai/dsh-llm/README.md`
- `/Users/zhangxu/.dsh/closure/0.1.5-rc.3/node_modules/@deepseek-ai/dsh-llm/lib/index.js`
- `/Users/zhangxu/.dsh/closure/0.1.5-rc.3/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js`
- `/Users/zhangxu/.dsh/closure/0.1.5-rc.3/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js`
- GitHub 官方 REST API 文档（只读）

#### Baseline And Rollback Checkpoint

- Baseline: `4da3d88e941db8aa10edb070840203c70a2bb8e9`
- Rollback checkpoint: 被审查文件保持不变；审查报告可单独移除。

#### Change Introduction

方案提议在现有 `dsh-github-projects` 插件内新增一级「Code Review」入口、手动审阅、轮询自动触发、模型调用、GitHub review 写回、审计与统计能力；默认关闭自动审阅和写回。

#### Risk Focus

- PRD 是否具有唯一、受保护且直接由用户确认的产品权威。
- DSH `llm` 服务真实调用契约、消息构造、`purpose`、输出字段和服务激活顺序。
- GitHub PR 列表/文件/review API 的分页、权限、行号、幂等与错误语义。
- 水位、已审 SHA、draft→ready、跳过标签/自己 PR/fork 规则之间的状态一致性。
- 新 SHA 抢占、取消、超时、重试、部分成功和重启恢复。
- 不可信 diff/提示注入、模型输出渲染、代码外发和审计完整性。
- 默认关闭是否真的能保证零自动行为和零 GitHub 写入。
- 用户能否理解模型配置、降级、失败恢复、评论去向和 `REQUEST_CHANGES` 后果。

#### User-Perspective Review Focus

- 首次启用是否需要隐藏的 DSH/API 知识。
- 自动审阅、写回、fork、`REQUEST_CHANGES` 等开关是否容易误配。
- 排队、运行、失败、取消、降级和“结果未知”是否有清晰反馈。
- 同一 PR 多次审阅、旧任务取消、评论重复或错位时用户能否理解和恢复。
- 工作台与现有 Projects/Issue 入口是否冲突或造成认知负担。

#### Implementation Completeness Focus

- P0–P3 是否覆盖生产路径，而非只有接口/骨架。
- 路由、服务注入、状态存储、客户端文件下发、槽位注册是否有明确落点。
- 测试计划是否能覆盖失败路径和默认无副作用，而非只测 happy path。
- 方案中的验收是否可被脚本直接控制，是否符合项目“禁止视觉控制”的测试约束。

#### Target Benefit Focus

- “本地 CI”“随 DSH 启停”“复用 gh”“模型可见即有记录”等收益是否有基线、测量方法和回归检查。
- 30–120 秒输出是否具备可行的时间预算和超时定义。
- 评论质量、噪音、token/成本、API 用量缺少验证时不得表述为已达成。

#### Evidence Sources And Gaps

- E0: 用户只要求审查，未确认新的产品行为。
- E1: 本 PRD 第十章列出已确认决定，但需核对是否有受保护确认区与既有 PRD 权威冲突。
- E2: 当前仓库已有 `gh` 适配器、原子状态写、HTTP 门禁、客户端槽位先例。
- E3: 已安装 DSH 0.2.3-alpha.2 对应 closure 0.1.5-rc.3 的 `dsh-llm` 文档与源码；GitHub 官方 API 文档。
- Known evidence gap: 方案未实施，无运行日志、真实模型调用、真实 GitHub review 写入或性能证据。

#### Assumptions To Attack

- `ctx.llm.stream` 可接受自定义 `purpose` 和 `maxOutputTokens`。
- 只调用 `ctx.llm.stream` 即可满足“模型可见即有记录”。
- `pulls?per_page=50` 足以覆盖所有需要触发的 PR。
- `headSha` 去重不会阻断 draft→ready、取消 skip 标签等状态触发。
- marker 查询与 review 发布之间不存在导致重复评论的竞态。
- 所有模型输出都可安全解析/展示，JSON 失败回退不会产生误导。
- 200 KB patch 预算能可靠防止上下文超限。
- 现有 `allowWrites` 与 `codeReview.post` 双重开关足以覆盖所有写路径。
- 单实例文件锁在崩溃、重启和多 profile 下语义正确。
- 默认关闭时插件仍能零自动行为、零模型调用、零 GitHub 写入。

#### Adversarial Lenses

requirements、state、input、concurrency、failure、data、security、usability、ease-of-use、comprehension、implementation-completeness、target-benefit、maintenance、testing、observability

#### Verification Status

- 已确认仓库工作区干净，基线为 `4da3d88`。
- 已阅读 PRD、既有产品 PRD、项目契约和关键实现。
- 尚未运行测试、真实模型调用、真实 GitHub 写入或 e2e。
- 审查结论必须区分文档断言、代码事实和待验证假设。

#### Reviewer Instructions

- Fresh internal subagent session，不继承主代理上下文。
- 直接阅读目标文件，不修改任何文件。
- 尽量引用 `path:line` 证据。
- 阻断和扩范围结论必须标注 E0–E4 证据等级与来源。
- 每个阻断问题给出 broken assumption、failure scenario、trigger、impact、proof needed、closure relation 和 scope effect。
- 对用户视角、实施完整性和目标收益分别输出检查结果。
- 不要为了全面而堆砌风格偏好；聚焦高影响失败模式。
- 不运行测试、真实写入、付费模型调用或 e2e。

### Internal Subagent Unavailable Fallback

- Internal subagent unavailable reason: n/a
- Local CLI discovery commands: not needed
- Discovered CLI candidates: n/a
- User-recommended alternative agent requested: no
- User-recommended agent command: n/a
- User-recommended agent verification: n/a
- User approval requested: no
- User-approved CLI command: n/a
- User decision: n/a
- Fallback outcome: n/a

### Reviewer Timeout Policy

| Complexity | Initial Wait | Extension | Max Attempts Per Role | Blocking Closure Behavior |
|---|---:|---:|---:|---|
| complex | 25 minutes | 一次，最多追加 25 分钟 | 2 | 审查不可用不能判为通过 |

### Reviewer Selection

| Reviewer | Reason Selected | Risk Area |
|---|---|---|
| user-experience-adversary | 方案新增一级入口、配置矩阵、自动外写和失败恢复，用户误解会直接导致重复评论、阻塞 PR 或隐私风险 | 默认值、开关语义、反馈、恢复路径、可理解性；同时核对方案可执行性 |

### Reviewer Launch Records

| Reviewer | Internal Mechanism | Session / Job ID | Trace Source | Context Forked | Input Packet | Context Explicitly Excluded | Read-only |
|---|---|---|---|---|---|---|---|
| user-experience-adversary | `subagent` tool | `ses_def7e7648ffe0YGFFn2R2m7IbA` | subagent spawn call / background notification | fork_context=false | Round 1 Review Input | 主代理历史、推理、结论、完整 diff | yes |

### Reviewer Timeout Records

| Reviewer Output Key | Reviewer Role | Attempt | Session / Job ID | Waited | Status | Reason | Action |
|---|---|---:|---|---|---:|---|---|
| r1-user-experience | user-experience-adversary | 1 | `ses_def7e7648ffe0YGFFn2R2m7IbA` | 单次完成，未超时 | completed | 返回 8 个阻断问题与 9 个非阻断风险 | completed |

### User Decision After Failed Review

- Required if primary and replacement attempts both fail.
- Decision: pending
- User-visible reason: n/a

### Reviewer Outputs

#### r1-user-experience

以下为独立审查者的原始输出（仅移除后台通知包装）。

##### A. Summary

**结论：当前 PRD 不能直接、安全实施。** 发现 **8 个阻断问题**，集中在产品权威、LLM/审计契约、轮询完整性、GitHub 发布正确性和 P0 生产接线。

已尝试证伪但基本成立的前提：

- `sidebar.panellist.id` 与 `main.key` 的配对方式在指定 DSH 客户端中确实存在。
- 现有 `allowWrites` 覆盖了当前三条 GitHub 写路径：`/item-status`、`/project-operation` 和 `github_project_item_status` 工具。
- 仓库 HEAD 与基线一致：`4da3d88e941db8aa10edb070840203c70a2bb8e9`；仅有未跟踪的 `vs_review/`，未修改任何文件。
- 按要求未运行测试、e2e、真实写入或付费模型调用。

##### B. Blocking Findings

###### B1 — 第十章不是可审计的受保护用户权威，且与既有产品约束冲突

- Broken assumption：第十章“已确认的产品决定”可以直接覆盖 PD2、既有写操作确认原则和 DSH 审计约定。
- Failure scenario：
  1. 实施者按新 PRD 把管理配置与操作放到中央面板，可能违反 PD2“不新增其他区域的管理界面”。
  2. 实施者按 `autoReview + post` 自动发布 AI review，违反现有设计“所有写操作必须是用户显式动作（按钮 + 二次确认），不做 AI 自动改状态”。
  3. 实施者按第十章用摘要 JSONL 替代会话日志，违反 `dsh-llm` 的“模型可见即可从会话日志重建”约定。
- Trigger：实施 §2.1、§2.2、§3.2、§6、§7 或第十章任一项。
- Impact：产品位置、自动写权限和审计形态可能整体实现错误；这不是实现细节，而是需要用户签字的产品边界。
- Proof needed：用户明确确认 Code Review 是否属于 PD2 所限制的“项目管理”；中央工作台是否正式取代/扩展“管理操作只在右侧栏”的决定；是否允许 AI 在自动模式下无需每次确认发布 review；是否接受摘要 JSONL 作为审计等价物。
- Authority：E1；缺少 E0 直接确认。
- Source：`prd/2026-11-25-code-review-local-ci.md:31,55,243`；`prd/2026-11-19-github-projects-desktop.md:66,76`；`docs/DESIGN.zh.md:2320`；`dsh-llm/README.md:110`。
- Closure relation：n/a。
- Scope effect：阻断 P0 入口形态、P1 写回方式和 P2 自动发布，直至 E0 确认。

###### B2 — LLM 消息、目录、`purpose` 与审计契约被写错

- Broken assumption：`ctx.llm.stream` 接受本功能自定义 `purpose`；`listModels()` 直接提供上下文窗口和推理强度；请求摘要 JSONL 能满足“模型可见即有记录”。
- Failure scenario：
  1. 安装包的真实 `GenerateOptions` 只允许 `purpose: 'compaction' | 'session-title'`，自定义 `code-review` 不属于受支持契约。
  2. `listModels()` 只返回 provider/id/name/description/inputModalities；上下文与 effort 必须调用 `resolveModelInfo()`。
  3. PRD 只记录系统提示版本、输入字节数、模型和响应摘要，无法重建实际发送的 diff、消息或响应，不满足官方 README 的可重建性约定。
  4. `prepareCall()` 生成一次性句柄，保存配置时校验后不能留到真正运行时复用。
- Trigger：P0 模型通路冒烟、`/code-review/models`、P1 调用与审计。
- Impact：要么按不受支持的字段实现，要么模型目录缺能力信息；审计验收即使 JSONL 写入成功也会被证伪。
- Proof needed：在目标 DSH 版本上验证真实 `GenerateOptions` 和目录响应；明确使用 `maxTokens` 还是插件配置名 `maxOutputTokens`；提供完整请求/响应持久化方案，或取得用户对审计约定的正式例外批准；实际重建一次模型可见请求。
- Authority：E2 + E3。
- Source：`prd/2026-11-25-code-review-local-ci.md:75,126,134,183`；`dsh-llm/lib/typert.host.js:286`；`dsh-llm/lib/index.js:2018,2043,2164`；`dsh-session-title-llm/lib/index.js:209`。
- Closure relation：n/a。
- Scope effect：阻断 P0/P1 模型生产路径和审计设计。

###### B3 — `headSha` 单一去重键会阻断合法的同 SHA 状态转换

- Broken assumption：同一 PR 的 `headSha` 不变，就不需要再次审阅。
- Failure scenario：PR 已 ready 并完成审阅；用户将其转回 draft，随后不改提交地再次 ready；`draft → ready` 明确是触发条件，但 `owner/repo#number@headSha` 已存在，任务被去重。同理，已审 PR 添加 `skip-review` 后移除标签，同 SHA 也可能永久无法再审。
- Trigger：ready → draft → ready；移除 `skip-review`；手动修改模型配置后要求同 SHA 重审。
- Impact：明确承诺的触发行为失效，用户会认为自动审阅“坏了”，且界面没有强制重审入口。
- Proof needed：状态转换测试和强制重审语义；去重身份至少应包含触发代次/资格状态，并区分成功、失败、取消和用户强制重跑。
- Authority：E1 + E3。
- Source：`prd/2026-11-25-code-review-local-ci.md:102,106,111,113`；GitHub 官方 Draft pull requests 文档。
- Closure relation：n/a。
- Scope effect：阻断 P2 去重与触发判定。

###### B4 — 单页 pulls + 水位推进会永久漏掉变更；files 分页也未定义

- Broken assumption：每轮只取 `per_page=50` 的第一页，再推进水位，不会漏 PR；files 第一页足够支撑 60 文件预算。
- Failure scenario：一个轮询间隔内某仓库有 51 个以上 open PR 更新；第一页只处理最新 50 个，随后水位推进；下一轮剩余 PR 已落到第二页，且 `updated_at` 早于新水位，永远不再进入候选集。files 端点默认 30、最大 100；若只取第一页，无法按“源码 > 测试 > 文档”跨全量文件排序；超过 3000 文件时 GitHub 本身只返回 3000。
- Trigger：活跃仓库、休眠唤醒后的批量更新、超过 100 个变更文件的大 PR。
- Impact：自动审阅静默漏审，直接违反“发现 PR 变更”和“大 PR 明确降级”的验收。
- Proof needed：51+ PR 跨页测试；分页未完成时不推进水位的失败测试；61/101/3001 文件测试和明确截断声明。
- Authority：E3。
- Source：`prd/2026-11-25-code-review-local-ci.md:96,117,142,148,259,272`；GitHub 官方 List pull requests / List pull request files 文档。
- Closure relation：n/a。
- Scope effect：阻断 P0 PR 读取和 P2 轮询完整性。

###### B5 — review 没有绑定被审阅的不可变 head，取消也无法保证停止 `gh` 写请求

- Broken assumption：模型调用阶段取消成功，就不会发布旧 SHA 的 review；GitHub review 默认当然对应请求里的 head。
- Failure scenario：插件完成 SHA A 的分析；用户推送 SHA B；旧任务被取消，但 PUBLISH 已经进入 `gh`；GitHub 的 `commit_id` 省略时默认使用请求到达时的最新 head，于是 SHA A 的结论被挂到 SHA B；现有 `createExecRunner` 只设置 `timeout`，没有 `AbortSignal`，无法按 PRD 把取消贯穿到 `gh` 子进程。
- Trigger：模型结束与发布之间的竞态、发布过程中取消、DSH 退出、用户手动取消。
- Impact：未分析的代码收到 review，inline 评论可能错位，`REQUEST_CHANGES` 可能错误阻塞合并。
- Proof needed：POST 必须携带 `commit_id = headSha`；发布前重新读取 head 并处理不一致；`gh` 子进程可取消测试；取消后检查 GitHub 是否仍产生 review。
- Authority：E2 + E3。
- Source：`prd/2026-11-25-code-review-local-ci.md:112,135,172,174`；`github.js:840`；GitHub 官方 Create a review 文档。
- Closure relation：n/a。
- Scope effect：阻断 P1 发布正确性和 P2 抢占取消。

###### B6 — marker 预检查不是幂等，崩溃与并发会产生重复评论

- Broken assumption：发布前查一次 marker，就能保证同一 SHA 最多一条 review。
- Failure scenario：同一 profile 内手动与自动任务同时运行，或两个 profile 同时审同一仓库；两者都未查到 marker，随后都 POST；review 列表端点默认每页 30 条，旧 marker 可能不在第一页；GitHub 已接受 POST，但插件在写历史/已审 SHA 前崩溃；重启后无法判断是否发布，只能重复模型调用或重复写回。
- Trigger：并发触发、历史 review 超过 30 条、发布后崩溃、超时但服务端已成功。
- Impact：重复通知与噪音评论、重复模型费用、本地状态与 GitHub 永久不一致。
- Proof needed：进程内 per-key single-flight；跨 profile 的锁/所有权策略或明确接受重复风险；marker 全量分页查询；“发布意图 → GitHub 结果 → 本地结算”的持久化状态机；模糊失败后按 marker/commit 对账。
- Authority：E2 + E3。
- Source：`prd/2026-11-25-code-review-local-ci.md:111,119,175,181`；`state.js:205`；GitHub 官方 List reviews 文档。
- Closure relation：n/a。
- Scope effect：阻断 P1 幂等验收和 P2 恢复语义。

###### B7 — 默认用户在界面开启“写回评论”后仍然无法写回

- Broken assumption：新配置页的 `post` 开关足以开启 review 写回。
- Failure scenario：出厂 `allowWrites: false`、`codeReview.post: false`；用户在新工作台选择模型并打开“写回评论”；新 UI 没有暴露 `allowWrites`，且它是静态宿主配置，不能由 `POST /code-review/settings` 修改；宿主仍拒绝写回，用户只能去读内部文档并编辑 profile YAML；如果门禁放在模型调用之后，用户还可能先支付模型费用再发现无法发布。
- Trigger：全新默认配置下的 P1 手动审阅验收。
- Impact：主流程走不通；用户无法理解失败原因，也无法从界面恢复。
- Proof needed：明确 `enabled / autoReview / allowWrites / post` 的能力矩阵；在界面展示只读原因和恢复动作；所有实际 GitHub 写在执行时再次检查 `allowWrites && post`；排队期间关闭写回时不得在稍后恢复发布。
- Authority：E1 + E2。
- Source：`prd/2026-11-25-code-review-local-ci.md:73,177,187,228,270`；`cordis.patch.yml:59`；`index.js:147,1377`；`docs/DESIGN.zh.md:1818`。
- Closure relation：n/a。
- Scope effect：阻断 P1 默认用户手动发布路径。

###### B8 — P0 的客户端文件与 `llm` 服务没有生产接线

- Broken assumption：新增 `review-workbench.js`、`review-tab.js` 后，现有包会自动下发；宿主引用 `ctx.llm` 时会自动等待服务。
- Failure scenario：`package.json.files` 不包含两个新客户端文件；DSH 客户端入口只加载 `client.js`，本地动态 import 新文件会 404；现有 `SIDEBAR_CLIENT_FILES` 白名单也只包含 sidebar 文件；`index.js` 的 inject 仍只有 `webServer/tools`，没有 `llm` 激活契约；P0 即使代码写完，干净安装后仍可能没有工作台或 `/models` 不可用。
- Trigger：P0 入口与面板骨架、npm 打包、干净 profile 启动、HMR。
- Impact：测试可通过本地拼接实现，但生产路径不完整。
- Proof needed：新客户端文件进入发布包并有实际下发路径；`llm` 服务注入/降级顺序明确；干净安装后两个 slot 注册成功；HMR 后任务停止、路由与槽位正确释放。
- Authority：E2。
- Source：`prd/2026-11-25-code-review-local-ci.md:205,216,240,259`；`package.json:35,42,69`；`index.js:65,94,1353`；`client.js:15`。
- Closure relation：n/a。
- Scope effect：阻断 P0 生产交付。

##### C. Non-blocking Risks

###### R1 — “默认零自动行为”只可能指新功能，不适用于整个插件

- 反例/触发：`autoBind` 默认 `true`，启动和每 60 秒仍会自动读 GitHub、写本地绑定。
- 影响：用户可能误解为关闭 Code Review 后插件完全无后台行为。
- 证明所需：默认配置下的进程/网络探针，明确区分“新功能零行为”和“既有 auto-bind 行为”。
- Authority：E2。
- Source：`cordis.patch.yml:55`、`index.js:161,1484`、`prd/2026-11-25-code-review-local-ci.md:275`。

###### R2 — 无成本上限会把配置错误放大成持续费用

- 反例/触发：监听仓库过多、`pollSeconds` 配置过小、失败后自动重试、模型费用高。
- 影响：无人值守时产生意外账单；PRD 已明确不设上限，但缺少启用前费用提示和并发上限。
- 证明所需：任务并发上限、每分钟/每小时请求量的可观测性，以及启用前提示。
- Authority：E1 + E4。
- Source：`prd/2026-11-25-code-review-local-ci.md:90,201`。

###### R3 — 私有 diff 外发缺少首次明确披露

- 反例/触发：用户选择第三方 provider 并开启自动审阅；界面没有说明标题、描述、patch 和可选整文件会离开本机。
- 影响：隐私同意不充分，尤其在自动模式下。
- 证明所需：首次启用/切换 provider 时的数据范围披露与确认。
- Authority：E1 + E4。
- Source：`prd/2026-11-25-code-review-local-ci.md:18,75,142`。

###### R4 — 模型输出直接作为 Markdown 写回，缺少安全边界

- 反例/触发：不可信 diff 诱导模型输出 `@team`、恶意链接、图片、超长正文或伪造 marker；JSON 解析失败时整段 Markdown 被发布。
- 影响：噪音通知、钓鱼链接、意外信息披露、marker 被伪造。
- 证明所需：输出长度、结构、链接、mention、图片和 marker 的净化策略；解析失败与 `max-tokens` 的明确降级状态。
- Authority：E1 + E4。
- Source：`prd/2026-11-25-code-review-local-ci.md:164,283`；`client.js:1575`。

###### R5 — 四态状态模型不足以解释真实运行情况

- 反例/触发：任务被新 SHA 抢占、因 draft/fork/label 跳过、第二个实例只读、发布结果未知、正在对账。
- 影响：全部被塞进“完成/失败”后，用户无法判断是否需要重试。
- 证明所需：skipped/superseded/posting/reconciling/read-only 等用户可理解状态及恢复动作。
- Authority：E1 + E4。
- Source：`prd/2026-11-25-code-review-local-ci.md:86,113,119`。

###### R6 — 配置变更与运行中任务的关系未定义

- 反例/触发：模型、预算、监听仓库或 skip 规则在任务排队/运行时改变；关闭 `post` 后旧任务仍发布。
- 影响：实际行为与当前界面配置不一致。
- 证明所需：配置版本号、任务快照、变更时取消/继续/仅影响新任务的规则。
- Authority：E1 + E4。
- Source：`prd/2026-11-25-code-review-local-ci.md:80,181,194`。

###### R7 — GitHub review 状态与模型 verdict 容易被误解

- 反例/触发：模型输出 `approve`，但实际事件仍是 `COMMENT`；`reviewEvent=request_changes` 与模型 `comment` 同时出现。
- 影响：用户以为已自动批准或错误请求变更。
- 证明所需：明确“模型建议”和“GitHub 实际状态”两套展示，以及事件选择优先级。
- Authority：E1 + E3。
- Source：`prd/2026-11-25-code-review-local-ci.md:158,173,249`。

###### R8 — 回滚不能依赖删除已提交 review

- 反例/触发：错误 review 已发布；GitHub 只允许删除 PENDING review，已提交 review 只能按权限 dismiss 或追加说明。
- 影响：PRD 未给用户可行的纠正路径。
- 证明所需：关闭自动/写回、取消任务、GitHub 对账、dismiss/回复说明的操作流程。
- Authority：E3 + E4。
- Source：GitHub 官方 Delete a pending review / Dismiss a review 文档；`prd/2026-11-25-code-review-local-ci.md:176`。

###### R9 — 目标运行时证据与包版本声明不一致

- 反例/触发：必读运行时是 `0.1.5-rc.3`，包声明 `>=0.2.1-rc.3`，文档称只在 `0.2.1-rc.3` 实测。
- 影响：无法判断新 LLM 契约应在哪个版本验收。
- 证明所需：冻结目标 DSH 版本，并分别记录宿主/客户端/LLM package 版本。
- Authority：E1 + E2。
- Source：`package.json:28`、`docs/DESIGN.zh.md:14`、`dsh-llm/package.json:4`。

##### D. User-Perspective Checks

| 用户问题 | 当前方案 | 结论 |
|---|---|---|
| 我怎样知道功能已关闭？ | 有 `enabled`，但未定义入口、状态页与禁用态展示 | 不足 |
| 自动审阅和写回是不是同一个开关？ | `autoReview` 与 `post` 分离，但未解释组合关系 | 不足 |
| 为什么这次没有审？ | 未展示 draft/fork/own/label/dedup/水位跳过原因 | 不足 |
| 怎样强制重审同一 SHA？ | “同一 SHA 只审一次”，没有明确强制入口 | 阻断，见 B3 |
| 模型建议 approve 是否等于 GitHub approve？ | 未区分建议与实际 review event | 不足，见 R7 |
| 发布失败后怎样避免重复？ | 只有“重试”，没有“先检查 GitHub” | 阻断，见 B6 |
| 任务被新提交抢占后发生了什么？ | 四态没有 superseded/cancelled 说明 | 不足，见 R5 |
| 第二个窗口为什么只能看？ | 未定义锁所有者、只读原因和恢复方式 | 不足 |
| 我的代码发给了谁？ | 仅文档说明，无首次启用披露 | 不足，见 R3 |
| 出错时是否必须读 YAML/源码？ | `allowWrites` 激活路径目前需要内部配置知识 | 阻断，见 B7 |
| 日志能否说明恢复动作？ | 计划有日志查询，但无错误到动作的映射 | 不足 |
| 刷新后能否恢复当前视图和任务？ | 验收要求“不丢状态”，但未定义恢复粒度 | 不足 |

##### E. Implementation Completeness Checks

| 阶段 | 生产路径缺口 | 状态 |
|---|---|---|
| P0 | pulls/files/reviews 分页、head 快照、files 3000 上限未定义 | 不足，B4 |
| P0 | `llm` 服务注入、真实消息构造、目录能力解析未定义 | 不足，B2 |
| P0 | 新客户端文件未进入发布包/下发白名单 | 不足，B8 |
| P0 | 模型服务缺失、provider 无凭据、HMR 路由变化无降级契约 | 未定义 |
| P1 | 手动任务缺少 task/idempotency key、发布前门禁和结果对账 | 不足，B6/B7 |
| P1 | review 未绑定 `commit_id`，inline 映射测试缺失 | 不足，B5 |
| P1 | 设置持久化、校验边界、配置版本与运行中任务关系未定义 | 不足，R6 |
| P1 | 审计只有摘要，不满足请求可重建 | 不足，B2 |
| P2 | SHA-only 去重阻断合法状态转换 | 不足，B3 |
| P2 | 单页 pulls 与水位推进漏审 | 不足，B4 |
| P2 | `gh` 不可取消、发布竞态、崩溃恢复状态机缺失 | 不足，B5/B6 |
| P2 | 文件锁获取失败、陈旧锁、第二个实例行为未定义 | 未定义 |
| P2 | 退避缺少 jitter、Retry-After、并发与队列上限 | 未定义 |
| P3 | 统计口径、时区、取消/失败分母、token 缺失处理未定义 | 未定义 |
| P3 | 右侧栏“审阅”页签与现有项目页签关系未定义 | 未定义 |
| P3 | 日志分页、脱敏、保留期、旋转未定义 | 未定义 |
| 全局 | 194 个 host 测试只是未来门槛；当前文档可追溯的最近数字是 191 | 未验证 |

##### F. Target Benefit Checks

| 收益声明 | 基线 | 目标 | 测量方法 | 当前结果 | 回归风险 |
|---|---|---|---|---|---|
| 本地 CI | 未记录现有 review 流程基线 | DSH 内本地运行 | 未定义；且本方案不执行测试/构建，只是模型审阅 | 未验证 | “CI”名称可能让用户误以为有检查门禁 |
| 30–120 秒完成 | 无 | 验收项 3 | 未定义起止点、PR 规模、模型、p50/p95、样本量 | 未验证 | 大 PR、推理模型、限流会显著超时 |
| 自动发现变更 | 现有插件明确不轮询 | 120 秒轮询 | 未定义发现延迟、漏检率 | 未验证 | 休眠、分页、水位漏审 |
| 审计 | DSH 的请求可重建会话日志 | 自有 JSONL 等价 | 无重建验证 | 当前摘要方案不成立 | 隐私留存与存储权限 |
| 统计与历史一致 | 无 Code Review 历史 | 验收项 7 | 无对账脚本/口径 | 未验证 | 取消、重试、部分成功重复计数 |
| 审阅质量提升/降低噪音 | 无质量基线 | 自有仓库先手动验证 | 无准确率、误报率、噪音率指标 | 未验证 | 自动写回放大模型幻觉 |
| 成本可控 | 无 | 明确不设上限 | 仅 token 展示 | 未验证 | 意外持续费用，见 R2 |

结论：这些目前只能算目标或未验证声明，不能作为已实现收益。

##### G. Required Fixes

- 取得 E0 决策，明确第十章相对 PD2、自动写确认原则和审计约定的效力。
- 按真实 `GenerateOptions` 修正 `purpose`、`maxTokens`、消息构造与 `resolveModelInfo()` 用法。
- 将审计改为可重建记录，或取得用户对“摘要 JSONL 等价物”的正式例外批准。
- 将去重身份从纯 `headSha` 扩展为能表达 draft/ready、skip 资格和强制重跑的触发代次。
- 完整实现 pulls 与 files 分页，并定义水位只在完整扫描成功后推进。
- review POST 必须携带 `commit_id`，并在发布前重新确认 head。
- 扩展 `gh` 执行器以支持取消，或明确取消在发布阶段的边界与对账动作。
- 用持久化发布状态机替代 marker 预检查式幂等，覆盖并发、崩溃和模糊失败。
- 在界面暴露 `allowWrites` 能力与恢复动作，并在实际发布时同时检查 `allowWrites && post`。
- 补齐新客户端文件的打包/下发路径和 `llm` 服务激活契约。
- 增加 skipped/superseded/posting/reconciling/read-only 等用户可理解状态。
- 补充首次代码外发披露、输出净化、错误恢复和已提交 review 的纠正流程。

##### H. Missing Tests

- 默认配置：零新功能定时器、零模型 stream、零 GitHub 写；单独记录既有 auto-bind 行为。
- `llm` 缺失、延迟激活、provider 移除、HMR 后的路由/槽位生命周期。
- `listProviders/listModels/resolveModelInfo/prepareCall` 的真实契约与非法 effort。
- 审计请求重建测试，而不仅是“JSONL 文件存在”。
- 51+ PR 跨页、分页失败、休眠唤醒、水位不推进。
- 61/101/3001 文件、预算优先级、截断声明、二进制/重命名文件。
- ready → draft → ready、移除 skip 标签、同 SHA 强制重跑。
- 手动 + 自动并发、双 profile、marker 超出第一页。
- 模型完成与 POST 之间 head 变化；旧 SHA 不得写到新 head。
- inline 行号的新侧 hunk 校验、删除行、无末尾换行、重命名和失效行。
- 模型流、GitHub 读取、POST 三个阶段的取消；取消后 GitHub 实际结果检查。
- 模型成功后崩溃、POST 成功后崩溃、超时但服务端成功、陈旧文件锁。
- 429/5xx、Retry-After、认证失效、断网、无重试风暴。
- `allowWrites × post × enabled × autoReview` 全矩阵与排队期间配置变化。
- 恶意 diff、提示注入、非法 JSON、超长输出、`max-tokens`、空响应、伪造 marker。
- 用户从界面完成启用、失败恢复、强制重审和日志查看，不需读 YAML。
- 统计与历史逐条对账。
- 当前真实 host 测试基线核对；PRD 的“194”需要有可复现证据。

##### I. Missing Logs / Observability

- 任务 ID、触发原因、触发代次、配置版本、仓库/PR/head/base SHA。
- 输入哈希、字节数、文件总数、实际审阅文件、裁剪/省略清单。
- 模型 provider/model/effort、起止时间、finish kind、token、稳定错误码。
- 发布尝试次数、`commit_id`、marker、review ID、HTTP 结果与对账结果。
- 取消来源与原因：用户、新 SHA、关闭写回、DSH 退出、HMR。
- 水位扫描的页数、起止游标、失败页和“未推进水位”原因。
- 单实例锁所有者、租约、获取失败和陈旧锁恢复。
- 队列深度、运行并发、限流、Retry-After、退避序列。
- 用户可读错误码 → 恢复动作的映射。
- 日志轮转、保留期、访问权限和脱敏规则；普通日志不得包含完整 diff 或凭据。

##### J. Evidence

仓库证据：

- 基线：`git rev-parse HEAD` → `4da3d88e941db8aa10edb070840203c70a2bb8e9`
- `prd/2026-11-25-code-review-local-ci.md:1-293`
- `prd/2026-11-19-github-projects-desktop.md:66-83`
- `docs/CONTRACT.md:35-43,96-120,305-330`
- `docs/DESIGN.zh.md:100-125,1682-1747,2300-2322`
- `package.json:28-80`
- `cordis.patch.yml:10-61`
- `index.js:65-94,117-173,1340-1405,1416-1562`
- `github.js:840-905`
- `state.js:140-229`
- `client.js:15-26,1575-1578,6431-6488`
- `sidebar-api.js:249-301`
- `CHANGELOG.md:17-92`

DSH 运行时证据根目录：`/Users/zhangxu/.dsh/closure/0.1.5-rc.3/node_modules/@deepseek-ai/`

- `dsh-llm/README.md:12,68-70,108-115`
- `dsh-llm/lib/typert.host.js:286-287`
- `dsh-llm/lib/index.js:2018-2091,2103-2175,2223-2323`
- `dsh-session-title-llm/lib/index.js:184-238`
- `dsh-base/cordis.patch.yml:27-28,84-109,482-487`
- `dsh-cordis-client-runner/lib/client.js:3372-3400,4116-4158`
- `dsh-client-ui-sidebar/lib/client.js:106-131,338-406`
- `dsh-client-ui-layout/lib/client.js:397-425`

官方外部证据：

- GitHub Create a review：<https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request>
- GitHub List reviews：<https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request>
- GitHub List pull requests / List pull request files：<https://docs.github.com/en/rest/pulls/pulls#list-pull-requests>
- GitHub REST pagination：<https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api>
- GitHub Draft pull requests：<https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests#draft-pull-requests>

执行约束确认：只读审查；未修改文件，未运行测试、e2e、真实写入或付费模型调用。

### Main Agent Response

#### 审查者发现复核

| Reviewer | Finding | Severity | Decision | Authority | Evidence / Reason | Action Taken | Follow-up |
|---|---|---|---|---|---|---|---|
| r1-user-experience | B1 产品权威/PD2/自动写冲突 | blocking | accept（有限定） | E1 + E0 gap | 第十章确实没有 protected section、PD ID 或直接确认证据；PD2 与 `docs/DESIGN.zh.md:2320` 构成需要澄清的既有边界。但 Code Review 是新功能，不能仅凭 PD2 断言必然冲突；必须由用户确认效力边界。 | 记录为方案状态 `needs-revision`；未改 PRD。 | 用户确认中央工作台、自动发布与审计例外后再开工。 |
| r1-user-experience | B2 LLM 契约/审计 | blocking | accept（修正表述） | E2 + E3 | `GenerateOptions.purpose` 仅允许 `compaction/session-title`；`listModels()` 不含 context/effort，需 `resolveModelInfo()`；摘要 JSONL 无法重建请求。PRD 第 127 行确实提到 `resolveModelInfo()`，因此不指控其完全没用，但要求明确映射。 | 记录为阻断；未改代码。 | 修正 purpose/maxTokens/message 构造，保存校验句柄即丢弃，审计存完整请求/响应或取得例外。 |
| r1-user-experience | B3 SHA-only 去重阻断状态转换 | blocking | accept | E1 + E3 | `draft→ready` 是明确触发条件，但纯 SHA 键会阻断 ready→draft→ready；手动重审/改模型重审也无语义。 | 记录为阻断。 | 引入触发代次/资格状态与强制重审规则。 |
| r1-user-experience | B4 pulls/files 分页与水位漏审 | blocking | accept | E3 | 官方 API 明确 pulls `per_page` 最大 100、files 默认 30/最大 100/总上限 3000；单页后推进水位会永久漏候选。 | 记录为阻断。 | 完整分页、截断声明、每仓库水位仅在完整扫描成功后推进。 |
| r1-user-experience | B5 head 绑定与 gh 取消 | blocking | accept | E2 + E3 | review POST 省略 `commit_id` 时默认最新 head；现有 `createExecRunner` 没有 `AbortSignal`。 | 记录为阻断。 | POST 固定 `commit_id`、发布前复核 head、扩展 gh 执行器取消与对账。 |
| r1-user-experience | B6 marker 非幂等/崩溃恢复 | blocking | accept | E2 + E3 | marker 查询有分页和检查-发布竞态；POST 成功后本地崩溃会留下未知结果。 | 记录为阻断。 | per-key single-flight、持久化发布意图/结果、模糊失败 marker 对账；跨 profile 风险由用户决定。 |
| r1-user-experience | B7 默认用户无法从界面开启写回 | blocking | accept | E1 + E2 | `allowWrites` 默认 false 且是宿主静态配置；PRD 只给 `post` 开关，主流程可能先付费再发现不能发布。 | 记录为阻断。 | 明确四开关能力矩阵与界面恢复动作；发布时双重门禁。 |
| r1-user-experience | B8 P0 客户端/llm 接线缺失 | blocking | accept | E2 | 新文件未进入 `package.json.files`/`SIDEBAR_CLIENT_FILES`，`index.js` 也未声明 llm 激活/降级契约。 | 记录为阻断。 | 补打包、下发、locale、动态 import、llm 可选注入与 HMR 清理。 |
| r1-user-experience | R1 默认零行为措辞 | non-blocking | accept | E2 | `autoBind` 默认 true，仍有既有后台行为；验收应限定“Code Review 新功能”。 | 记录为文案风险。 | 修改验收措辞并分别探针旧/新功能。 |
| r1-user-experience | R2 无成本上限放大费用 | non-blocking | accept（不恢复成本上限） | E1 | 用户已明确不设成本上限；不能以此推翻决定。但队列并发、请求速率和启用提示仍是必要的工程/UX 保护。 | 记录为运维风险。 | 补并发/队列/速率可观测性，不增加每小时/每日费用硬上限。 |
| r1-user-experience | R3 私有 diff 外发披露 | non-blocking | accept | E1 | PRD 第 18 行只提 diff，第 142 行实际还会发送标题、描述和可选整文件。 | 记录为隐私风险。 | 首次启用/切换 provider 披露完整数据范围。 |
| r1-user-experience | R4 模型输出安全边界 | non-blocking | accept | E1 + E4 | 解析失败会整段发布；提示注入可影响正文、verdict、mention/链接和 marker。 | 记录为安全风险。 | 输出 schema/长度/链接/mention/marker 净化，区分解析失败与流失败。 |
| r1-user-experience | R5 四态不足 | non-blocking | accept | E1 | 取消、抢占、跳过、发布未知、对账、只读实例无法用四态表达。 | 记录为 UX 风险。 | 扩展用户可理解状态与恢复动作。 |
| r1-user-experience | R6 配置变更与任务关系 | non-blocking | accept | E1 | 排队/运行中修改模型、post、watchRepos 的语义未定义。 | 记录为一致性风险。 | 配置版本 + 任务快照 + 变更规则。 |
| r1-user-experience | R7 verdict 与 GitHub event 混淆 | non-blocking | accept | E1 + E3 | `approve` 只是模型建议，实际默认 `COMMENT`；需要双栏语义。 | 记录为 UX 风险。 | 明确事件优先级并展示“建议/实际状态”。 |
| r1-user-experience | R8 已提交 review 无法删除回滚 | non-blocking | accept | E3 | 已提交 review 不能 DELETE，只能 dismiss 或追加说明。 | 记录为恢复风险。 | 提供关闭自动/写回、对账、dismiss/说明链接与操作流程。 |
| r1-user-experience | R9 版本声明不一致 | non-blocking | reject（原结论）；接受环境冻结缺口 | E2 | Desktop `runtime.json` 显示 `0.2.3-alpha.2`，closure 包为 `0.1.5-rc.3`；这是不同版本线，不能仅凭包版本断言不一致。真正缺口是 PRD 未冻结验收环境。 | 记录更正。 | 在 P0 记录 desktop/client/llm/gh/node 版本，不写死只适配一个版本。 |

#### 主代理补充发现

| ID | Severity | Decision | Authority | Finding / Counterexample | Evidence | Required Plan Change |
|---|---|---|---|---|---|---|
| M1 | blocking | accept | E1 + E2 + E3 | “代码 diff 只发送到选定 provider，其余本地”不准确：标题、描述、可选整文件也会发送；`ctx.llm.stream` 还经过可观察/改路由的 waterfall middleware。 | PRD `:18,142`；`dsh-llm/README.md:39-48`；`dsh-llm/lib/index.js:2306-2307` | 把隐私边界改为“选定 adapter + 宿主 llm middleware 可见”，首次启用披露完整数据范围。 |
| M2 | blocking | accept | E2 + E3 | PRD 把 JSON 解析失败与模型流失败混为一谈；`finish.kind=max-tokens/error/aborted` 时 Partial 输出可能被当完整结果发布。 | PRD `:126,135,164`；`dsh-llm/README.md:68-70`；`dsh-session-title-llm/lib/index.js:228-238` | 先判定 terminal finish，再解析；流错误/取消不发部分结果，max-tokens 标降级；做 JSON schema 校验。 |
| M3 | blocking | accept | E1 + E2 | 取消、HMR、配置热更新和重启恢复没有生命周期契约；现有 gh 不可取消，旧 running 记录可能永久悬挂。 | PRD `:112,118-120,181`；`github.js:840-855`；项目 `AGENTS.md` 热重载要求 | 所有 timer/task/lock 由 effect 持有；定义配置版本与任务快照；重启把 running 结算为 interrupted/reconciling。 |
| M4 | blocking | accept | E1 + E3 | 200 KB/60 文件不是 token 预算；未减输出预留、无保守估算，未知 context 时无法保证“大 PR 明确降级”。 | PRD `:136,144-151`；`dsh-token-meter/README.md:28,32,66,136` | 用 contextWindow − maxTokens − safety 建预算；保守估算；未知容量失败关闭；写明确认降级阶梯。 |
| M5 | blocking | accept | E2 + E3 | 现有 `classifyGhError` 不保留 429/5xx/Retry-After，无法实现 PRD 的精确退避。 | `github.js:88-108`；PRD `:176`；GitHub rate-limit 文档 | 扩展 gh 错误元数据，区分主/次限流，尊重 Retry-After/x-ratelimit-reset，加 jitter。 |
| M6 | blocking | accept | E1 + E3 | 水位风险表声称能避免休眠补跑，实际“只处理晚于水位”会补跑全部积压；无队列上限/并发会把积压变成 API/费用突发。 | PRD `:90,117,201,284`；GitHub secondary rate limits | 用户选择“补跑但合并/限流”或“长间隔后跳过积压”；定义每仓库串行、全局并发与有界队列。 |
| M7 | non-blocking | accept | E1 | `watchRepos = 派生集合 ∪ 手工集合` 让用户无法排除当前工作区仓库；`[]` 也无法表达“不监听任何仓库”。 | PRD `:79,98,193` | 增加 exclude 或明确 watch 列表覆盖语义；启用/禁用矩阵说清。 |
| M8 | non-blocking | accept | E1 + E2 | 本地 API 不鉴权，`POST /code-review/run` 可被同 OS 用户进程触发付费调用；现有威胁模型接受同用户信任，但新副作用更重。 | `docs/DESIGN.zh.md:1715-1716,1740-1743`；PRD `:232` | 沿用既有威胁模型但限制手动 repo 在 watch/显式范围，文档披露残余风险；是否加进程级 token 由用户决定。 |
| M9 | blocking | accept | E1 + E2 | 方案没有契约/文档/测试/打包工作单元；现有 CONTRACT 明说唯一 GitHub write 和 host import 限制，DESIGN 仍停在 1.1.0。 | `docs/CONTRACT.md:39,67,305`；`docs/DESIGN.zh.md:10`；PRD `:205-241,255-275` | P0–P3 增加 CONTRACT/DESIGN/README/CHANGELOG、package files、白名单、locale、mock/fixture、定向测试与干净安装 smoke。 |
| M10 | non-blocking | accept | E1 + E2 | 194 tests 是过期固定数字；当前树可检索到更多 `test(` 调用，且未授权运行测试。 | PRD `:275`；`package.json:3`；`CHANGELOG.md:86` | 验收记录当次实际测试结果，不写死历史数量；真实 PR/模型 smoke 需单独授权。 |
| M11 | non-blocking | accept | E1 | fork 检测若用 `head.repo.fork`，base 本身是 fork 时会误跳过；整文件上下文若从 base repo 取 SHA，fork head 可能 404。 | PRD `:113,142,250` | 用 head/base repo id 判断跨仓库；fork 开启时从 head repo 取上下文并处理删除/重命名。 |
| M12 | non-blocking | accept | E1 | “本地 CI”实际不运行测试/构建/检查门禁，只是模型审阅；名称可能误导。 | PRD `:8,13,21-25` | 文案明确“本地 AI review runner”，除非后续真的接 check/status。 |

#### Required Fixes / Missing Tests / Missing Observability 逐项复核

| Item | Decision | Authority / Reason | Linked Finding |
|---|---|---|---|
| G-1 取得 E0 决策 | accept | E0 gap；当前不能自行改写产品权威 | B1 |
| G-2 修正 GenerateOptions/message/catalog | accept | E2/E3 真实契约 | B2、M1 |
| G-3 可重建审计或正式例外 | accept | E3 DSH invariant | B2 |
| G-4 扩展去重身份 | accept | E1 内部矛盾 | B3 |
| G-5 pulls/files 分页与水位门槛 | accept | E3 API 限制 | B4、M6 |
| G-6 review 固定 commit_id | accept | E3 默认最新 head | B5 |
| G-7 gh 可取消 | accept | E2 现有 runner 不支持 | B5、M3 |
| G-8 持久化发布状态机 | accept | E2/E3 崩溃与竞态 | B6 |
| G-9 allowWrites/post 能力与恢复 | accept | E1/E2 默认主流程断裂 | B7 |
| G-10 客户端打包/llm 激活 | accept | E2 生产路径缺失 | B8 |
| G-11 扩展用户可理解状态 | accept | E1 四态不足 | R5 |
| G-12 外发披露/输出净化/纠正流程 | accept | E1/E3/E4 | R3、R4、R8、M1、M2 |
| H-1 默认零新功能行为探针 | accept | E2；与既有 autoBind 分开 | R1 |
| H-2 llm 缺失/延迟/HMR | accept | E2 | B8、M3 |
| H-3 llm 目录/effort 契约 | accept | E2/E3 | B2 |
| H-4 审计请求重建 | accept | E3 | B2 |
| H-5 51+ PR/分页失败/水位 | accept | E3 | B4、M6 |
| H-6 61/101/3001 文件与预算 | accept | E3/E1 | B4、M4 |
| H-7 ready→draft→ready/skip/force | accept | E1/E3 | B3 |
| H-8 手动+自动并发/marker 分页 | accept | E2/E3 | B6 |
| H-9 模型完成与 POST 间 head 变化 | accept | E3 | B5 |
| H-10 inline hunk/删除/重命名/失效行 | accept | E3 | B5 |
| H-11 三阶段取消及 GitHub 实际结果 | accept | E2/E3 | B5、M3 |
| H-12 模型/发布后崩溃与模糊失败 | accept | E2/E3 | B6、M3 |
| H-13 429/5xx/Retry-Auth/断网 | accept | E3 | M5 |
| H-14 四开关矩阵与运行中变更 | accept | E1/E2 | B7、R6 |
| H-15 恶意 diff/JSON/max-tokens/marker | accept | E1/E2 | M2、R4 |
| H-16 界面启用/恢复/强制重审/日志 | accept | E1；需 E0 确认交互边界 | B3、B7、R5 |
| H-17 统计与历史对账 | accept | E1 | 收益/验收风险 |
| H-18 当前 host 测试基线 | accept | E2；不得沿用过期 194 | M10 |
| I-1 task/trigger/config/head/base 标识 | accept | E1 可诊断性 | B6、M3 |
| I-2 输入哈希/字节/文件/裁剪清单 | accept | E1 降级可解释 | M4 |
| I-3 provider/model/effort/finish/token/error | accept | E2/E3 | B2、M2 |
| I-4 发布尝试/commit_id/marker/review/对账 | accept | E2/E3 | B5、B6 |
| I-5 取消来源与原因 | accept | E1 | M3、R5 |
| I-6 水位页数/游标/失败/未推进 | accept | E3 | B4、M6 |
| I-7 锁所有者/租约/陈旧锁 | accept | E1/E4 | B6、M3 |
| I-8 队列/并发/限流/退避 | accept | E3 | M5、M6 |
| I-9 错误码到恢复动作 | accept | E1 UX | B7、R5 |
| I-10 日志轮转/保留/权限/脱敏 | accept（需区分安全审计） | E1/E3；普通日志脱敏，受保护审计保存可重建内容 | B2、R3 |

#### 待用户确认的产品决定

| ID | Decision Surface | Current / Proposed Behavior | Why Material | Evidence | Impact If Changed |
|---|---|---|---|---|---|
| PD-CR1 | 中央工作台与 PD2 的关系 | 新 PRD 提议一级入口 + 中央工作台；PD2 要求既有项目管理留右侧栏 | 改变信息架构与既有权威边界 | PRD `:31,55,253`；既有 PRD `PD2` | 可能需把配置/状态移入右侧栏，或明确 PD2 不覆盖 Code Review |
| PD-CR2 | 自动模式写回确认 | `autoReview + post` 后无需每次确认发布 review | 外部副作用与通知/阻塞风险 | PRD `:80,173,247`；DESIGN `:2320` | 可能改为每次发布前确认，或仅手动发布 |
| PD-CR3 | 同 SHA 强制重审 | 当前“同一 SHA 只审一次”与“重新审阅”按钮冲突 | 决定去重键、费用和重复评论 | PRD `:59,111,271` | 可能需要 trigger generation 或新 marker suffix |
| PD-CR4 | 休眠/离线积压 | 当前水位会补跑积压，但风险表声称避免集中补跑 | 决定突发费用/API 用量与漏审 | PRD `:117,284` | 可改为合并到最新 SHA、限流补跑或长间隔后跳过 |
| PD-CR5 | approve 与 REQUEST_CHANGES 纠正 | 模型 `approve` 仅建议；REQUEST_CHANGES 误报后的 dismiss/说明流程未定 | 影响合并阻塞与用户控制 | PRD `:158,173,249` | 可能永不自动 APPROVE，并需人工 dismiss 路径 |
| PD-CR6 | watchRepos 覆盖/排除 | 当前派生集合 ∪ 手工集合无法排除派生仓库 | 用户无法精确控制监听范围 | PRD `:79,98,193` | 可增加 exclude 或让显式列表覆盖派生集合 |
| PD-CR7 | 代码外发范围 | 标题、描述、patch、整文件 + llm middleware 均可见 | 隐私披露与 provider 选择 | PRD `:18,142`；DSH waterfall | 需用户确认接受该信任边界 |
| PD-CR8 | 审计内容 | 摘要 JSONL 还是完整可重建请求/响应 | 隐私留存、存储与 DSH invariant | PRD `:183,286`；DSH README `:110` | 完整审计更安全可验证，但留存更多代码内容 |


### Review Governor

- Completed rounds before decision: 1
- Automatic round budget: 2
- Unresolved blockers before round: 0
- Unresolved blockers after round: 15 条记录，归并为 12 个阻断类别
- Blockers closed: none（本轮只读审查，未修改方案）
- New blocker classes: 产品权威、LLM/审计/隐私、状态转换、分页/水位、发布 head/取消、幂等/恢复、写回启用、生产接线、上下文预算、gh 退避、生命周期/热更新、输出安全
- Repeated failure class: yes — LLM/审计在 B2/M1/M2 重复出现；发布可靠性在 B5/B6/M3 重复出现
- Closure findings admissible: n/a（未实施修复，不启动 closure round）
- Scope expansion proposed: no
- Scope expansion authority: n/a
- New top-level modules: none
- New dependencies: none
- Public API or persistent data changes: none
- New cross-module abstractions: none
- Cumulative scope and complexity growth: 仅新增本报告；被审查 PRD 与代码未变
- Benefit versus side effects: 方案方向可能成立，但当前文档不足以证明收益，且存在重复评论、错挂 SHA、隐私误披露和突发费用风险
- Rollback evaluation required: no（无目标修改）
- Governor decision: `user-decision-required`
- Decision reason: 8 个审查者阻断项均成立，主代理另确认 7 条阻断记录；其中多项涉及 PD2 效力、自动写回、强制重审、积压处理、审计内容等 E0 产品决定。未获得修改 PRD/产品决定的授权，因此不能自动修复或启动 closure review。

### Convergence Reflection

- Original objective: 审查本地 Code Review PRD 是否可直接、安全实施。
- Acceptance criteria: 证据化区分阻断/风险；核对产品权威、LLM/GitHub 契约、失败恢复、隐私、验收与生产接线。
- Explicit non-goals: 不实施、不改 PRD/代码/配置、不运行测试/真实写入/付费调用、不发布。
- Completed rounds versus budget: 1 / 2；未启动第二轮，因为尚无经授权的修复可复核。
- Findings closed: none。
- Findings repeated: LLM/审计（B2/M1/M2）；发布可靠性（B5/B6/M3）。
- Findings newly introduced: M1–M12，其中 M1–M6、M9 为阻断。
- Evidence inventory by E0–E4:
  - E0: 用户只要求审查；新的产品边界尚未直接确认。
  - E1: 本 PRD、既有 PRD、CONTRACT/DESIGN、项目 AGENTS。
  - E2: 当前代码、已安装 DSH 0.2.3-alpha.2 / closure 0.1.5-rc.3 源码。
  - E3: DSH 包 README/类型、GitHub REST 官方文档。
  - E4: 竞态、提示注入、运维突发等反例推理，均已有 E1–E3 支撑才升级为阻断。
- Newly touched files and modules: `vs_review/2026-11-25-code-review-local-ci-review.md`。
- New APIs, dependencies, data, operations, or abstractions: none。
- Cumulative code and complexity growth: 0 行产品代码；1 份审查报告。
- Benefits actually achieved: 在开工前识别出会使评论错挂、重复发布、静默漏审、审计失真和默认主流程断裂的问题。
- Side effects and regressions: 无运行时副作用；未执行测试或外部调用。
- Risk direction: 若不修订，实施风险高；修订后可下降，但需用户先确认产品边界。
- Last known-good checkpoint: `4da3d88e941db8aa10edb070840203c70a2bb8e9`。
- Rollback options: 无需回滚产品变更；如不需要审查产物，可单独移除本报告。
- Recommended bounded choices:
  1. 先确认 PD-CR1–PD-CR8，再修订 PRD（推荐）。
  2. 缩窄到 P0 只读技术验证：真实 DSH LLM 目录/流契约 + GitHub 分页 fixture，不写回、不自动跑。
  3. 接受部分风险并明确记录，但不得把 E4 风险当作已解决。
  4. 改变方案路径，例如只做手动审阅、暂不开放自动写回。

### User Decision

- Decision requested: 确认产品边界并授权修订 PRD，或选择缩窄范围/接受风险。
- Options and consequences:
  - 确认并修订：可消除产品权威冲突，再进入 P0；需要用户对 PD-CR1–PD-CR8 逐项表态。
  - 只做 P0 只读验证：最快验证 LLM/GitHub 契约，但不能交付手动发布或自动审阅。
  - 接受风险继续实施：可能产生重复/错挂评论、漏审、隐私误披露和费用突发。
  - 改变路径：例如仅手动、仅 `COMMENT`、不自动写回，显著降低风险。
- User decision: pending
- Approval evidence: n/a
- Authorized next scope: 仅只读审查；修改 PRD 或实施需新的明确授权。

### Closure Status

- Blocking findings found: yes
- Accepted blocking findings fixed: no
- Blocking re-review completed: no
- Blocking re-review passed: no
- Blocking re-review round links: n/a
- Blocking re-review launch records: n/a
- Rejected findings backed by evidence: yes（R9 的版本不一致原结论被 `runtime.json` 证据否决）
- Deferred findings documented: yes（成本硬上限按用户既有决定不做；其余纳入修订）
- Implementation completeness gaps resolved or accepted by user: no
- Target benefit warnings recorded: yes
- Automatic round budget respected: yes
- Third-or-later round explicitly user-approved before launch: n/a
- Scope drift detected: no
- Evidence sufficient for scope-expanding actions: no；本轮未实施扩范围修复
- Convergence reflection required and recorded: yes
- Control outcome: user-decision-required
- Blocked reason: 产品边界待 E0 确认，且 PRD 存在多个技术契约与恢复语义缺口
- Allowed to proceed: review only；按当前文档不允许进入实施

## Final Conclusion

**方案方向可行，但当前 PRD 不能直接开工，状态应为 `needs-revision` / `blocked-on-user-decision`。**

最关键的修订顺序是：

1. 先确认产品权威与边界：中央工作台 vs PD2、自动写回是否需逐次确认、同 SHA 强制重审、积压处理、审计内容。
2. 修正 DSH LLM 契约：自定义 `purpose` 不可用；明确 `maxTokens`、`Message` 构造、`resolveModelInfo()` 与 terminal finish 处理；审计必须可重建或取得正式例外。
3. 修正 GitHub 正确性：pulls/files/reviews 全分页、每仓库水位、`commit_id` 固定 head、发布前复核、gh 可取消、持久化发布对账。
4. 补齐运行可靠性：有界队列/并发、429/5xx Retry-After、HMR/退出清理、重启恢复、配置版本与任务快照。
5. 补齐生产交付：package files、客户端白名单/locale/动态 import、llm 可选注入、CONTRACT/DESIGN/测试/干净安装 smoke。

本轮未修改 PRD 或代码，未运行测试、e2e、真实 GitHub 写入或付费模型调用。
