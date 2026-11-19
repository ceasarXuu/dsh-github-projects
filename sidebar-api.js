import { GhError, parseIssueRef, parseOwnerParam, parsePositiveInt, parseRepoParam } from './github.js'

export const SIDEBAR_READS = new Set(['/project-layout', '/project-view-items', '/project-item', '/project-choices'])
export const SIDEBAR_WRITE = '/project-operation'

const bad = (message) => new GhError('bad-request', message)
const conflict = () => new GhError('conflict', 'GitHub 上的值已改变。请刷新后重新编辑。')
const forbidden = (message) => new GhError('forbidden', message)
const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
const EDITABLE_FIELDS = new Set(['SINGLE_SELECT', 'MULTI_SELECT', 'ITERATION', 'TEXT', 'NUMBER', 'DATE'])

function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw bad(`请输入${required ? '非空' : ''}文本（最多 ${max} 个字符）`)
  }
  return value
}

function itemId(value) {
  if (typeof value !== 'string' || !/^[\w-]{1,200}$/u.test(value)) throw bad('项目条目 ID 无效')
  return value
}

function issueRef(value) {
  const ref = text(value, 300, true).trim()
  const pull = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/([0-9]+)(?:[/#?].*)?$/iu.exec(ref)
  const repo = pull && parseRepoParam(`${pull[1]}/${pull[2]}`)?.repo
  const number = pull && parsePositiveInt(pull[3])
  const match = repo && number ? { repo, number } : parseIssueRef(ref)
  if (!match) throw bad('请输入 Issue / PR 的 GitHub 链接或 owner/repo#编号')
  return match
}

function idList(raw, max) {
  if (!Array.isArray(raw) || raw.length > max) throw bad('选项列表无效')
  return [...new Set(raw.map(item => itemId(item)))]
}

function fieldInput(field, value) {
  if (field.issueField) throw bad('请在 Issue 字段中编辑此值')
  if (!EDITABLE_FIELDS.has(field.type)) throw bad('暂不支持编辑此字段')
  if (value === null) return null
  const option = (id) => {
    if (!field.options.some(choice => choice.id === id)) throw bad('字段选项已变化，请刷新')
    return id
  }
  switch (field.type) {
    case 'SINGLE_SELECT': return { singleSelectOptionId: option(value) }
    case 'ITERATION': return { iterationId: option(value) }
    case 'MULTI_SELECT': return { multiSelectOptionIds: idList(value, 50).map(option) }
    case 'TEXT': return { text: text(value, 10_000) }
    case 'NUMBER':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('请输入有效数字')
      return { number: value }
    case 'DATE':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
          !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw bad('请输入有效日期')
      return { date: value }
    default: throw bad('暂不支持编辑此字段')
  }
}

function optionNames(value) {
  if (!Array.isArray(value) || value.length > 50) throw bad('选项列表无效')
  return [...new Set(value.map(name => text(name, 100, true).trim()))]
}

function issuePatch(body) {
  const patch = body.patch
  if (!record(patch) || !record(body.expected) || Object.keys(patch).length !== 1) throw bad('一次只能编辑一个 Issue 字段')
  const [key, value] = Object.entries(patch)[0]
  if (!Object.hasOwn(body.expected, key)) throw bad('缺少编辑前的值')
  switch (key) {
    case 'title': return { title: text(value, 256, true).trim() }
    case 'body': return { body: text(value, 60_000) }
    case 'assignees':
    case 'labels': return { [key]: optionNames(value) }
    case 'milestone': {
      const number = parsePositiveInt(value)
      if (value !== null && number === null) throw bad('里程碑无效')
      return { milestone: number }
    }
    case 'state':
      if (!['open', 'closed'].includes(value)) throw bad('Issue 状态无效')
      return { state: value }
    default: throw bad('暂不支持编辑此 Issue 字段')
  }
}

export function createSidebarApi({ github, store, cache }) {
  const activeWrites = new Set()

  function scope(parameters) {
    const workspace = typeof parameters.workspaceId === 'string' && parameters.workspaceId.length <= 300
      ? store.getWorkspace(parameters.workspaceId) : null
    const project = workspace?.project
    const owner = parseOwnerParam(parameters.owner)
    const number = parsePositiveInt(parameters.number)
    if (!owner || !number) throw bad('项目参数无效')
    if (!project || project.owner.toLowerCase() !== owner.toLowerCase() || project.number !== number) {
      throw new GhError('conflict', '工作区绑定已更改，请重新打开项目')
    }
    const key = `${owner.toLowerCase()}/${number}`
    return { owner: project.owner, number, key, stored: project }
  }

  async function layout(target, refresh = false) {
    return cache.get(`sidebar-layout:${target.key}`, refresh, () => github.layout(target))
  }

  async function read(path, query) {
    const target = scope(Object.fromEntries(query))
    const refresh = query.get('refresh') === '1'
    if (path === '/project-item') {
      return { item: await github.detail(target, itemId(query.get('itemId'))) }
    }
    if (path === '/project-choices') {
      const item = await github.item(target, itemId(query.get('itemId')))
      if (!item.repo) throw bad('此条目没有关联仓库')
      return github.choices(item.repo, text(query.get('search') ?? '', 150))
    }
    if (path === '/project-layout') {
      const { value, stale } = await layout(target, refresh)
      return { ...value, stale }
    }
    const filter = text(query.get('filter') ?? '', 1500)
    const { value, stale } = await cache.get(`sidebar-items:${target.key}:${filter}`, refresh, () => github.items(target, filter))
    return { ...value, stale }
  }

  function flush(target, issue) {
    cache.invalidatePrefix(`sidebar-items:${target.key}:`)
    cache.invalidate(`items:${target.stored.owner}/${target.number}`)
    if (issue?.repo && issue.number) {
      cache.invalidate(`issue:${issue.repo}#${issue.number}`)
      if (issue.repo !== issue.repo.toLowerCase()) cache.invalidate(`issue:${issue.repo.toLowerCase()}#${issue.number}`)
    }
  }

  async function updateField(meta, id, fieldId, value) {
    const field = meta.fields.find(candidate => candidate.id === fieldId)
    if (!field) throw bad('项目字段不存在，请刷新')
    const input = fieldInput(field, value)
    const common = { projectId: meta.project.id, itemId: id, fieldId }
    if (input === null) await github.mutation('clearProjectV2ItemFieldValue', common, 'projectV2Item{id}')
    else await github.mutation('updateProjectV2ItemFieldValue', { ...common, value: input }, 'projectV2Item{id}')
  }

  async function applyInitialField(target, meta, id, initial) {
    if (!initial) return { itemId: id }
    try {
      await updateField(meta, id, initial.fieldId, initial.value)
      return { itemId: id }
    } catch (error) {
      const current = await github.item(target, id).catch(() => null)
      const value = current?.values[initial.fieldId] ?? null
      return { itemId: id, warning: error.message, retry: { action: 'update-field', itemId: id, fieldId: initial.fieldId, value: initial.value, expected: value } }
    }
  }

  async function addContent(target, meta, contentId, initial) {
    const { item } = await github.mutation('addProjectV2ItemById', { projectId: meta.project.id, contentId: itemId(contentId) }, 'item{id}')
    return applyInitialField(target, meta, itemId(item?.id), initial)
  }

  async function createOrAdd(target, meta, body) {
    const initial = record(body.initial) ? body.initial : null
    if (initial) {
      const field = meta.fields.find(candidate => candidate.id === initial.fieldId)
      if (!field) throw bad('要继承的项目字段已更改')
      fieldInput(field, initial.value)
    }
    if (body.action === 'add-item') {
      const ref = issueRef(body.reference)
      const result = await github.rest('GET', `repos/${ref.repo}/issues/${ref.number}`)
      return addContent(target, meta, result.node_id, initial)
    }
    const title = text(body.title, 256, true).trim()
    const description = text(body.body ?? '', 60_000)
    if (body.action === 'create-draft') {
      const result = await github.mutation('addProjectV2DraftIssue', { projectId: meta.project.id, title, body: description }, 'projectItem{id}')
      return applyInitialField(target, meta, itemId(result.projectItem?.id), initial)
    }
    const repo = parseRepoParam(body.repo)?.repo
    if (!repo) throw bad('请输入 owner/repository')
    const created = await github.rest('POST', `repos/${repo}/issues`, { title, body: description })
    const issue = { repo, number: created.number, url: created.html_url, title: created.title }
    try {
      const result = await addContent(target, meta, created.node_id, initial)
      return { ...result, issue }
    } catch (error) {
      return { issue, warning: error.message, retry: { action: 'add-item', reference: `${repo}#${created.number}`, initial } }
    }
  }

  async function saveView(target, meta, body) {
    const view = meta.views.find(candidate => candidate.id === body.viewId)
    if (!view) throw bad('视图已更改，请刷新')
    const filter = text(body.filter, 1500)
    if (!['BOARD_LAYOUT', 'TABLE_LAYOUT'].includes(body.layout)) throw bad('视图布局无效')
    if (body.previousFilter !== view.filter || body.previousLayout !== view.layout || !same(body.previousFields, view.fields)) throw conflict()
    const visibleFieldIds = idList(body.fields, 50)
    if (visibleFieldIds.some(id => !meta.fields.some(field => field.id === id))) throw bad('可见字段已变化，请刷新')
    await github.mutation('updateProjectV2View', { viewId: view.id, filter, layout: body.layout, configuration: { visibleFieldIds } }, 'projectV2View{id}')
    cache.invalidate(`sidebar-layout:${target.key}`)
    return { viewId: view.id }
  }

  async function updateIssue(entry, body) {
    if (entry.type !== 'issue' || !entry.repo || !entry.number) throw bad('此条目不是可编辑的 Issue')
    const endpoint = `repos/${entry.repo}/issues/${entry.number}`
    if (body.action === 'comment') {
      const comment = await github.rest('POST', `${endpoint}/comments`, { body: text(body.text, 60_000, true) })
      return { commentId: comment.id }
    }
    const patch = issuePatch(body)
    const [key, value] = Object.entries(patch)[0]
    if (key === 'state' ? !entry.canChangeState : !entry.canEdit) throw forbidden('当前账号没有权限编辑此 Issue 字段')
    if ((key === 'labels' && entry.labelsTruncated) || (key === 'assignees' && entry.assigneesTruncated)) throw bad('只读取到部分选项，请在 GitHub 编辑完整列表')
    const current = key === 'milestone' ? entry.milestoneNumber : key === 'state' ? entry.state?.toLowerCase() : entry[key]
    const fieldSame = (a, b) => Array.isArray(a) && Array.isArray(b) ? same([...a].sort(), [...b].sort()) : same(a, b)
    if (fieldSame(current, value)) return { itemId: entry.id }
    if (!fieldSame(current, body.expected[key])) throw conflict()
    const updated = await github.rest('PATCH', endpoint, patch)
    const actual = key === 'milestone' ? updated.milestone?.number ?? null
      : key === 'labels' || key === 'assignees' ? updated[key]?.map(item => item.name ?? item.login).sort() : updated[key]
    if (!same(actual ?? (key === 'body' ? '' : null), Array.isArray(value) ? [...value].sort() : value)) {
      throw forbidden('GitHub 未应用此字段的修改，请检查仓库权限')
    }
    return { itemId: entry.id }
  }

  async function projectWrite(target, body, entry) {
    const meta = (await layout(target, true)).value
    if (!meta.project.viewerCanUpdate) throw forbidden('当前账号没有权限编辑此项目')
    if (['add-item', 'create-issue', 'create-draft'].includes(body.action)) return createOrAdd(target, meta, body)
    if (body.action === 'save-view') return saveView(target, meta, body)
    if (!entry || entry.archived) throw bad('请从当前视图选择一条有效条目')
    if (body.action === 'archive') {
      await github.mutation('archiveProjectV2Item', { projectId: meta.project.id, itemId: entry.id }, 'item{id}')
    } else if (body.action === 'update-field') {
      if (entry.valuesTruncated && !Object.hasOwn(entry.values, body.fieldId)) throw bad('无法确认字段的当前值，请在 GitHub 编辑')
      const current = entry.values[body.fieldId] ?? null
      if (same(current, body.value)) return { itemId: entry.id }
      if (!Object.hasOwn(body, 'expected') || !same(current, body.expected)) throw conflict()
      await updateField(meta, entry.id, body.fieldId, body.value)
    } else if (body.action === 'edit-draft' && entry.type === 'draft') {
      const patch = issuePatch(body)
      const key = Object.keys(patch)[0]
      if (!['title', 'body'].includes(key)) throw bad('仅支持修改草稿的标题或正文')
      if (!same(entry[key], body.expected[key])) throw conflict()
      await github.mutation('updateProjectV2DraftIssue', { draftIssueId: entry.contentId, ...patch }, 'draftIssue{id}')
    } else {
      throw bad('操作不可用')
    }
    return { itemId: entry.id }
  }

  async function write(body) {
    const target = scope(body)
    const lock = `${target.key}:${body.itemId ? itemId(body.itemId) : ''}`
    if (activeWrites.has(lock)) throw new GhError('conflict', '同一条目的操作正在提交')
    activeWrites.add(lock)
    let entry
    let issueLock
    try {
      entry = body.itemId ? await github.item(target, itemId(body.itemId)) : null
      if (entry && entry.inaccessible) throw forbidden('GitHub 未授权访问此条目')
      if (['edit-issue', 'comment'].includes(body.action)) {
        if (!entry) throw bad('请先打开 Issue')
        const key = `issue:${entry.repo?.toLowerCase()}#${entry.number}`
        if (activeWrites.has(key)) throw new GhError('conflict', '此 Issue 正在提交另一项操作')
        activeWrites.add(key)
        issueLock = key
        return await updateIssue(entry, body)
      }
      return await projectWrite(target, body, entry)
    } finally {
      flush(target, entry)
      if (issueLock) activeWrites.delete(issueLock)
      activeWrites.delete(lock)
    }
  }

  return { read, write }
}
