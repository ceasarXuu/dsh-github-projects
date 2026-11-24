export const SIDEBAR_STYLE = `
.ghp-management { box-sizing: border-box; height: 100%; overflow: auto; padding: 12px; width: 100%; }
.ghp-management [hidden] { display: none !important; }
.ghp-management :is(h2,h3,p) { margin: 0 0 7px; }
.ghp-management h2 { font-size: 17px; overflow-wrap: anywhere; }
.ghp-management h3 { font-size: 13px; }
.ghp-management :is(input,select,textarea) {
  box-sizing: border-box; min-width: 0; max-width: 100%; background: var(--ghp-surface-sunken);
  color: inherit; font: inherit; border: 1px solid var(--ghp-border-strong); border-radius: 6px; padding: 5px 6px;
}
.ghp-management :is(button,summary,input,select,textarea,a):focus-visible { outline: 2px solid var(--ghp-accent-brand); outline-offset: 2px; }
.ghp-management :is(summary,.ghp-m-item-title) { cursor: pointer; }
.ghp-management :is(.ghp-m-section,.ghp-m-form,.ghp-m-thread,.ghp-m-metadata) { display: grid; gap: 8px; }
.ghp-management .ghp-m-form > label { display: grid; gap: 4px; }
.ghp-management :is(.ghp-m-row,.ghp-m-inline,.ghp-m-tabs) { display: flex; align-items: center; gap: 6px; }
.ghp-management .ghp-m-row { flex-wrap: wrap; }
.ghp-management .ghp-m-spread { justify-content: space-between; }
.ghp-management .ghp-m-inline :is(input,select) { flex: 1; }
.ghp-management .ghp-m-filter { flex: 1 1 224px; }
.ghp-management :is(.ghp-m-board,.ghp-m-table-scroll,.ghp-m-tabs) { overflow-x: auto; padding-bottom: 5px; }
.ghp-management .ghp-m-tabs { margin: 10px 0; border-bottom: 1px solid var(--ghp-border); }
.ghp-management .ghp-m-tabs button { flex: 0 0 auto; }
.ghp-management .ghp-m-tabs [aria-pressed="true"] { color: var(--ghp-accent-brand); border-color: currentColor; }
.ghp-management .ghp-m-muted { color: var(--ghp-text-secondary); }
.ghp-management .ghp-m-options { flex: 1 1 100%; }
.ghp-management .ghp-m-options-panel, .ghp-management .ghp-m-notice {
  border: 1px solid var(--ghp-border); border-radius: 8px; padding: 8px; margin: 7px 0;
}
.ghp-management [role="alert"] { color: var(--ghp-accent-error); overflow-wrap: anywhere; }
.ghp-management .ghp-m-lanes { display: flex; gap: 8px; margin: 4px 0 8px; }
.ghp-management .ghp-m-lane {
  flex: 1 0 145px; min-width: 145px; min-height: 100px; box-sizing: border-box; padding: 8px;
  background: var(--ghp-surface-sunken); border: 1px solid var(--ghp-border); border-radius: 8px;
}
.ghp-management .ghp-m-lane[data-drop-target] { border-color: var(--ghp-accent-brand); }
.ghp-management .ghp-m-card { background: var(--ghp-surface-raised); border: 1px solid var(--ghp-border); border-radius: 7px; padding: 8px; overflow-wrap: anywhere; }
.ghp-management .ghp-m-lane .ghp-m-card { margin-bottom: 7px; }
.ghp-management .ghp-m-item-title { display: inline-block; padding: 2px 0 4px; text-align: left; color: inherit; font: inherit; font-weight: 600; background: none; border: 0; overflow-wrap: anywhere; }
.ghp-management .ghp-m-item-title:hover { color: var(--ghp-accent-brand); text-decoration: underline; }
.ghp-management .ghp-m-menu-actions { display: grid; gap: 5px; padding: 4px 0; justify-items: start; }
.ghp-management .ghp-m-chip { padding: 1px 5px; font-size: 11px; border: 1px solid var(--ghp-border); border-radius: 5px; max-width: 100%; overflow-wrap: anywhere; }
.ghp-management .ghp-m-table { border-collapse: collapse; width: 100%; margin: 7px 0; }
.ghp-management .ghp-m-table :is(th,td) { min-width: 90px; border: 1px solid var(--ghp-border); text-align: left; padding: 5px 7px; vertical-align: top; }
.ghp-management .ghp-m-table th { background: var(--ghp-surface-raised); white-space: nowrap; }
.ghp-management .ghp-m-table td:first-child { min-width: 145px; }
.ghp-management .ghp-m-choice-list { max-height: 155px; overflow: auto; display: grid; gap: 4px; }
.ghp-management .ghp-m-detail { container-type: inline-size; }
.ghp-management .ghp-m-detail-columns { display: grid; grid-template-columns: minmax(0,1fr) minmax(120px,30%); gap: 9px; }
.ghp-management .ghp-m-fields { min-width: 0; }
.ghp-management .ghp-m-metadata { padding: 5px 0; border-bottom: 1px solid var(--ghp-border); overflow-wrap: anywhere; }
.ghp-management .ghp-m-detail textarea { resize: vertical; }
@container (max-width: 380px) { .ghp-management .ghp-m-detail-columns { grid-template-columns: minmax(0,1fr); } }

/* --- view options: a floating panel, not an inline form ------------------ */
.ghp-management .ghp-m-ic { display: inline-flex; align-items: center; }
.ghp-management .ghp-m-viewtrigger {
  display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 6px;
  border: 1px solid var(--ghp-border-strong); background: var(--ghp-surface-sunken); color: inherit;
  font: inherit; cursor: pointer;
}
.ghp-management .ghp-m-viewtrigger:hover { border-color: var(--ghp-border-hover, var(--ghp-accent-brand)); }
.ghp-management .ghp-m-viewtrigger.is-dirty { border-color: var(--ghp-accent-brand); color: var(--ghp-accent-brand); }
.ghp-management .ghp-m-viewtrigger.is-dirty::after {
  content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor;
}
.ghp-management .ghp-m-viewpanel {
  position: fixed; z-index: 120; width: 352px; max-height: min(70vh, 560px); overflow: auto;
  padding: 10px 12px 12px; border-radius: 10px; border: 1px solid var(--ghp-border-strong);
  background: var(--ghp-surface-raised, var(--ghp-surface)); color: inherit;
  box-shadow: 0 18px 48px -12px rgba(0, 0, 0, 0.55);
  display: grid; gap: 4px; font-size: 12px;
}
.ghp-management .ghp-m-vpgroup { display: grid; gap: 6px; padding: 9px 0; border-bottom: 1px solid var(--ghp-border); }
.ghp-management .ghp-m-vpgroup:last-of-type { border-bottom: 0; }
.ghp-management .ghp-m-vpgroup-label {
  font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ghp-text-secondary);
}
.ghp-management .ghp-m-seg { display: flex; gap: 4px; }
.ghp-management .ghp-m-segbtn {
  flex: 1 1 0; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 6px 8px; border-radius: 6px; border: 1px solid var(--ghp-border-strong);
  background: var(--ghp-surface-sunken); color: inherit; font: inherit; cursor: pointer;
}
.ghp-management .ghp-m-segbtn[aria-pressed="true"] {
  border-color: var(--ghp-accent-brand); color: var(--ghp-accent-brand);
  background: color-mix(in srgb, var(--ghp-accent-brand) 12%, transparent);
}
.ghp-management .ghp-m-vs { display: grid; gap: 3px; }
.ghp-management .ghp-m-vs-inline { grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 6px; }
.ghp-management .ghp-m-vs-inline .ghp-m-vs { grid-template-columns: minmax(0, 1fr); }
.ghp-management .ghp-m-vs-label { font-size: 11px; color: var(--ghp-text-secondary); }
.ghp-management .ghp-m-vs-trigger {
  display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%;
  padding: 5px 8px; border-radius: 6px; border: 1px solid var(--ghp-border-strong);
  background: var(--ghp-surface-sunken); color: inherit; font: inherit; cursor: pointer; text-align: left;
}
.ghp-management .ghp-m-vs-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghp-management .ghp-m-vs-list {
  margin-top: 3px; max-height: 190px; overflow: auto; display: grid; gap: 1px;
  padding: 3px; border-radius: 7px; border: 1px solid var(--ghp-border-strong);
  background: var(--ghp-surface-raised, var(--ghp-surface));
}
.ghp-management .ghp-m-vs-option {
  display: flex; align-items: center; gap: 7px; padding: 5px 7px; border: 0; border-radius: 5px;
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.ghp-management .ghp-m-vs-option:hover { background: var(--ghp-surface-sunken); }
.ghp-management .ghp-m-vs-option[aria-selected="true"] { color: var(--ghp-accent-brand); }
.ghp-management .ghp-m-vs-hint { font-size: 11px; color: var(--ghp-text-secondary); }
.ghp-management .ghp-m-sortdir {
  width: 26px; height: 26px; border-radius: 6px; border: 1px solid var(--ghp-border-strong);
  background: var(--ghp-surface-sunken); color: inherit; font: inherit; cursor: pointer;
}
.ghp-management .ghp-m-glyph {
  flex: 0 0 auto; width: 12px; height: 12px; border-radius: 50%; display: inline-grid; place-items: center;
  font-size: 8px; line-height: 1; border: 1px solid var(--ghp-border-strong); color: var(--ghp-text-secondary);
}
.ghp-management .ghp-m-glyph-select { border-color: #6e7681; box-shadow: inset 0 0 0 3px transparent; }
.ghp-management .ghp-m-glyph-iteration { border-radius: 3px; }
.ghp-management .ghp-m-glyph-people { border-radius: 50%; border-color: #8957e5; }
.ghp-management .ghp-m-glyph-label { border-radius: 3px; border-color: #1f6feb; }
.ghp-management .ghp-m-fields { display: grid; gap: 1px; }
.ghp-management .ghp-m-field-row {
  display: flex; align-items: center; gap: 6px; padding: 2px 4px; border-radius: 5px;
}
.ghp-management .ghp-m-field-row:hover { background: var(--ghp-surface-sunken); }
.ghp-management .ghp-m-field-row.is-off { color: var(--ghp-text-secondary); }
.ghp-management .ghp-m-field-row.is-drag { opacity: 0.5; }
.ghp-management .ghp-m-grip { display: inline-grid; place-items: center; width: 12px; color: var(--ghp-text-secondary); cursor: grab; }
.ghp-management .ghp-m-field-label {
  display: flex; align-items: center; gap: 7px; flex: 1 1 auto; min-width: 0; cursor: pointer;
}
.ghp-management .ghp-m-field-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghp-management .ghp-m-vpfoot { display: flex; justify-content: flex-end; padding-top: 8px; }
`

export const SIDEBAR_COPY = {
  board: ['看板', 'Board'], table: ['表格', 'Table'], roadmap: ['路线图', 'Roadmap'],
  view: ['视图', 'View'], views: ['项目视图', 'Project views'], layout: ['布局', 'Layout'],
  filter: ['筛选', 'Filter'], filterPlaceholder: ['筛选条目，例如 assignee:@me', 'Filter items, e.g. assignee:@me'],
  columns: ['列字段', 'Column field'], groups: ['分组', 'Group by'], sort: ['排序', 'Sort by'],
  order: ['排序方向', 'Sort direction'], ascending: ['升序', 'Ascending'], descending: ['降序', 'Descending'],
  visibleFields: ['可见字段', 'Visible fields'], display: ['显示', 'Display'], none: ['—', '—'],
  fieldsHint: ['拖动可调整顺序；勾选决定是否显示。', 'Drag to reorder; tick to show.'], localOptions: ['分组、列和排序仅影响此处。', 'Grouping, columns, and sorting apply here only.'],
  saveView: ['保存到 GitHub 视图', 'Save to GitHub view'], truncated: ['只显示当前加载上限内的结果。可用筛选缩小范围。', 'Only results within the configured limit are shown. Narrow the results with a filter.'],
  roadmapUnsupported: ['此视图为路线图。可临时切换布局，或打开 GitHub 视图。', 'This view is a roadmap. Switch layouts temporarily or open the GitHub view.'],
  rulesUnsupported: ['当前视图包含部分尚不支持的分组或排序。', 'This view includes grouping or sorting that is not yet supported.'],
  readOnly: ['此项目当前为只读。', 'This project is currently read-only.'],
  noValue: ['未设置', 'No value'], allItems: ['所有条目', 'All items'], restricted: ['无法访问的条目', 'Restricted item'],
  itemActions: ['条目操作', 'Item actions'], archive: ['归档', 'Archive'], add: ['添加条目', 'Add item'],
  'create-draft': ['创建草稿', 'Create draft'], 'create-issue': ['创建 Issue', 'Create issue'], 'add-item': ['添加现有条目', 'Add existing item'],
  retryAdd: ['重试加入项目', 'Retry adding to project'], retryField: ['重试设置字段', 'Retry updating field'],
  addUnknown: ['创建结果未知。请先刷新项目或查找刚创建的 Issue，再决定是否重试。', 'Creation status is unknown. Refresh the project or look for the Issue before retrying.'],
  mode: ['方式', 'Method'], reference: ['Issue 或 PR', 'Issue or pull request'], repo: ['仓库', 'Repository'],
  title: ['标题', 'Title'], draftTitle: ['输入标题创建草稿', 'Enter a title for the draft'], body: ['正文', 'Description'], details: ['条目详情', 'Item details'],
  back: ['← 返回项目', '← Back to project'], edit: ['编辑', 'Edit'], save: ['保存', 'Save'], cancel: ['取消', 'Cancel'], saved: ['已保存到 GitHub', 'Saved to GitHub'],
  loading: ['正在加载…', 'Loading…'], search: ['搜索', 'Search'], assignees: ['负责人', 'Assignees'], labels: ['标签', 'Labels'], milestone: ['里程碑', 'Milestone'],
  comment: ['添加评论', 'Add a comment'], publish: ['发表评论', 'Comment'],
  latestComments: ['显示最近的评论。', 'Showing the most recent comments.'],
  commentUnknown: ['发布结果未知。请刷新评论确认，避免重复提交。', 'Delivery status is unknown. Refresh comments before trying again.'],
  commentReviewed: ['已核对，继续编辑', 'Checked, continue editing'],
  reopen: ['重新打开 Issue', 'Reopen issue'], closeIssue: ['关闭 Issue', 'Close issue'], bodyTooLong: ['此正文超出栏内编辑上限。', 'This description exceeds the in-panel editing limit.'],
  unsaved: ['尚有未提交的编辑。', 'There are unsaved edits.'], continue: ['继续编辑', 'Keep editing'], discard: ['放弃并返回', 'Discard and go back'],
  'kind.issue': ['Issue', 'Issue'], 'kind.pr': ['PR', 'Pull request'], 'kind.draft': ['草稿', 'Draft'],
  'state.open': ['已开启', 'Open'], 'state.closed': ['已关闭', 'Closed'], 'state.merged': ['已合并', 'Merged'],
}