# DSH 内的 GitHub Projects

| 项目 | 内容 |
| --- | --- |
| 状态 | Draft · 产品方向已确认 |
| 更新 | 2026-11-19 |
| 范围 | DSH Desktop 内的 GitHub Projects 日常浏览和编辑 |
| 实现基线 | [现有产品设计](../docs/DESIGN.zh.md) · [现有插件契约](../docs/CONTRACT.md) |

## 产品方向

把 GitHub Projects 带进 DSH。用户已经熟悉保存的视图、筛选栏、看板列、表格单元格和条目侧栏，常用动作应保留相同的入口、含义和结果。简化的是首版功能范围。使用 DSH 的主题、组件与窗口布局，保留工作区绑定项目和会话绑定 Issue 两个入口。

首版建议覆盖**已有视图、看板、表格、条目详情、添加条目**。成功的标准是用户从已有的 GitHub 项目视图开始，能直接筛选、调整状态、改 Issue、发评论和继续下一张卡片，不必学习新的操作流程。

## 布局与操作映射

| GitHub Projects 的入口 | DSH 中的行为 |
| --- | --- |
| 项目名称 → 已保存视图 | 顶部按 GitHub 项目的实际视图名称和顺序显示页签。每个页签保留自己的布局、筛选和字段。同一个项目可以有多个看板或表格视图。 |
| 筛选栏 → 「视图」菜单 | 使用 GitHub 常见筛选语法和候选项，如仓库、标签、负责人和项目字段。菜单提供布局、列字段、分组、排序、可见字段。临时调整留在当前视图，显式保存后才影响 GitHub 上的共享视图。 |
| 看板列 → 卡片 | 使用该视图配置的列字段与选项。点标题打开详情，跨列拖动修改对应字段，卡片菜单提供键盘可达的「移动到」和「归档」。已排序的看板保留跨列移动，列内顺序由排序规则决定。 |
| 表格 → 字段单元格 | 保留一行一个条目、一列一个字段的表格。点标题打开详情，在 Status、Priority 等单元格直接改值，焦点返回编辑过的单元格。 |
| 卡片或行标题 → 条目侧栏 | 在项目右边打开条目。标题和正文分别就地编辑，正文下是讨论和评论框，旁边是负责人、标签、里程碑与项目字段。关闭后回到原来的视图、筛选和条目。 |
| 列底部或表格底部 → 添加条目 | 直接输入标题可创建草稿，也可选择「添加现有条目」或「创建 Issue」。在可写字段分组中发起时，沿用该组的字段值。 |
| DSH 会话入口 | 项目右栏打开任意条目时保留当前会话。在条目菜单显式「绑定到当前会话」后，才改变会话的 `issue` 页签所指向的 Issue。 |

官方依据：[管理视图](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/managing-your-views) · [看板布局](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-board-layout) · [表格布局](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-table-layout) · [详情侧栏](https://github.blog/changelog/2022-12-22-github-issues-december-22nd-update/) · [添加条目](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project/adding-items-to-your-project)

## 桌面细节

- 首次打开沿用项目的视图顺序。再次打开可回到上次使用的视图。原来只支持插件内「泳道 / 列表」的用户也从同一个项目页签进入。
- 视图名、列名、字段名和选项使用 GitHub 上的实际文本。控件使用 DSH 界面语言，例如「视图」「添加条目」「编辑正文」。项目字段 Status 和 Issue 的开启或关闭分别显示。
- 项目可在 DSH 右栏与对话并排，也可使用 DSH 的面板展开。详情通常和视图并排。窄栏优先保证详情可读，通过「返回项目」和 `Esc` 返回，恢复筛选、横纵滚动和来源焦点。打开详情保留视图布局，窄看板允许横向滚动。
- 表格字段使用与字段类型对应的控件。单选和迭代用选项，日期用日期控件，数字用数字输入。支持聚焦后用 `Enter` 或 `Space` 激活选择，用 `Esc` 关闭。字段权限取决于项目或条目所在仓库。
- 工作区和会话的 DSH 专属动作放在既有入口或条目菜单，视图主工具栏只放项目操作。
- 沿用 DSH 的浅色与深色主题、字号和焦点样式。看板用紧凑卡片，表格保持字段对齐。少用面板套面板，依靠行、列和分隔线区分信息。状态颜色同时配文字。

## 首版范围建议

1. **项目视图**。读取 GitHub 上已有的视图名、顺序、布局与筛选。实现 Board 和 Table。读取分组、排序和可见字段；识别并明确标出首版尚未能呈现的视图或规则。
2. **卡片和表格**。卡片直接打开、跨列拖动和菜单移动、常用字段的单元格编辑、归档。保存视图时只显示公开接口支持的写入项。设备内的临时筛选、分组或排序按可用能力开放，标明「仅此处」的状态。
3. **详情和添加**。Issue 正文、评论、标题、负责人、标签、里程碑、开关和项目字段。支持添加已有 Issue 或 PR、创建 Issue、创建草稿。草稿可读写正文和项目字段。PR 先显示概要和可用项目字段，审查、检查和合并流程另行设计。
4. **随后补齐**。Roadmap、手动排序、批量操作、归档恢复、更完整的 PR 详情。Insights、工作流和项目权限属于管理入口，根据公开 API 的实际覆盖另行决定。

创建 Issue 与加入项目分别呈现结果。创建成功、加入失败时显示已创建的 Issue，重试只执行加入。正文和评论在发送失败后保留草稿。表格编辑、拖动和详情字段写入成功后更新当前项目与会话已绑定的同一 Issue。结果未知时先重新读取。检测到相同字段被外部修改时，让用户查看最新值并保留自己的草稿。

## API 边界与待确认项

- 公开接口可写共享视图的名称、布局、筛选和可见字段，分组和排序可读。首版建议让用户读取和临时调整这些配置，共享写入只开放 API 支持的部分。对没有首版支持的 Roadmap 和复杂过滤，标明实际状态并提供原视图入口。 [视图字段](https://docs.github.com/en/graphql/reference/projects#projectv2view) · [视图更新](https://docs.github.com/en/graphql/reference/projects#updateprojectv2viewinput)
- 建议沿用现有 `gh` 登录和显式开启写入。打开面板及窗口回到前台时刷新，可见期间低频刷新，由实际请求量确定间隔。首版范围、写入策略和同步策略仍待确认。
- 已匿名核对 GitHub Public Roadmap 的页面结构。私有项目、编辑权限差异和更新后的 DSH 宿主行为仍需在实现阶段按批准的范围验证。 [GitHub Public Roadmap](https://github.com/orgs/github/projects/4247)

## 首版验收

| 场景 | 预期 |
| --- | --- |
| 打开有多个已保存视图的项目 | 按 GitHub 的视图名和顺序出现，并分别应用各自的布局、筛选和字段。 |
| 使用熟悉的筛选语法切到自己的任务 | 结果和 GitHub 的同一筛选一致。未支持的条件有明确提示。 |
| 在表格修改 Priority、从看板移动同一条目 | 表格和卡片反映同一条数据。拖动改的是当前列字段。 |
| 打开任务、修改正文或负责人、发表评论、关闭详情 | 全程留在 DSH。关闭后恢复项目视图位置和焦点，当前会话绑定保持原值。 |
| 从 Todo 列添加条目 | 可选择已有条目、Issue 或草稿。成功后显示在 Todo；若只完成了创建，界面提供补做加入。 |
| 临时改排序，或明确保存可见字段 | 本地排序只影响当前用户看到的结果，显式保存的可见字段才会同步到 GitHub。 |
| 权限不够、保存失败或有同字段冲突 | 在原操作位置给出原因和恢复动作，草稿和会话内容可继续使用。 |

## Confirmed Product Decisions

> PROTECTED USER-AUTHORITY SECTION
> Rows in this section MUST NOT be created, modified, deleted, reinterpreted,
> or superseded without explicit user approval for that specific decision change.
> Agent self-approval is forbidden.

| ID | Confirmed Decision | Must Do | Must Not Do | Rationale | Violation Signal | Confirmation | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PD1 | DSH 的 Projects 界面是 GitHub 官方版本的简化版 | 让大部分常用交互沿用 GitHub Projects 的入口和操作习惯 | 为常用流程另建一套交互 | 用户可把已有经验带进 DSH | 能力相同却需要重新学习核心入口或操作步骤 | user-confirmed-direct，2026-11-19，「整体上我想要GitHub官方的projects界面的一个简化版，绝大部分能力交互直接复刻官方的设计，这样对用户来说最熟悉，不要自己设计一套」 | active |
