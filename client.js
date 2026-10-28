// GitHub Projects — browser half.
//
// One session view slot entry for the installed DSH web client (0.2.1):
// `issue`. The workspace project board opens in DSH's right sidebar as a
// custom tab type (v1.0.2 preview, docs/CONTRACT.md §4.7) instead.
//
//   issue — the Issue bound to the current **session**: header, body,
//           labels and comments, rendered through a deliberately small,
//           safe Markdown subset (React elements only — no HTML injection).
//
// Only `react` / `react-dom` from the platform module table are required. The
// HTTP contract lives in the host half (`/plugin/github-projects`, see
// docs/CONTRACT.md §3.1). Everything is read-only against GitHub; the only
// writes are the durable bindings.
window.__ModuleLoader__.load({
  id: '@ceasarxuu/dsh-github-projects',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React

    /** Own locale namespace: reusing a shipped namespace (chat/common) throws. */
    const NS = 'githubProjects'
    const API_BASE = '/plugin/github-projects'
    const REQUEST_TIMEOUT_MS = 20_000
    /** Status filter sentinel values; real Status values are user-defined strings. */
    const ALL_STATUS = '\u0000all'
    const NO_STATUS = '\u0000none'

    /* ------------------------------------------------------------------ */
    /* 1. HTTP client — one small fetch wrapper with abort + timeout.      */
    /* ------------------------------------------------------------------ */

    class GhpError extends Error {
      constructor(code, message, status) {
        super(message)
        this.name = 'GhpError'
        this.code = code
        this.status = typeof status === 'number' ? status : 0
      }
    }

    function requestJson(path, options = {}) {
      const controller = new AbortController()
      const externalSignal = options.signal
      let timer = 0
      let abortedExternally = false
      const abort = () => {
        abortedExternally = abortedExternally || externalSignal !== undefined
        controller.abort()
      }
      const onExternalAbort = () => {
        abortedExternally = true
        controller.abort()
      }
      timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      if (externalSignal !== undefined) {
        if (externalSignal.aborted) controller.abort()
        else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
      }
      const headers = { accept: 'application/json' }
      let body
      if (options.body !== undefined) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(options.body)
      }
      return fetch(API_BASE + path, {
        method: options.method ?? 'GET',
        headers,
        body,
        signal: controller.signal,
        credentials: 'same-origin',
        cache: 'no-store',
      })
        .then(async (response) => {
          let payload = null
          try {
            payload = await response.json()
          } catch (_invalidJson) {
            payload = null
          }
          if (!response.ok) {
            const failure = payload !== null && typeof payload === 'object' ? payload.error : null
            const code = failure !== null && typeof failure.code === 'string' ? failure.code : `http-${response.status}`
            const message = failure !== null && typeof failure.message === 'string'
              ? failure.message
              : (response.statusText || `HTTP ${response.status}`)
            throw new GhpError(code, message, response.status)
          }
          if (payload === null || typeof payload !== 'object') {
            throw new GhpError('bad-response', 'invalid JSON response', response.status)
          }
          return payload
        })
        .catch((error) => {
          if (error instanceof GhpError) throw error
          if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
            // Caller-driven cancellation is not a user-visible failure; the
            // caller's effect cleanup ignores everything after unmount.
            throw new GhpError(abortedExternally ? 'aborted' : 'timeout', 'request timed out')
          }
          throw new GhpError('network', error !== null && typeof error === 'object' && typeof error.message === 'string'
            ? error.message
            : 'network request failed')
        })
        .finally(() => {
          window.clearTimeout(timer)
          if (externalSignal !== undefined) externalSignal.removeEventListener('abort', onExternalAbort)
        })
    }

    const apiGet = (path, options) => requestJson(path, options)

    function apiPost(path, body) {
      return requestJson(path, { method: 'POST', body })
    }

    function queryString(params) {
      const search = new URLSearchParams()
      for (const key of Object.keys(params)) {
        const value = params[key]
        if (value === undefined || value === null || value === '') continue
        search.set(key, String(value))
      }
      const text = search.toString()
      return text === '' ? '' : `?${text}`
    }

    /* ------------------------------------------------------------------ */
    /* 1b. Client data layer: SWR caches, remembered project, fan-out.     */
    /* ------------------------------------------------------------------ */

    /** Endpoint payload cache shared by every view mount (module lifetime). */
    const responseCache = new Map()
    /** Single-flight dedupe for revalidations of one cache key. */
    const inflightFetches = new Map()
    /** Cross-view event: this plugin's own bind/unbind writes happened. */
    const BINDING_CHANGED_EVENT = 'dsh-github-projects:binding-changed'
    const LAST_PROJECT_STORAGE_KEY = 'dsh-github-projects:last-project'
    const SESSION_POLL_MS = 4000
    const STALE_RETRY_MS = 1200

    function cachedResponseOf(key) {
      const value = responseCache.get(key)
      return value === undefined ? null : value
    }

    function configCacheKey(sessionId, workspaceId) { return `config:${sessionId ?? ''}:${workspaceId ?? ''}` }
    function projectsCacheKey() { return 'projects' }
    function itemsCacheKey(owner, number) { return `items:${owner}/${number}` }
    function issueCacheKey(repo, number) { return `issue:${repo}#${number}` }

    function configRequestPath(sessionId, workspaceId) {
      return `/config${queryString({ sessionId, workspaceId })}`
    }

    function itemsRequestPath(owner, number, refresh) {
      return `/items${queryString({ owner, number, refresh: refresh === true ? 1 : undefined })}`
    }

    function issueRequestPath(repo, number, refresh) {
      return `/issue${queryString({ repo, number, refresh: refresh === true ? 1 : undefined })}`
    }

    /**
     * One cached read (client half of CONTRACT §3.5). Concurrent reads of one
     * key share a single request; a `stale: true` payload schedules exactly one
     * retry after ~1.2 s (never with `refresh=1`) to pick up the host's
     * background revalidation. Callers decide whether to paint the cached value
     * first — this helper only owns cache fill + retry policy.
     */
    function requestWithCache(path, key, options = {}) {
      const existing = inflightFetches.get(key)
      if (existing !== undefined) return existing
      const promise = apiGet(path)
        .then((data) => {
          responseCache.set(key, data)
          const isStale = data !== null && typeof data === 'object' && data.stale === true
          if (isStale && options.allowStaleRetry !== false) {
            window.setTimeout(() => {
              requestWithCache(
                typeof options.retryPath === 'string' ? options.retryPath : path,
                key,
                { allowStaleRetry: false },
              ).catch(() => { /* a failed follow-up read keeps the stale cache */ })
            }, STALE_RETRY_MS)
          }
          return data
        })
        .finally(() => {
          if (inflightFetches.get(key) === promise) inflightFetches.delete(key)
        })
      inflightFetches.set(key, promise)
      return promise
    }

    /** Force a network config read (after bind/unbind) and refresh the cache. */
    function readConfigNow(sessionId, workspaceId) {
      return apiGet(configRequestPath(sessionId, workspaceId)).then((data) => {
        responseCache.set(configCacheKey(sessionId, workspaceId), data)
        return data
      })
    }

    /** Remember the workspace→Project mapping so items can start before config. */
    const rememberedProjects = new Map()

    function readRememberedProject(workspaceId) {
      if (typeof workspaceId !== 'string' || workspaceId === '') return null
      const inMemory = rememberedProjects.get(workspaceId)
      if (inMemory !== undefined) return inMemory
      try {
        const raw = window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY)
        if (raw !== null) {
          const parsed = JSON.parse(raw)
          if (isPlainObject(parsed) && parsed.workspaceId === workspaceId && isPlainObject(parsed.project)) {
            rememberedProjects.set(workspaceId, parsed.project)
            return parsed.project
          }
        }
      } catch (_unavailableStorage) { /* memory-only */ }
      return null
    }

    function rememberProject(workspaceId, project) {
      if (typeof workspaceId !== 'string' || workspaceId === '' || !isPlainObject(project)) return
      rememberedProjects.set(workspaceId, project)
      try {
        window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, JSON.stringify({ workspaceId, project }))
      } catch (_unavailableStorage) { /* memory-only */ }
    }

    function dispatchBindingChanged() {
      try { window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT)) } catch (_unavailableEvent) { /* noop */ }
    }

    function onBindingChanged(listener) {
      window.addEventListener(BINDING_CHANGED_EVENT, listener)
      return () => window.removeEventListener(BINDING_CHANGED_EVENT, listener)
    }

    /**
     * Open a GitHub URL in the system default browser as a new tab (v1.0.1) —
     * the same mechanism as DSH's own "Open in system browser". A blocked popup
     * is a silent no-op; the app itself is never navigated.
     */
    function openGithubUrl(url) {
      const href = safeHref(url)
      if (href === null) return
      try {
        window.open(href, '_blank', 'noopener,noreferrer')
      } catch (_blocked) { /* popup blocked — no-op */ }
    }

    /* ------------------------------------------------------------------ */
    /* 1d. Right-sidebar project tab (v1.0.2 preview, §4.7).               */
    /* ------------------------------------------------------------------ */

    const PROJECT_TAB_ID = '@ceasarxuu/dsh-github-projects/project'
    const PROJECT_TAB_KIND = 'github-project'
    let sidebarRightFace = null

    /** Open (or focus) the workspace project board in DSH's right sidebar. */
    function openProjectTab(workspaceId, options = {}) {
      const id = textOf(workspaceId)
      if (id === '') return false
      const face = sidebarRightFace
      if (face === null || face === undefined || typeof face.openTab !== 'function') return false
      try {
        const params = { workspaceId: id }
        if (options.pick === true) {
          params.pick = true
          params.pickToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        }
        face.openTab(PROJECT_TAB_KIND, { params })
        return true
      } catch (_openFailed) {
        return false
      }
    }

    /** Warm `/issue` for a session's bound Issue so the tab opens instantly. */
    function prefetchIssueDetail(issue) {
      if (!isPlainObject(issue)) return
      const repo = textOf(issue.repo)
      const number = issue.number
      if (repo === '' || !isPositiveInteger(number)) return
      const key = issueCacheKey(repo, number)
      if (cachedResponseOf(key) !== null) return
      requestWithCache(issueRequestPath(repo, number, false), key).catch(() => { /* prefetch is best effort */ })
    }

    /* ------------------------------------------------------------------ */
    /* 1c. Session→Issue binding map (§4.6): one cheap /bindings poll      */
    /*     feeds both the header subtitle and the sidebar decorator.       */
    /* ------------------------------------------------------------------ */

    /** SessionId → IssueSummary for every bound session (local state only). */
    const sessionIssueBindings = new Map()
    /** WorkspaceId → ProjectSummary for every bound workspace (v1.0.2). */
    const workspaceProjectBindings = new Map()
    const bindingMapListeners = new Set()
    let bindingMapInflight = null

    function issueBindingOf(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null
      const issue = sessionIssueBindings.get(sessionId)
      return isPlainObject(issue) ? issue : null
    }

    function workspaceBindingOf(workspaceId) {
      if (typeof workspaceId !== 'string' || workspaceId === '') return null
      const project = workspaceProjectBindings.get(workspaceId)
      return isPlainObject(project) ? project : null
    }

    function sameIssueSummary(left, right) {
      if (left === null || left === undefined) return right === null || right === undefined
      if (right === null || right === undefined) return false
      return left.repo === right.repo
        && left.number === right.number
        && left.title === right.title
        && left.url === right.url
        && left.state === right.state
    }

    function sameProjectSummary(left, right) {
      if (left === null || left === undefined) return right === null || right === undefined
      if (right === null || right === undefined) return false
      return left.owner === right.owner
        && left.number === right.number
        && left.title === right.title
        && left.url === right.url
    }

    function notifyBindingMapListeners() {
      for (const listener of [...bindingMapListeners]) {
        try { listener() } catch (_listenerFailed) { /* one bad listener must not break the rest */ }
      }
    }

    function subscribeBindingMap(listener) {
      bindingMapListeners.add(listener)
      return () => { bindingMapListeners.delete(listener) }
    }

    /** Replace both maps from `/bindings`; notify once when either changed. */
    function applyBindingsSnapshot(sessions, workspaces) {
      const nextSessions = new Map()
      if (isPlainObject(sessions)) {
        for (const [sessionId, issue] of Object.entries(sessions)) {
          if (typeof sessionId === 'string' && sessionId !== '' && isPlainObject(issue)) nextSessions.set(sessionId, issue)
        }
      }
      const nextWorkspaces = new Map()
      if (isPlainObject(workspaces)) {
        for (const [workspaceId, project] of Object.entries(workspaces)) {
          if (typeof workspaceId === 'string' && workspaceId !== '' && isPlainObject(project)) nextWorkspaces.set(workspaceId, project)
        }
      }
      let changed = nextSessions.size !== sessionIssueBindings.size || nextWorkspaces.size !== workspaceProjectBindings.size
      if (!changed) {
        for (const [sessionId, issue] of nextSessions) {
          if (!sameIssueSummary(sessionIssueBindings.get(sessionId) ?? null, issue)) {
            changed = true
            break
          }
        }
      }
      if (!changed) {
        for (const [workspaceId, project] of nextWorkspaces) {
          if (!sameProjectSummary(workspaceProjectBindings.get(workspaceId) ?? null, project)) {
            changed = true
            break
          }
        }
      }
      sessionIssueBindings.clear()
      for (const [sessionId, issue] of nextSessions) sessionIssueBindings.set(sessionId, issue)
      workspaceProjectBindings.clear()
      for (const [workspaceId, project] of nextWorkspaces) workspaceProjectBindings.set(workspaceId, project)
      if (changed) notifyBindingMapListeners()
      return changed
    }

    function sessionBindingsObject() {
      const sessions = {}
      for (const [sessionId, issue] of sessionIssueBindings) sessions[sessionId] = issue
      return sessions
    }

    function workspaceBindingsObject() {
      const workspaces = {}
      for (const [workspaceId, project] of workspaceProjectBindings) workspaces[workspaceId] = project
      return workspaces
    }

    /** Optimistic local update from our own successful bind/unbind writes. */
    function setSessionIssueBinding(sessionId, issue) {
      const sessions = sessionBindingsObject()
      if (issue === null || issue === undefined) delete sessions[sessionId]
      else sessions[sessionId] = issue
      applyBindingsSnapshot(sessions, workspaceBindingsObject())
    }

    function setWorkspaceProjectBinding(workspaceId, project) {
      if (typeof workspaceId !== 'string' || workspaceId === '') return
      const workspaces = workspaceBindingsObject()
      if (project === null || project === undefined) delete workspaces[workspaceId]
      else workspaces[workspaceId] = project
      applyBindingsSnapshot(sessionBindingsObject(), workspaces)
    }

    /** Refresh the binding map from GET /bindings (single-flight, no gh). */
    function refreshBindingMap() {
      if (bindingMapInflight !== null) return bindingMapInflight
      const promise = apiGet('/bindings')
        .then((data) => {
          applyBindingsSnapshot(isPlainObject(data) ? data.sessions : null, isPlainObject(data) ? data.workspaces : null)
          return sessionIssueBindings
        })
        .finally(() => {
          if (bindingMapInflight === promise) bindingMapInflight = null
        })
      bindingMapInflight = promise
      return promise
    }

    /** Poll + binding-changed plumbing, owned by the plugin effect in apply(). */
    function installBindingMap(ctx) {
      ctx.effect(() => {
        let stopped = false
        const tick = () => {
          if (stopped) return
          refreshBindingMap().catch(() => { /* keep the last known map */ })
        }
        tick()
        const timer = window.setInterval(tick, SESSION_POLL_MS)
        const off = onBindingChanged(tick)
        return () => {
          stopped = true
          window.clearInterval(timer)
          off()
        }
      }, 'github-projects: /bindings map')
    }

    /* ------------------------------------------------------------------ */
    /* 2. Dictionaries — every content string, zh first and en complete.   */
    /* ------------------------------------------------------------------ */

    const zh = {
      'common.refresh': '刷新',
      'common.retry': '重试',
      'common.close': '关闭',
      'common.cancel': '取消',
      'common.bind': '绑定',
      'common.bound': '已绑定',
      'common.unbind': '解绑',
      'common.confirmUnbind': '确认解绑',
      'common.openGithub': '在 GitHub 打开',
      'common.items': '{count} 个条目',
      'common.itemsUnknown': '条目数未知',
      'common.updating': '更新中…',
      'common.closed': '已关闭',
      'common.all': '全部',
      'common.clearFilter': '清除筛选',
      'common.unbindFailed': '解绑失败',
      'common.refreshFailed': '刷新失败',

      'projects.sidebarTab': '项目',
      'projects.openEntry': '打开 GitHub Project',
      'projects.unboundTitle': '绑定 GitHub Project',
      'projects.unboundText': '将工作区关联到一个 GitHub Project，之后每个会话都能在这里浏览它按状态分组的 Issue、PR 与 Draft。',
      'projects.unboundAction': '选择 Project',
      'projects.workspaceHint': '绑定只作用于当前工作区：{title}',
      'projects.workspacePath': '路径：{path}',
      'projects.noWorkspaceTitle': '当前会话不属于任何工作区',
      'projects.noWorkspaceText': '工作区绑定以工作区为归属；请先把会话放进一个工作区，再回来绑定 Project。',
      'projects.pickerTitle': '选择 GitHub Project',
      'projects.pickerSub': '按 owner 分组；选择后绑定到当前工作区。',
      'projects.pickerFilter': '按名称、owner 或编号筛选',
      'projects.pickerEmpty': '没有匹配的 Project',
      'projects.pickerEmptyHint': '清空筛选，或在下方手动输入 owner 与编号。',
      'projects.pickerCap': '仅显示前 {count} 个，请用筛选或手动输入缩小范围。',
      'projects.pickerOwnerErrors': '部分 owner 读取失败：{owners}',
      'projects.manualTitle': '手动绑定',
      'projects.manualHint': '列表中没有的 Project，可直接输入 owner 与编号。',
      'projects.manualOwner': 'owner',
      'projects.manualNumber': '编号',
      'projects.manualOwnerAria': 'Project 的 owner',
      'projects.manualNumberAria': 'Project 的编号',
      'projects.manualInvalid': '请输入 owner 与有效的 Project 编号',
      'projects.ownerTypeUser': '用户',
      'projects.ownerTypeOrg': '组织',
      'projects.change': '更换',
      'projects.emptyItemsTitle': '这个 Project 还没有条目',
      'projects.emptyItemsText': '添加 Issue、PR 或 Draft 后，它们会按 Status 分组显示在这里。',
      'projects.truncated': '条目已截断：仅显示前 {shown} 个（共 {total} 个）。',
      'projects.filterPlaceholder': '筛选标题、repo、编号或标签',
      'projects.uncategorized': '未分类',
      'projects.filterEmpty': '没有匹配的条目',
      'projects.refreshing': '正在刷新…',
      'projects.selectAria': '绑定 Project：{title}',
      'projects.ghWarningTitle': 'gh CLI 不可用',
      'projects.ghWarningHint': '安装 GitHub CLI 并运行 gh auth login 后即可读取项目数据。',
      'projects.issueBindFailed': '绑定 Issue 失败',
      'projects.viewBoard': '泳道',
      'projects.viewList': '列表',
      'projects.viewModeAria': '视图模式',
      'projects.milestone.filterAria': '按里程碑过滤',
      'projects.milestone.all': '全部',
      'projects.milestone.backlog': 'Backlog',
      'projects.milestone.backlogHint': '无里程碑的条目',
      'projects.milestone.missing': '所选里程碑「{title}」已不在当前条目中，已切换为全部。',
      'projects.board.emptyColumn': '无条目',
      'projects.bindIssueAria': '绑定 Issue：{title}',
      'projects.loadFailed': '读取 Project 条目失败',
      'projects.bindFailed': '绑定 Project 失败',

      'issue.unboundTitle': '为当前会话绑定 Issue',
      'issue.unboundText': '绑定后，这个页签会直接显示该 Issue 的标题、正文、标签与评论。',
      'issue.unboundAction': '从项目选择',
      'issue.refPlaceholder': '粘贴 Issue 链接或 owner/repo#123',
      'issue.refAria': 'Issue 链接或 owner/repo#123',
      'issue.invalidRef': '请输入有效的 Issue 链接或 owner/repo#123',
      'issue.bindFailed': '绑定 Issue 失败',
      'issue.unboundHint': '也可以点击工作区行右侧的项目图标，在右侧栏看板里绑定 Issue。',
      'subtitle.openAria': '在浏览器中打开 {ref}',
      'card.openAria': '在浏览器中打开：{title}',
      'issue.commentCount': '{count} 条评论',
      'issue.noBody': '（没有正文）',
      'issue.bodyTruncated': '正文过长，已截断显示。',
      'issue.comments': '评论 ({count})',
      'issue.noComments': '还没有评论',
      'issue.commentsTruncated': '还有 {count} 条评论未显示。',
      'issue.openedBy': '{author} 于 {date} 打开',
      'issue.ghost': 'ghost',
      'issue.assignees': '指派给 {names}',
      'issue.updated': '更新于 {time}',
      'issue.stateOpen': 'Open',
      'issue.stateClosed': 'Closed',
      'issue.stateMerged': 'Merged',
      'issue.notIssue': '这是一个 Pull Request，不能绑定为 Issue。',
      'issue.loadFailed': '读取 Issue 失败',

      'error.title': '读取 GitHub 数据失败',
      'error.messageFallback': '未知错误',
      'error.codeLabel': '错误码：{code}',
      'error.ghMissingHint': '未找到 gh CLI，请先安装 GitHub CLI。',
      'error.ghAuthHint': '请先运行 gh auth login。',
      'error.ghFailedHint': 'GitHub 读取失败，请重试。',
      'error.timeoutHint': 'GitHub 响应超时，请重试。',
      'error.issueNotFoundHint': '找不到这个 Issue，可能已删除或没有权限。',
      'error.projectNotFoundHint': '找不到这个 Project，可能已删除或没有权限。',
      'error.networkHint': '无法连接插件服务，请确认插件已启用。',
      'error.badRequestHint': '请求参数有误。',
      'error.configHint': '无法读取绑定信息，请重试。',

      'item.draft': 'Draft',
      'item.pr': 'PR',

      'time.justNow': '刚刚',
      'time.minutesAgo': '{count} 分钟前',
      'time.hoursAgo': '{count} 小时前',
      'time.daysAgo': '{count} 天前',
    }

    const en = {
      'common.refresh': 'Refresh',
      'common.retry': 'Retry',
      'common.close': 'Close',
      'common.cancel': 'Cancel',
      'common.bind': 'Bind',
      'common.bound': 'Bound',
      'common.unbind': 'Unbind',
      'common.confirmUnbind': 'Confirm unbind',
      'common.openGithub': 'Open on GitHub',
      'common.items': '{count} items',
      'common.itemsUnknown': 'item count unknown',
      'common.updating': 'Updating…',
      'common.closed': 'Closed',
      'common.all': 'All',
      'common.clearFilter': 'Clear filter',
      'common.unbindFailed': 'Failed to unbind',
      'common.refreshFailed': 'Failed to refresh',

      'projects.sidebarTab': 'Project',
      'projects.openEntry': 'Open GitHub Project',
      'projects.unboundTitle': 'Bind a GitHub Project',
      'projects.unboundText': 'Link this workspace to a GitHub Project; every session can then browse its Issues, PRs and Drafts grouped by status here.',
      'projects.unboundAction': 'Choose a Project',
      'projects.workspaceHint': 'The binding applies to this workspace only: {title}',
      'projects.workspacePath': 'Path: {path}',
      'projects.noWorkspaceTitle': 'This session is not in a workspace',
      'projects.noWorkspaceText': 'Project bindings belong to a workspace. Move this session into one, then come back to bind a Project.',
      'projects.pickerTitle': 'Choose a GitHub Project',
      'projects.pickerSub': 'Grouped by owner; choosing one binds it to this workspace.',
      'projects.pickerFilter': 'Filter by name, owner or number',
      'projects.pickerEmpty': 'No matching Project',
      'projects.pickerEmptyHint': 'Clear the filter, or enter an owner and number below.',
      'projects.pickerCap': 'Showing the first {count}; narrow it down with the filter or manual input.',
      'projects.pickerOwnerErrors': 'Some owners failed to load: {owners}',
      'projects.manualTitle': 'Manual binding',
      'projects.manualHint': 'For Projects the listing cannot see, enter the owner and number directly.',
      'projects.manualOwner': 'owner',
      'projects.manualNumber': 'number',
      'projects.manualOwnerAria': 'Project owner',
      'projects.manualNumberAria': 'Project number',
      'projects.manualInvalid': 'Enter an owner and a valid Project number',
      'projects.ownerTypeUser': 'user',
      'projects.ownerTypeOrg': 'organization',
      'projects.change': 'Change',
      'projects.emptyItemsTitle': 'This Project has no items yet',
      'projects.emptyItemsText': 'Add Issues, PRs or Drafts and they appear here grouped by Status.',
      'projects.truncated': 'Truncated: showing the first {shown} of {total} items.',
      'projects.filterPlaceholder': 'Filter by title, repo, number or label',
      'projects.uncategorized': 'No status',
      'projects.filterEmpty': 'No matching items',
      'projects.refreshing': 'Refreshing…',
      'projects.selectAria': 'Bind Project: {title}',
      'projects.ghWarningTitle': 'gh CLI unavailable',
      'projects.ghWarningHint': 'Install the GitHub CLI and run gh auth login to read project data.',
      'projects.issueBindFailed': 'Failed to bind the Issue',
      'projects.viewBoard': 'Swimlane',
      'projects.viewList': 'List',
      'projects.viewModeAria': 'View mode',
      'projects.milestone.filterAria': 'Filter by milestone',
      'projects.milestone.all': 'All',
      'projects.milestone.backlog': 'Backlog',
      'projects.milestone.backlogHint': 'Items without a milestone',
      'projects.milestone.missing': 'The selected milestone “{title}” is no longer present; switched back to All.',
      'projects.board.emptyColumn': 'No items',
      'projects.bindIssueAria': 'Bind Issue: {title}',
      'projects.loadFailed': 'Failed to load Project items',
      'projects.bindFailed': 'Failed to bind the Project',

      'issue.unboundTitle': 'Bind an Issue to this session',
      'issue.unboundText': 'Once bound, this tab shows the Issue title, body, labels and comments directly.',
      'issue.unboundAction': 'Choose from a Project',
      'issue.refPlaceholder': 'Paste an Issue URL or owner/repo#123',
      'issue.refAria': 'Issue URL or owner/repo#123',
      'issue.invalidRef': 'Enter a valid Issue URL or owner/repo#123',
      'issue.bindFailed': 'Failed to bind the Issue',
      'issue.unboundHint': 'You can also click the project icon on a workspace row and bind from the board in the right sidebar.',
      'subtitle.openAria': 'Open {ref} in the browser',
      'card.openAria': 'Open in browser: {title}',
      'issue.commentCount': '{count} comments',
      'issue.noBody': '(No body)',
      'issue.bodyTruncated': 'The body is too long and was truncated.',
      'issue.comments': 'Comments ({count})',
      'issue.noComments': 'No comments yet',
      'issue.commentsTruncated': '{count} more comments are not shown.',
      'issue.openedBy': 'opened by {author} on {date}',
      'issue.ghost': 'ghost',
      'issue.assignees': 'assigned to {names}',
      'issue.updated': 'updated {time}',
      'issue.stateOpen': 'Open',
      'issue.stateClosed': 'Closed',
      'issue.stateMerged': 'Merged',
      'issue.notIssue': 'This is a Pull Request, not an Issue.',
      'issue.loadFailed': 'Failed to load the Issue',

      'error.title': 'Failed to load GitHub data',
      'error.messageFallback': 'Unknown error',
      'error.codeLabel': 'Error code: {code}',
      'error.ghMissingHint': 'gh CLI was not found; install the GitHub CLI first.',
      'error.ghAuthHint': 'Run gh auth login first.',
      'error.ghFailedHint': 'The GitHub read failed; please retry.',
      'error.timeoutHint': 'GitHub timed out; please retry.',
      'error.issueNotFoundHint': 'Issue not found; it may be deleted or inaccessible.',
      'error.projectNotFoundHint': 'Project not found; it may be deleted or inaccessible.',
      'error.networkHint': 'Cannot reach the plugin service; check that the plugin is enabled.',
      'error.badRequestHint': 'The request is invalid.',
      'error.configHint': 'Cannot read the bindings; please retry.',

      'item.draft': 'Draft',
      'item.pr': 'PR',

      'time.justNow': 'just now',
      'time.minutesAgo': '{count} min ago',
      'time.hoursAgo': '{count} h ago',
      'time.daysAgo': '{count} d ago',
    }

    /* ------------------------------------------------------------------ */
    /* 3. Small pure helpers.                                              */
    /* ------------------------------------------------------------------ */

    const MINUTE = 60_000
    const HOUR = 60 * MINUTE
    const DAY = 24 * HOUR

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /** Local `YYYY-MM-DD`; invalid input renders as an empty string. */
    function formatDate(iso) {
      const time = Date.parse(String(iso ?? ''))
      if (!Number.isFinite(time)) return ''
      const date = new Date(time)
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    }

    /** 刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD (locale-aware). */
    function relativeTime(t, iso) {
      const time = Date.parse(String(iso ?? ''))
      if (!Number.isFinite(time)) return ''
      const diff = Date.now() - time
      if (diff < 0) return t('time.justNow')
      if (diff < MINUTE) return t('time.justNow')
      if (diff < HOUR) return t('time.minutesAgo', { count: Math.floor(diff / MINUTE) })
      if (diff < DAY) return t('time.hoursAgo', { count: Math.floor(diff / HOUR) })
      if (diff < 30 * DAY) return t('time.daysAgo', { count: Math.floor(diff / DAY) })
      return formatDate(iso)
    }

    function isPositiveInteger(value) {
      return typeof value === 'number' && Number.isInteger(value) && value > 0
    }

    function isPlainObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function textOf(value) {
      return typeof value === 'string' ? value : ''
    }

    function statusKeyOf(item) {
      const status = typeof item.status === 'string' ? item.status.trim() : ''
      return status === '' ? NO_STATUS : status
    }

    function itemIdentity(item) {
      if (typeof item.id === 'string' && item.id !== '') return item.id
      return `${item.type ?? 'item'}:${item.repo ?? ''}#${item.number ?? ''}:${item.title ?? ''}`
    }

    /** Distinct statuses in first-seen order, plus the uncategorized bucket last. */
    function collectStatuses(items) {
      const order = []
      const seen = new Set()
      let hasUncategorized = false
      for (const item of items) {
        const key = statusKeyOf(item)
        if (key === NO_STATUS) {
          hasUncategorized = true
          continue
        }
        if (!seen.has(key)) {
          seen.add(key)
          order.push(key)
        }
      }
      if (hasUncategorized) order.push(NO_STATUS)
      return order
    }

    function statusCountsOf(items) {
      const counts = new Map()
      for (const item of items) {
        const key = statusKeyOf(item)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return counts
    }

    function matchesQuery(item, query) {
      if (query === '') return true
      const haystack = [
        textOf(item.title),
        textOf(item.repo),
        item.number === null || item.number === undefined ? '' : String(item.number),
        textOf(item.milestone),
        item.labels === undefined ? '' : asArray(item.labels).join(' '),
      ].join(' ').toLowerCase()
      return haystack.includes(query)
    }

    function filterItems(items, query, statusFilter) {
      const needle = query.trim().toLowerCase()
      return items.filter((item) => {
        if (statusFilter !== ALL_STATUS && statusKeyOf(item) !== statusFilter) return false
        return matchesQuery(item, needle)
      })
    }

    /** Ordered `[{key, items}]` sections for the current filter state. */
    function groupItems(items, statusOrder) {
      const buckets = new Map()
      for (const item of items) {
        const key = statusKeyOf(item)
        const bucket = buckets.get(key)
        if (bucket === undefined) buckets.set(key, [item])
        else bucket.push(item)
      }
      const groups = []
      for (const key of statusOrder) {
        const bucket = buckets.get(key)
        if (bucket !== undefined && bucket.length > 0) groups.push({ key, items: bucket })
      }
      // Defensive: any status not present in the global order still renders.
      for (const [key, bucket] of buckets) {
        if (!statusOrder.includes(key)) groups.push({ key, items: bucket })
      }
      return groups
    }

    /* ------------------------------------------------------------------ */
    /* 3b. Swimlane board + milestone filter helpers (v1.1).              */
    /* ------------------------------------------------------------------ */

    /** The five fixed status swimlanes, left→right (contract §4.2). */
    const BOARD_COLUMNS = [
      { key: 'no-status', label: 'No status', status: null },
      { key: 'todo', label: 'TODO', status: 'todo' },
      { key: 'in-progress', label: 'In Progress', status: 'in progress' },
      { key: 'in-review', label: 'In Review', status: 'in review' },
      { key: 'done', label: 'Done', status: 'done' },
    ]
    const KNOWN_BOARD_COLUMNS = new Set(BOARD_COLUMNS.map((column) => column.key))

    /** Case-insensitive lane assignment; blank → no-status, unknown → other:<raw>. */
    function boardColumnKeyOf(item) {
      const raw = textOf(item.status).trim()
      const normalized = raw.toLowerCase()
      if (normalized === '') return 'no-status'
      for (const column of BOARD_COLUMNS) {
        if (column.status !== null && column.status === normalized) return column.key
      }
      return `other:${raw}`
    }

    function milestoneKeyOf(item) {
      const title = textOf(item.milestone).trim()
      return title === '' ? null : title
    }

    /** Natural version order: v1.1.0 < v1.2.0 < vNext, deterministic. */
    function naturalCompare(left, right) {
      const leftParts = textOf(left).match(/\d+|\D+/gu) ?? []
      const rightParts = textOf(right).match(/\d+|\D+/gu) ?? []
      const length = Math.min(leftParts.length, rightParts.length)
      for (let index = 0; index < length; index += 1) {
        const leftPart = leftParts[index]
        const rightPart = rightParts[index]
        if (/^\d+$/u.test(leftPart) && /^\d+$/u.test(rightPart)) {
          const difference = Number(leftPart) - Number(rightPart)
          if (difference !== 0) return difference
        } else {
          const difference = leftPart.toLowerCase().localeCompare(rightPart.toLowerCase())
          if (difference !== 0) return difference
        }
      }
      return leftParts.length - rightParts.length
    }

    /**
     * Milestone dropdown model from the unfiltered loaded item set:
     * `全部`, `Backlog` (no milestone), then every title in natural order.
     */
    function buildMilestoneOptions(items) {
      const counts = new Map()
      let backlogCount = 0
      for (const item of items) {
        const title = milestoneKeyOf(item)
        if (title === null) {
          backlogCount += 1
        } else {
          counts.set(title, (counts.get(title) ?? 0) + 1)
        }
      }
      const titles = [...counts.keys()].sort(naturalCompare)
      return [
        { key: 'all', labelKey: 'projects.milestone.all', count: items.length },
        { key: 'backlog', labelKey: 'projects.milestone.backlog', count: backlogCount },
        ...titles.map((title) => ({ key: title, label: title, count: counts.get(title) ?? 0 })),
      ]
    }

    function filterByMilestone(items, milestoneFilter) {
      if (milestoneFilter === 'all') return items
      if (milestoneFilter === 'backlog') return items.filter((item) => milestoneKeyOf(item) === null)
      return items.filter((item) => milestoneKeyOf(item) === milestoneFilter)
    }

    /** `[{key, label, items}]` for the board: fixed lanes first, extras after. */
    function buildBoardColumns(allItems, filteredItems) {
      const buckets = new Map()
      for (const column of BOARD_COLUMNS) buckets.set(column.key, [])
      const extraKeys = []
      for (const item of filteredItems) {
        const key = boardColumnKeyOf(item)
        const bucket = buckets.get(key)
        if (bucket === undefined) {
          if (!extraKeys.includes(key)) extraKeys.push(key)
          buckets.set(key, [item])
        } else {
          bucket.push(item)
        }
      }
      const hiddenLanes = []
      const columns = []
      for (const column of BOARD_COLUMNS) {
        const items = buckets.get(column.key) ?? []
        // v0.3.0: an empty No status lane is hidden; the other canonical lanes
        // always render (empty lanes read 无条目). Unknown lanes are never empty.
        if (column.key === 'no-status' && items.length === 0) {
          hiddenLanes.push('no-status')
          continue
        }
        columns.push({ key: column.key, label: column.label, items })
      }
      for (const key of extraKeys) {
        columns.push({ key, label: key.replace(/^other:/u, ''), items: buckets.get(key) ?? [] })
      }
      return { columns, hiddenLanes }
    }

    /** v0.3.0 status accents (contract §4.2.0). Tints are derived in CSS with
     *  color-mix so both DSH light and dark themes resolve correctly. */
    const LANE_ACCENTS = {
      'no-status': 'var(--dsw-alias-label-tertiary, #8a8a8a)',
      todo: 'var(--dsw-static-blue-500, #3b82f6)',
      'in-progress': 'var(--dsw-static-amber-500, #f59e0b)',
      'in-review': '#8b5cf6',
      done: 'var(--dsw-alias-state-success-primary, #3fb950)',
    }
    const OTHER_LANE_ACCENT = '#06b6d4'

    function laneAccentOf(laneKey) {
      if (typeof laneKey !== 'string') return LANE_ACCENTS['no-status']
      if (laneKey.startsWith('other:')) return OTHER_LANE_ACCENT
      return LANE_ACCENTS[laneKey] ?? LANE_ACCENTS['no-status']
    }

    /** Accent for a list-mode section key (raw status text or NO_STATUS). */
    function sectionAccentOf(statusKey) {
      if (statusKey === NO_STATUS) return LANE_ACCENTS['no-status']
      return laneAccentOf(boardColumnKeyOf({ status: statusKey }))
    }

    const LABEL_DOT_PALETTE = [
      'var(--dsw-static-blue-500, #3b82f6)',
      '#8b5cf6',
      '#06b6d4',
      'var(--dsw-alias-state-success-primary, #3fb950)',
      'var(--dsw-static-amber-500, #f59e0b)',
      '#ec4899',
    ]

    /** Deterministic label/initials hash color (decorative dot / avatar only). */
    function hashColorOf(value) {
      const text = textOf(value)
      let hash = 0
      for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 31 + text.charCodeAt(index)) >>> 0
      }
      return LABEL_DOT_PALETTE[hash % LABEL_DOT_PALETTE.length]
    }

    function initialsOf(name) {
      const text = textOf(name).trim()
      return text === '' ? '?' : text.slice(0, 1).toUpperCase()
    }

    const VIEW_MODE_STORAGE_KEY = 'dsh-github-projects:view-mode'

    function readStoredViewMode() {
      try {
        return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === 'list' ? 'list' : 'board'
      } catch (_storageUnavailable) {
        return 'board'
      }
    }

    function storeViewMode(mode) {
      try {
        window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode)
      } catch (_storageUnavailable) {
        /* the in-memory mode still works without storage */
      }
    }

    function safeStateClass(state) {
      const normalized = String(state ?? 'open').toLowerCase()
      if (normalized === 'closed') return 'closed'
      if (normalized === 'merged') return 'merged'
      return 'open'
    }

    function stateLabel(t, state) {
      const variant = safeStateClass(state)
      if (variant === 'closed') return t('issue.stateClosed')
      if (variant === 'merged') return t('issue.stateMerged')
      return t('issue.stateOpen')
    }

    function hintForError(t, error) {
      if (error === null || error === undefined) return null
      switch (error.code) {
        case 'gh-missing': return t('error.ghMissingHint')
        case 'gh-auth': return t('error.ghAuthHint')
        case 'gh-failed': return t('error.ghFailedHint')
        case 'timeout': return t('error.timeoutHint')
        case 'issue-not-found': return t('error.issueNotFoundHint')
        case 'project-not-found': return t('error.projectNotFoundHint')
        case 'network': return t('error.networkHint')
        case 'bad-request': return t('error.badRequestHint')
        default: return null
      }
    }

    function errorMessageOf(error) {
      if (error === null || error === undefined) return ''
      if (typeof error.message === 'string' && error.message !== '') return error.message
      return ''
    }

    function describeError(error) {
      if (error instanceof GhpError) return error
      return new GhpError('network', errorMessageOf(error), 0)
    }

    /* ------------------------------------------------------------------ */
    /* 4. Safe Markdown subset → React elements.                           */
    /*    Fenced code, inline code, headings, lists (incl. task boxes),   */
    /*    blockquotes, rules, paragraphs, autolinks and [text](url).      */
    /*    Nothing here ever produces raw HTML.                            */
    /* ------------------------------------------------------------------ */

    function safeHref(url) {
      const text = textOf(url).trim()
      return /^https?:\/\/\S+$/i.test(text) ? text : null
    }

    function renderInline(text, keyPrefix) {
      const source = textOf(text)
      const nodes = []
      const regex = /`([^`]+)`|\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|(https?:\/\/[^\s<>()\[\]]+)/g
      let match
      let lastIndex = 0
      while ((match = regex.exec(source)) !== null) {
        if (match.index > lastIndex) nodes.push(source.slice(lastIndex, match.index))
        const key = `${keyPrefix}-i${nodes.length}`
        if (match[1] !== undefined) {
          nodes.push(h('code', { key, className: 'ghp-md-inlinecode' }, match[1]))
        } else if (match[3] !== undefined) {
          const href = safeHref(match[3])
          nodes.push(href === null
            ? (match[2] !== '' ? match[2] : match[3])
            : h('a', { key, href, target: '_blank', rel: 'noreferrer noopener' }, match[2] !== '' ? match[2] : href))
        } else if (match[4] !== undefined) {
          nodes.push(h('strong', { key }, match[4]))
        } else if (match[5] !== undefined) {
          let url = match[5]
          let tail = ''
          const trimmed = url.replace(/[.,;:!?]+$/u, '')
          if (trimmed !== url) {
            tail = url.slice(trimmed.length)
            url = trimmed
          }
          nodes.push(h('a', { key, href: url, target: '_blank', rel: 'noreferrer noopener' }, url))
          if (tail !== '') nodes.push(tail)
        }
        lastIndex = regex.lastIndex
      }
      if (lastIndex < source.length) nodes.push(source.slice(lastIndex))
      return nodes
    }

    const BLOCK_START = /^\s{0,3}(?:#{1,6}\s|>|```)/
    const LIST_START = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
    const RULE_LINE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/

    /** Parse the Markdown subset into a plain block list (no DOM yet). */
    function parseBlocks(source) {
      const lines = textOf(source).replace(/\r\n?/gu, '\n').split('\n')
      const blocks = []
      let index = 0
      while (index < lines.length) {
        const line = lines[index]
        if (line.trim() === '') {
          index += 1
          continue
        }
        const fence = /^\s*```\s*([\w+#-]*)\s*$/u.exec(line)
        if (fence !== null) {
          const body = []
          index += 1
          while (index < lines.length && !/^\s*```\s*$/u.test(lines[index])) {
            body.push(lines[index])
            index += 1
          }
          if (index < lines.length) index += 1
          blocks.push({ kind: 'code', lang: fence[1], text: body.join('\n') })
          continue
        }
        const heading = /^\s{0,3}(#{1,6})\s+(.*)$/u.exec(line)
        if (heading !== null) {
          blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].replace(/\s+#+\s*$/u, '') })
          index += 1
          continue
        }
        if (/^\s{0,3}>/u.test(line)) {
          const quoted = []
          while (index < lines.length && /^\s{0,3}>/u.test(lines[index])) {
            quoted.push(lines[index].replace(/^\s{0,3}>\s?/u, ''))
            index += 1
          }
          blocks.push({ kind: 'quote', children: parseBlocks(quoted.join('\n')) })
          continue
        }
        const listStart = LIST_START.exec(line)
        if (listStart !== null) {
          const ordered = /^\d/u.test(listStart[2])
          const items = []
          while (index < lines.length) {
            const match = LIST_START.exec(lines[index])
            if (match === null) {
              const continuation = lines[index]
              if (continuation.trim() !== '' && items.length > 0 && !BLOCK_START.test(continuation)) {
                items[items.length - 1].text += `\n${continuation.trim()}`
                index += 1
                continue
              }
              break
            }
            items.push({ text: match[3] })
            index += 1
          }
          blocks.push({ kind: 'list', ordered, items })
          continue
        }
        if (RULE_LINE.test(line)) {
          blocks.push({ kind: 'hr' })
          index += 1
          continue
        }
        const paragraph = [line]
        index += 1
        while (index < lines.length) {
          const candidate = lines[index]
          if (candidate.trim() === '') break
          if (BLOCK_START.test(candidate)) break
          if (LIST_START.test(candidate)) break
          if (RULE_LINE.test(candidate)) break
          paragraph.push(candidate)
          index += 1
        }
        blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
      }
      return blocks
    }

    function renderListItem(item, key) {
      const raw = textOf(item.text)
      const task = /^\[([ xX])\]\s+/u.exec(raw)
      const content = task === null ? raw : raw.slice(task[0].length)
      const checked = task !== null && task[1].toLowerCase() === 'x'
      return h('li', { key, className: 'ghp-md-li' },
        task === null
          ? null
          : h('span', {
            className: `ghp-md-check${checked ? ' ghp-md-check-on' : ''}`,
            'aria-hidden': true,
          }, checked ? h(IconCheck) : null),
        renderInline(content.replace(/\n/gu, ' '), key))
    }

    function renderBlocks(blocks, keyPrefix) {
      const nodes = []
      blocks.forEach((block, blockIndex) => {
        const key = `${keyPrefix}-${blockIndex}`
        switch (block.kind) {
          case 'code':
            nodes.push(h('pre', { key, className: 'ghp-md-pre' },
              h('code', { className: 'ghp-md-codeblock' }, block.text)))
            break
          case 'heading': {
            const level = Math.min(6, block.level + 2)
            nodes.push(h(`h${level}`, { key, className: 'ghp-md-heading' }, renderInline(block.text, key)))
            break
          }
          case 'quote':
            nodes.push(h('blockquote', { key, className: 'ghp-md-quote' }, renderBlocks(block.children, key)))
            break
          case 'list':
            nodes.push(h(block.ordered ? 'ol' : 'ul', { key, className: 'ghp-md-list' },
              block.items.map((item, itemIndex) => renderListItem(item, `${key}-${itemIndex}`))))
            break
          case 'hr':
            nodes.push(h('hr', { key, className: 'ghp-md-hr' }))
            break
          default:
            nodes.push(h('p', { key, className: 'ghp-md-p' },
              renderInline(textOf(block.text).replace(/\n/gu, ' '), key)))
        }
      })
      return nodes
    }

    function Markdown({ text }) {
      const blocks = useMemo(() => parseBlocks(text), [text])
      return h('div', { className: 'ghp-md' }, renderBlocks(blocks, 'md'))
    }

    /* ------------------------------------------------------------------ */
    /* 5. Icons — inline SVG only, no external assets.                     */
    /* ------------------------------------------------------------------ */

    function GlyphIcon({ size = 16, fill = 'none', children }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': true,
        focusable: 'false',
        fill,
        stroke: fill === 'none' ? 'currentColor' : 'none',
        strokeWidth: fill === 'none' ? 1.4 : undefined,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }, children)
    }

    function IconProject({ size = 16 }) {
      return h(GlyphIcon, { size },
        h('rect', { key: 'r', x: 1.75, y: 2.75, width: 12.5, height: 10.5, rx: 2 }),
        h('path', { key: 'a', d: 'M6.1 2.75v10.5M9.9 2.75v10.5' }))
    }

    function IconIssue({ size = 16 }) {
      return h(GlyphIcon, { size },
        h('circle', { key: 'c', cx: 8, cy: 8, r: 6.1 }),
        h('circle', { key: 'd', cx: 8, cy: 8, r: 1.7, fill: 'currentColor', stroke: 'none' }))
    }

    function IconPr({ size = 16 }) {
      return h(GlyphIcon, { size, fill: 'currentColor' },
        h('path', {
          key: 'p',
          d: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
        }))
    }

    function IconDraft({ size = 16 }) {
      return h(GlyphIcon, { size },
        h('rect', { key: 'r', x: 2.3, y: 2.3, width: 11.4, height: 11.4, rx: 2, strokeDasharray: '2.6 2.2' }))
    }

    function IconSearch({ size = 16 }) {
      return h(GlyphIcon, { size },
        h('circle', { key: 'c', cx: 7.1, cy: 7.1, r: 4.35 }),
        h('path', { key: 'p', d: 'm10.35 10.35 3 3' }))
    }

    function IconRefresh({ size = 16 }) {
      return h(GlyphIcon, { size, fill: 'currentColor' },
        h('path', {
          key: 'p',
          d: 'M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z',
        }))
    }

    function IconClose({ size = 16 }) {
      return h(GlyphIcon, { size },
        h('path', { key: 'p', d: 'm3.5 3.5 9 9M12.5 3.5l-9 9' }))
    }

    function IconAlert({ size = 16 }) {
      return h(GlyphIcon, { size },
        h('circle', { key: 'c', cx: 8, cy: 8, r: 6.1 }),
        h('path', { key: 'l', d: 'M8 4.7v4.1' }),
        h('circle', { key: 'd', cx: 8, cy: 11.3, r: 0.85, fill: 'currentColor', stroke: 'none' }))
    }

    function IconCheck({ size = 16 }) {
      return h(GlyphIcon, { size }, h('path', { key: 'p', d: 'm3.2 8.4 3.2 3.2 6.4-6.9' }))
    }

    function IconExternal({ size = 16 }) {
      return h(GlyphIcon, { size },
        h('path', { key: 'a', d: 'M6.9 3.4H4.2a1.4 1.4 0 0 0-1.4 1.4v6.9a1.4 1.4 0 0 0 1.4 1.4h6.9a1.4 1.4 0 0 0 1.4-1.4V9.2' }),
        h('path', { key: 'b', d: 'M9.4 2.6h4v4' }),
        h('path', { key: 'c', d: 'M13.2 2.8 7.3 8.7' }))
    }

    function IconComment({ size = 16 }) {
      return h(GlyphIcon, { size },
        h('path', { key: 'p', d: 'M13.4 8.9a4.4 4.4 0 0 1-4.4 4.4H4.6l-2.2 1.4.5-2.7a4.4 4.4 0 0 1-3.3-4.3v-1a4.4 4.4 0 0 1 4.4-4.4h5.4a4.4 4.4 0 0 1 4.4 4.4Z' }))
    }

    function IconMilestone({ size = 16 }) {
      return h(GlyphIcon, { size },
        h('path', { key: 'a', d: 'M3.6 2.5v11' }),
        h('path', { key: 'b', d: 'M3.6 3.2h7.6l2 2.1-2 2.1H3.6' }))
    }

    function IconLink({ size = 16 }) {
      return h(GlyphIcon, { size },
        h('path', { key: 'a', d: 'M6.4 9.6a2.8 2.8 0 0 0 3.95 0l1.8-1.8a2.8 2.8 0 0 0-3.95-3.95l-.7.7' }),
        h('path', { key: 'b', d: 'M9.6 6.4a2.8 2.8 0 0 0-3.95 0l-1.8 1.8a2.8 2.8 0 0 0 3.95 3.95l.7-.7' }))
    }

    function IconArrow({ size = 16 }) {
      return h(GlyphIcon, { size }, h('path', { key: 'p', d: 'm5.8 3.2 4.8 4.8-4.8 4.8' }))
    }

    function IconChevronDown({ size = 16 }) {
      return h(GlyphIcon, { size }, h('path', { key: 'p', d: 'm3.8 6.2 4.2 4.1 4.2-4.1' }))
    }

    function IconLayoutBoard({ size = 16 }) {
      return h(GlyphIcon, { size },
        h('rect', { key: 'a', x: 1.9, y: 2.6, width: 3.3, height: 10.8, rx: 1 }),
        h('rect', { key: 'b', x: 6.35, y: 2.6, width: 3.3, height: 10.8, rx: 1 }),
        h('rect', { key: 'c', x: 10.8, y: 2.6, width: 3.3, height: 10.8, rx: 1 }))
    }

    function IconLayoutList({ size = 16 }) {
      return h(GlyphIcon, { size },
        h('path', { key: 'a', d: 'M2.4 4h1.2M6.2 4h7.4M2.4 8h1.2M6.2 8h7.4M2.4 12h1.2M6.2 12h7.4' }))
    }

    function itemTypeIcon(type, size = 16) {
      if (type === 'pr') return h(IconPr, { size })
      if (type === 'draft') return h(IconDraft, { size })
      return h(IconIssue, { size })
    }

    /* ------------------------------------------------------------------ */
    /* 6. Shared atoms.                                                    */
    /* ------------------------------------------------------------------ */

    function Button({ variant = 'secondary', size = 'md', icon, children, className, ...rest }) {
      const classes = ['ghp-btn']
      if (variant !== 'secondary') classes.push(`ghp-btn-${variant}`)
      if (size === 'sm') classes.push('ghp-btn-sm')
      if (typeof className === 'string' && className !== '') classes.push(className)
      const labelParts = Array.isArray(children) ? children : [children]
      return h('button', { type: 'button', className: classes.join(' '), ...rest },
        icon === undefined || icon === null ? null : h('span', { className: 'ghp-btn-icon', 'aria-hidden': true }, icon),
        children === undefined || children === null
          ? null
          : h('span', { className: 'ghp-btn-label' }, ...labelParts))
    }

    function Spinner({ size = 14 }) {
      return h('span', { className: 'ghp-spinner', style: { width: `${size}px`, height: `${size}px` }, 'aria-hidden': true })
    }

    function SkeletonBlock({ className = '' }) {
      return h('div', { className: `ghp-sk ${className}`.trim(), 'aria-hidden': true })
    }

    function StateBadge({ state, t }) {
      return h('span', { className: `ghp-state ghp-state-${safeStateClass(state)}` }, stateLabel(t, state))
    }

    function LabelPill({ name }) {
      return h('span', { className: 'ghp-label' },
        h('span', {
          className: 'ghp-label-dot',
          style: { background: hashColorOf(name) },
          'aria-hidden': true,
        }),
        h('span', { className: 'ghp-label-name' }, name))
    }

    function ConfirmAction({ t, label, confirmLabel, onConfirm, busy = false, className = 'ghp-btn ghp-btn-ghost', disabled = false }) {
      const [confirming, setConfirming] = useState(false)
      useEffect(() => {
        if (!confirming) return undefined
        const timer = window.setTimeout(() => setConfirming(false), 6000)
        return () => window.clearTimeout(timer)
      }, [confirming])
      if (!confirming) {
        return h('button', {
          type: 'button',
          className,
          disabled: disabled || busy,
          onClick: () => setConfirming(true),
        }, h('span', { className: 'ghp-btn-label' }, label))
      }
      return h('span', { className: 'ghp-confirm', role: 'group', 'aria-label': label },
        h('button', {
          type: 'button',
          className: 'ghp-btn ghp-btn-danger ghp-btn-sm',
          disabled: busy,
          onClick: () => {
            setConfirming(false)
            Promise.resolve(onConfirm()).catch(() => {})
          },
        },
        busy ? h('span', { className: 'ghp-btn-icon', 'aria-hidden': true }, h(Spinner, { size: 12 })) : null,
        h('span', { className: 'ghp-btn-label' }, confirmLabel)),
        h('button', {
          type: 'button',
          className: 'ghp-btn ghp-btn-ghost ghp-btn-sm',
          disabled: busy,
          onClick: () => setConfirming(false),
        }, h('span', { className: 'ghp-btn-label' }, t('common.cancel'))))
    }

    function ErrorCard({ t, error, onRetry, compact = false, title }) {
      const hint = hintForError(t, error)
      const message = errorMessageOf(error)
      const code = error !== null && error !== undefined && typeof error.code === 'string' ? error.code : null
      return h('div', { className: `ghp-errorcard${compact ? ' ghp-errorcard-compact' : ''}`, role: 'alert' },
        h('div', { className: 'ghp-errorcard-icon', 'aria-hidden': true }, h(IconAlert)),
        h('div', { className: 'ghp-errorcard-body' },
          h('div', { className: 'ghp-errorcard-title' }, title ?? t('error.title')),
          hint === null ? null : h('div', { className: 'ghp-errorcard-hint' }, hint),
          hint === null && message !== '' ? h('div', { className: 'ghp-errorcard-message' }, message) : null,
          hint !== null && message !== '' && message !== hint
            ? h('div', { className: 'ghp-errorcard-message' }, message)
            : null,
          code === null ? null : h('div', { className: 'ghp-errorcard-code' }, t('error.codeLabel', { code }))),
        onRetry === undefined || onRetry === null
          ? null
          : h(Button, { variant: 'primary', size: 'sm', onClick: onRetry }, t('common.retry')))
    }

    function SearchInput({ value, onChange, placeholder, ariaLabel, inputRef }) {
      return h('div', { className: 'ghp-search' },
        h('span', { className: 'ghp-search-icon', 'aria-hidden': true }, h(IconSearch)),
        h('input', {
          ref: inputRef,
          className: 'ghp-input ghp-search-input',
          type: 'text',
          value,
          placeholder,
          'aria-label': ariaLabel,
          autoComplete: 'off',
          spellCheck: false,
          onChange: (event) => onChange(event.target.value),
        }))
    }

    /** `/config` answers `gh.error === 'pending'` while the first gh probe runs. */
    function isPendingHealth(gh) {
      return isPlainObject(gh) && gh.available === false && textOf(gh.error) === 'pending'
    }

    /**
     * While health is still pending, re-read the cheap local `/config` once or
     * twice (~1.5s) so the real gh status replaces the placeholder; the banner
     * stays hidden until a real failure arrives.
     */
    function useGhPendingRetry(gh, sessionId, workspaceId, setGh) {
      const attemptsRef = useRef(0)
      useEffect(() => {
        if (!isPendingHealth(gh)) {
          attemptsRef.current = 0
          return undefined
        }
        if (attemptsRef.current >= 2) return undefined
        let cancelled = false
        let timer = 0
        const tick = () => {
          if (cancelled) return
          attemptsRef.current += 1
          readConfigNow(sessionId, workspaceId)
            .then((data) => {
              if (cancelled || !isPlainObject(data) || !isPlainObject(data.gh)) return
              setGh(data.gh)
            })
            .catch(() => { /* keep suppressing the placeholder banner */ })
        }
        timer = window.setTimeout(tick, 1500)
        return () => {
          cancelled = true
          window.clearTimeout(timer)
        }
      }, [gh, sessionId, workspaceId, setGh])
    }

    function GHWarning({ t, gh }) {
      if (isPendingHealth(gh)) return null
      if (!isPlainObject(gh) || gh.available !== false) return null
      const detail = textOf(gh.error)
      return h('div', { className: 'ghp-banner ghp-banner-warn', role: 'status' },
        h('span', { className: 'ghp-banner-icon', 'aria-hidden': true }, h(IconAlert)),
        h('div', { className: 'ghp-banner-body' },
          h('div', { className: 'ghp-banner-title' }, t('projects.ghWarningTitle')),
          h('div', { className: 'ghp-banner-hint' }, t('projects.ghWarningHint')),
          detail === '' ? null : h('div', { className: 'ghp-banner-hint' }, detail)))
    }

    function ActionBanner({ t, title, error, onDismiss }) {
      if (error === null || error === undefined) return null
      const hint = hintForError(t, error)
      const message = errorMessageOf(error)
      return h('div', { className: 'ghp-banner ghp-banner-error', role: 'alert' },
        h('span', { className: 'ghp-banner-icon', 'aria-hidden': true }, h(IconAlert)),
        h('div', { className: 'ghp-banner-body' },
          h('div', { className: 'ghp-banner-title' }, title),
          hint === null ? null : h('div', { className: 'ghp-banner-hint' }, hint),
          hint === null && message !== '' ? h('div', { className: 'ghp-banner-hint' }, message) : null),
        onDismiss === undefined || onDismiss === null
          ? null
          : h('button', {
            type: 'button',
            className: 'ghp-iconbtn ghp-banner-close',
            onClick: onDismiss,
            'aria-label': t('common.close'),
            title: t('common.close'),
          }, h(IconClose, { size: 14 })))
    }

    /**
     * Contain the view inside the conversation body viewport. The shipped shell
     * renders Views inside a column whose scroll parent also hosts the
     * composer; measuring that pair once gives the view its own fixed-height
     * scrollport (falling back to the CSS `height: 100%` when the shell does
     * not match), so long lists never push the composer around.
     */
    function useContainedViewport(rootRef) {
      const [height, setHeight] = useState(null)
      useLayoutEffect(() => {
        const root = rootRef.current
        if (root === null || root === undefined) return undefined
        const scroller = root.closest('[data-conversation-scroll]')
        if (scroller === null) return undefined
        let frame = 0
        const measure = () => {
          frame = 0
          const total = scroller.clientHeight
          const seat = scroller.querySelector('[data-composer-seat]')
          const seatHeight = seat === null ? 0 : seat.getBoundingClientRect().height
          const next = Math.floor(total - seatHeight)
          if (!Number.isFinite(next) || next < 160) return
          setHeight((previous) => (previous !== null && Math.abs(previous - next) <= 1 ? previous : next))
        }
        const schedule = () => {
          if (frame !== 0) return
          frame = window.requestAnimationFrame(measure)
        }
        measure()
        let observer = null
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(schedule)
          observer.observe(scroller)
          const seat = scroller.querySelector('[data-composer-seat]')
          if (seat !== null) observer.observe(seat)
        }
        window.addEventListener('resize', schedule)
        return () => {
          if (frame !== 0) window.cancelAnimationFrame(frame)
          if (observer !== null) observer.disconnect()
          window.removeEventListener('resize', schedule)
        }
      }, [rootRef])
      return height
    }

    /* ------------------------------------------------------------------ */
    /* 7. Project picker — modal dialog over the `projects` view.          */
    /* ------------------------------------------------------------------ */

    function ProjectPicker({ t, onClose, onSelect, currentProject, bounds }) {
      const [state, setState] = useState({ status: 'loading', data: null, error: null })
      const [reload, setReload] = useState(0)
      const [query, setQuery] = useState('')
      const [manualOwner, setManualOwner] = useState('')
      const [manualNumber, setManualNumber] = useState('')
      const [manualError, setManualError] = useState(null)
      const [busyKey, setBusyKey] = useState(null)
      const [actionError, setActionError] = useState(null)
      const mountedRef = useRef(true)
      const searchRef = useRef(null)

      useEffect(() => () => { mountedRef.current = false }, [])

      useEffect(() => {
        let cancelled = false
        const key = projectsCacheKey()
        const cached = reload === 0 ? cachedResponseOf(key) : null
        if (cached !== null) {
          setState({ status: 'ready', data: cached, error: null })
        } else {
          setState((previous) => ({
            status: previous.data === null || previous.data === undefined ? 'loading' : 'refreshing',
            data: previous.data ?? null,
            error: null,
          }))
        }
        requestWithCache('/projects', key)
          .then((data) => {
            if (cancelled) return
            setState({ status: 'ready', data, error: null })
          })
          .catch((error) => {
            if (cancelled) return
            setState((previous) => ({ status: 'error', data: previous.data ?? null, error: describeError(error) }))
          })
        return () => { cancelled = true }
      }, [reload])

      // Focus the filter on open; Esc closes from anywhere (capture phase so
      // the shell's own handlers do not swallow it first).
      useEffect(() => {
        const timer = window.setTimeout(() => {
          const input = searchRef.current
          if (input !== null && input !== undefined) input.focus()
        }, 0)
        return () => window.clearTimeout(timer)
      }, [])

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [onClose])

      const data = state.data
      const projects = asArray(data === null || data === undefined ? null : data.projects)
      const owners = asArray(data === null || data === undefined ? null : data.owners)
      const ownerTypes = new Map()
      for (const owner of owners) {
        if (isPlainObject(owner) && typeof owner.login === 'string') ownerTypes.set(owner.login, owner.type)
      }
      const ownerErrors = asArray(data === null || data === undefined ? null : data.errors)
      const needle = query.trim().toLowerCase()
      const filtered = needle === ''
        ? projects
        : projects.filter((project) => {
          const haystack = [
            textOf(project.title),
            textOf(project.owner),
            project.number === undefined || project.number === null ? '' : String(project.number),
          ].join(' ').toLowerCase()
          return haystack.includes(needle)
        })
      const capped = filtered.slice(0, 30)

      // Group by owner, first-seen order, without losing the project order.
      const groups = []
      const groupIndex = new Map()
      for (const project of capped) {
        const owner = textOf(project.owner)
        let group = groupIndex.get(owner)
        if (group === undefined) {
          group = { owner, projects: [] }
          groupIndex.set(owner, group)
          groups.push(group)
        }
        group.projects.push(project)
      }

      const ownerTypeLabel = (owner) => {
        const type = ownerTypes.get(owner)
        if (type === 'organization') return t('projects.ownerTypeOrg')
        if (type === 'user') return t('projects.ownerTypeUser')
        return ''
      }

      const isCurrent = (project) => isPlainObject(currentProject)
        && currentProject.owner === project.owner
        && currentProject.number === project.number

      const choose = async (project, options) => {
        setBusyKey(`${project.owner}/${project.number}`)
        setActionError(null)
        try {
          await onSelect(project, options)
        } catch (error) {
          if (mountedRef.current) setActionError(describeError(error))
        } finally {
          if (mountedRef.current) setBusyKey(null)
        }
      }

      const submitManual = async (event) => {
        event.preventDefault()
        const owner = manualOwner.trim().replace(/^@/u, '')
        const number = Number.parseInt(manualNumber.trim(), 10)
        if (owner === '' || !isPositiveInteger(number)) {
          setManualError(new GhpError('invalid-project', t('projects.manualInvalid')))
          return
        }
        setManualError(null)
        const project = {
          owner,
          ownerType: 'user',
          number,
          title: `${owner} #${number}`,
          url: null,
          itemCount: null,
          closed: false,
          description: null,
        }
        await choose(project, { manual: true })
      }

      const renderRow = (project) => {
        const key = `${textOf(project.owner)}/${project.number}`
        const busy = busyKey === key
        const itemCount = project.itemCount
        return h('button', {
          key,
          type: 'button',
          className: 'ghp-picker-row',
          disabled: busyKey !== null,
          'aria-label': t('projects.selectAria', { title: textOf(project.title) }),
          onClick: () => { void choose(project) },
        },
        h('span', { className: 'ghp-picker-row-glyph', 'aria-hidden': true }, h(IconProject)),
        h('span', { className: 'ghp-picker-row-main' },
          h('span', { className: 'ghp-picker-row-titleline' },
            h('span', { className: 'ghp-picker-row-title' }, textOf(project.title) || `${project.owner} #${project.number}`),
            isCurrent(project) ? h('span', { className: 'ghp-badge ghp-badge-bound' }, t('common.bound')) : null,
            project.closed === true ? h('span', { className: 'ghp-badge ghp-badge-closed' }, t('common.closed')) : null),
          h('span', { className: 'ghp-picker-row-meta' },
            h('span', null, `${textOf(project.owner)} / #${project.number}`),
            h('span', { className: 'ghp-dot', 'aria-hidden': true }, '·'),
            h('span', null, isPositiveInteger(itemCount) || itemCount === 0 ? t('common.items', { count: itemCount }) : t('common.itemsUnknown')),
            textOf(project.description) === '' ? null : h('span', { className: 'ghp-picker-row-desc' }, textOf(project.description)))),
        h('span', { className: 'ghp-picker-row-trail', 'aria-hidden': true }, busy ? h(Spinner, { size: 14 }) : h(IconArrow, { size: 14 })))
      }

      const body = (() => {
        if (state.status === 'loading') {
          return h('div', { className: 'ghp-picker-loading' },
            h(SkeletonBlock, { className: 'ghp-sk-line' }),
            h(SkeletonBlock, { className: 'ghp-sk-row' }),
            h(SkeletonBlock, { className: 'ghp-sk-row' }),
            h(SkeletonBlock, { className: 'ghp-sk-row' }))
        }
        if (state.status === 'error' && (state.data === null || state.data === undefined)) {
          return h('div', { className: 'ghp-picker-error' },
            h(ErrorCard, { t, error: state.error, compact: true, onRetry: () => setReload((value) => value + 1) }))
        }
        if (filtered.length === 0) {
          return h('div', { className: 'ghp-picker-empty' },
            h('div', { className: 'ghp-picker-empty-title' }, t('projects.pickerEmpty')),
            h('div', { className: 'ghp-picker-empty-hint' }, t('projects.pickerEmptyHint')))
        }
        return groups.map((group) => h('div', { key: group.owner || 'unknown', className: 'ghp-picker-group' },
          h('div', { className: 'ghp-picker-group-head' },
            h('span', null, group.owner === '' ? '—' : group.owner),
            ownerTypeLabel(group.owner) === ''
              ? null
              : h('span', { className: 'ghp-picker-group-type' }, ownerTypeLabel(group.owner))),
          group.projects.map(renderRow)))
      })()

      // The scrim is portal'd (so no ancestor stacking/overflow can clip it)
      // but sized to the View's own rect, so it reads as an in-view overlay
      // over the item list — the header tabs and the composer stay untouched.
      const overlayStyle = bounds === null || bounds === undefined
        ? undefined
        : { top: `${bounds.top}px`, left: `${bounds.left}px`, width: `${bounds.width}px`, height: `${bounds.height}px` }
      const panelStyle = bounds === null || bounds === undefined
        ? undefined
        : { maxHeight: `${Math.max(240, Math.floor(bounds.height - 32))}px` }

      return ReactDOM.createPortal(
        h('div', {
          className: 'ghp-overlay',
          style: overlayStyle,
          onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
        },
        h('div', {
          className: 'ghp-picker',
          style: panelStyle,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'ghp-picker-title',
        },
        h('div', { className: 'ghp-picker-head' },
          h('div', { className: 'ghp-picker-heading' },
            h('h2', { className: 'ghp-picker-title', id: 'ghp-picker-title' }, t('projects.pickerTitle')),
            h('p', { className: 'ghp-picker-sub' }, t('projects.pickerSub'))),
          h('button', {
            type: 'button',
            className: 'ghp-iconbtn ghp-picker-close',
            onClick: onClose,
            'aria-label': t('common.close'),
            title: t('common.close'),
          }, h(IconClose, { size: 16 }))),
        h('div', { className: 'ghp-picker-search' },
          h(SearchInput, {
            value: query,
            onChange: setQuery,
            placeholder: t('projects.pickerFilter'),
            ariaLabel: t('projects.pickerFilter'),
            inputRef: searchRef,
          })),
        actionError === null ? null : h('div', { className: 'ghp-picker-action-error' },
          h(ActionBanner, {
            t,
            title: t('projects.bindFailed'),
            error: actionError,
            onDismiss: () => setActionError(null),
          })),
        ownerErrors.length === 0 ? null : h('div', { className: 'ghp-picker-note' },
          t('projects.pickerOwnerErrors', {
            owners: ownerErrors.map((entry) => (isPlainObject(entry)
              ? textOf(entry.owner) || textOf(entry.login) || textOf(entry.message) || '?'
              : String(entry))).join(', '),
          })),
        h('div', { className: 'ghp-picker-body' }, body,
          filtered.length > 30 ? h('div', { className: 'ghp-picker-cap' }, t('projects.pickerCap', { count: 30 })) : null),
        h('div', { className: 'ghp-picker-foot' },
          h('div', { className: 'ghp-picker-foot-title' }, t('projects.manualTitle')),
          h('p', { className: 'ghp-picker-note' }, t('projects.manualHint')),
          h('form', { className: 'ghp-manual', onSubmit: submitManual },
            h('input', {
              className: 'ghp-input',
              type: 'text',
              value: manualOwner,
              placeholder: t('projects.manualOwner'),
              'aria-label': t('projects.manualOwnerAria'),
              autoComplete: 'off',
              spellCheck: false,
              onChange: (event) => setManualOwner(event.target.value),
            }),
            h('input', {
              className: 'ghp-input ghp-manual-number',
              type: 'text',
              inputMode: 'numeric',
              value: manualNumber,
              placeholder: t('projects.manualNumber'),
              'aria-label': t('projects.manualNumberAria'),
              autoComplete: 'off',
              onChange: (event) => setManualNumber(event.target.value.replace(/[^\d]/gu, '')),
            }),
            h(Button, {
              variant: 'primary',
              type: 'submit',
              disabled: busyKey !== null,
            }, busyKey !== null ? h(Spinner, { size: 12 }) : null, t('common.bind'))),
          manualError === null ? null : h('div', { className: 'ghp-inline-error', role: 'alert' }, errorMessageOf(manualError))))),
        document.body,
      )
    }

    /* ------------------------------------------------------------------ */
    /* 8. Session issue subtitle (§4.5).                                   */
    /* ------------------------------------------------------------------ */

    function sameBoundIssue(left, right) {
      if (left === null || left === undefined) return right === null || right === undefined
      if (right === null || right === undefined) return false
      return left.repo === right.repo
        && left.number === right.number
        && left.title === right.title
        && left.url === right.url
        && left.state === right.state
    }

    function subtitleFullTextOf(issue) {
      return `${textOf(issue.repo)}#${issue.number} ${textOf(issue.title)}`.trim()
    }

    /**
     * Hidden helper in `conversation.session.header.actions`: gets sessionId,
     * renders null in the actions row, and owns a portal row inserted under the
     * session title. The shipped header has no subtitle slot (§4.5), so the row
     * is re-ensured after host re-renders and degrades to nothing when the
     * anchor is missing.
     */
    function SessionIssueSubtitle({ sessionId, t }) {
      const [issue, setIssue] = useState(null)
      const [host, setHost] = useState(null)
      const sessionRef = useRef(sessionId)
      sessionRef.current = sessionId
      const hasIssue = issue !== null

      // Read the shared session→Issue map (one cheap /bindings poll in apply);
      // our own writes update the map optimistically and fan out immediately.
      useEffect(() => {
        const sync = () => {
          const next = issueBindingOf(sessionRef.current)
          setIssue((previous) => (sameBoundIssue(previous, next) ? previous : next))
        }
        sync()
        const unsubscribe = subscribeBindingMap(sync)
        return unsubscribe
      }, [sessionId])

      // Own a header row: insert after the title row / before the tabs container
      // (both live in the display:contents outlet inside the header) and keep it
      // there across host re-renders.
      useLayoutEffect(() => {
        if (!hasIssue) {
          setHost((previous) => {
            if (previous !== null) previous.remove()
            return null
          })
          return undefined
        }
        const hostElement = document.createElement('div')
        hostElement.className = 'ghp-session-subtitle'
        hostElement.setAttribute('data-ghp-session-subtitle', '')
        let frame = 0
        const place = () => {
          frame = 0
          const header = hostElement.isConnected
            ? hostElement.closest('header[data-window-drag]')
            : document.querySelector('header[data-window-drag]')
          if (header === null) { hostElement.remove(); return }
          const viewTabs = header.querySelector('[data-conversation-tabs]')
          // No tabs ⇒ blank / chrome-less session: hide the subtitle.
          if (viewTabs === null) { hostElement.remove(); return }
          // The shipped tab row is `.tabs > .viewTabs[data-conversation-tabs]`.
          // The subtitle must be its own header grid row between the title row
          // and that whole tab row, so insert into their display:contents outlet.
          const tabsRow = viewTabs.parentElement !== null && viewTabs.parentElement !== header
            ? viewTabs.parentElement
            : viewTabs
          const parent = tabsRow.parentElement
          if (parent === null) { hostElement.remove(); return }
          if (tabsRow.previousElementSibling !== hostElement) parent.insertBefore(hostElement, tabsRow)
          // Align with the title text start and occupy grid column 2.
          hostElement.style.gridColumn = '2'
          if (hostElement.style.paddingInlineStart === '') {
            const titleRow = header.children.length > 1 ? header.children[1] : null
            const innerTitle = header.querySelector('[class*="titleRow"]')
            const source = innerTitle ?? titleRow
            if (source !== null && source !== undefined && typeof getComputedStyle === 'function') {
              const computed = getComputedStyle(source)
              if (computed.paddingInlineStart !== '') hostElement.style.paddingInlineStart = computed.paddingInlineStart
            }
          }
        }
        const schedule = () => {
          if (frame !== 0) return
          frame = window.requestAnimationFrame(place)
        }
        place()
        setHost(hostElement)
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true })
        const timer = window.setInterval(schedule, 1500)
        window.addEventListener('resize', schedule)
        return () => {
          if (frame !== 0) window.cancelAnimationFrame(frame)
          observer.disconnect()
          window.clearInterval(timer)
          window.removeEventListener('resize', schedule)
          hostElement.remove()
        }
      }, [hasIssue, sessionId])

      if (host === null || issue === null) return null
      const fullText = subtitleFullTextOf(issue)
      const issueRef = `${textOf(issue.repo)}#${issue.number}`
      return ReactDOM.createPortal(
        h('button', {
          type: 'button',
          className: 'ghp-session-subtitle-row',
          title: fullText,
          'aria-label': t('subtitle.openAria', { ref: issueRef }),
          onClick: () => openGithubUrl(issue.url),
        },
        h('span', { className: 'ghp-session-subtitle-chip', 'data-ghp-subtitle-chip': '' }, `#${issue.number}`),
        h('span', {
          className: 'ghp-session-subtitle-title',
          'data-ghp-subtitle-title': '',
          title: fullText,
        }, textOf(issue.title))),
        host,
      )
    }

    /* ------------------------------------------------------------------ */
    /* 8b. Sidebar session subtitle decorator (§4.6).                      */
    /* ------------------------------------------------------------------ */

    /**
     * Non-interactive subtitle (v1.0.1): a plain span, so clicks bubble to the
     * shipped session-row handler and only ever open/select the session — the
     * subtitle must never open the Issue.
     */
    function sidebarSubtitleNodeFor(issue) {
      const node = document.createElement('span')
      node.className = 'ghp-sidebar-subtitle'
      node.setAttribute('data-ghp-sidebar-subtitle', '')
      const chip = document.createElement('span')
      chip.className = 'ghp-sidebar-subtitle-chip'
      chip.setAttribute('data-ghp-sidebar-subtitle-chip', '')
      const title = document.createElement('span')
      title.className = 'ghp-sidebar-subtitle-title'
      title.setAttribute('data-ghp-sidebar-subtitle-title', '')
      node.append(chip, title)
      return node
    }

    function updateSidebarSubtitleNode(node, issue) {
      const chip = node.querySelector('[data-ghp-sidebar-subtitle-chip]')
      const title = node.querySelector('[data-ghp-sidebar-subtitle-title]')
      const numberText = `#${issue.number}`
      const titleText = textOf(issue.title)
      const fullText = `${textOf(issue.repo)}#${issue.number} ${titleText}`.trim()
      if (chip !== null && chip.textContent !== numberText) chip.textContent = numberText
      if (title !== null) {
        if (title.textContent !== titleText) title.textContent = titleText
        if (title.getAttribute('title') !== fullText) title.setAttribute('title', fullText)
      }
    }

    /**
     * Guarded DOM decorator (the shipped sidebar has no subtitle slot): for every
     * session row with a binding, ensure exactly one `[data-ghp-sidebar-subtitle]`
     * child; remove it for unbound sessions. Sweeps are rAF-throttled and driven
     * by the binding map, a tree MutationObserver and a 1.5s re-ensure interval.
     */
    function installSidebarSubtitles(ctx) {
      ctx.effect(() => {
        let stopped = false
        let scheduled = false
        let observer = null
        let observedTree = null

        const findTree = () => {
          const sampleRow = document.querySelector('[data-row-key^="session:"]')
          if (sampleRow === null) return null
          const tree = sampleRow.closest('[role="tree"]')
          if (tree !== null) return tree
          const parent = sampleRow.parentElement
          return parent === null ? null : parent.parentElement ?? parent
        }

        const ensureObserver = () => {
          if (stopped) return
          if (observedTree !== null && observedTree.isConnected) return
          if (observer === null) observer = new MutationObserver(() => schedule())
          observer.disconnect()
          observedTree = findTree()
          if (observedTree !== null) observer.observe(observedTree, { childList: true, subtree: true })
        }

        const sweep = () => {
          scheduled = false
          if (stopped) return
          ensureObserver()
          const rows = document.querySelectorAll('[data-row-key^="session:"]')
          for (const row of rows) {
            if (!(row instanceof HTMLElement)) continue
            const rowKey = row.getAttribute('data-row-key') ?? ''
            if (!rowKey.startsWith('session:')) continue
            const sessionId = rowKey.slice('session:'.length)
            const issue = issueBindingOf(sessionId)
            const existing = row.querySelector(':scope > [data-ghp-sidebar-subtitle]')
            if (issue === null) {
              if (existing !== null) existing.remove()
              continue
            }
            if (existing === null) {
              const node = sidebarSubtitleNodeFor(issue)
              updateSidebarSubtitleNode(node, issue)
              row.appendChild(node)
            } else {
              updateSidebarSubtitleNode(existing, issue)
            }
          }
        }

        const schedule = () => {
          if (stopped || scheduled) return
          scheduled = true
          window.requestAnimationFrame(sweep)
        }

        schedule()
        const timer = window.setInterval(() => { ensureObserver(); schedule() }, 1500)
        const unsubscribe = subscribeBindingMap(schedule)
        const offEvent = onBindingChanged(schedule)
        window.addEventListener('resize', schedule)
        return () => {
          stopped = true
          if (observer !== null) observer.disconnect()
          window.clearInterval(timer)
          unsubscribe()
          offEvent()
          window.removeEventListener('resize', schedule)
          for (const node of document.querySelectorAll('[data-ghp-sidebar-subtitle]')) node.remove()
        }
      }, 'github-projects: sidebar session subtitles')
    }

    /* ------------------------------------------------------------------ */
    /* ------------------------------------------------------------------ */
    /* 8c. Workspace project entry + right-sidebar board (v1.0.2 preview). */
    /* ------------------------------------------------------------------ */

    const SVG_NS = 'http://www.w3.org/2000/svg'

    function workspaceEntryGlyph() {
      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('width', '14')
      svg.setAttribute('height', '14')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.3')
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('focusable', 'false')
      const bars = [
        { x: '2.2', y: '2.4', width: '3.2', height: '11.2' },
        { x: '6.4', y: '2.4', width: '3.2', height: '7.4' },
        { x: '10.6', y: '2.4', width: '3.2', height: '9.4' },
      ]
      for (const bar of bars) {
        const rect = document.createElementNS(SVG_NS, 'rect')
        rect.setAttribute('x', bar.x)
        rect.setAttribute('y', bar.y)
        rect.setAttribute('width', bar.width)
        rect.setAttribute('height', bar.height)
        rect.setAttribute('rx', '1')
        svg.appendChild(rect)
      }
      return svg
    }

    function workspaceEntryNodeFor(t) {
      const node = document.createElement('button')
      node.type = 'button'
      node.className = 'ghp-workspace-entry'
      node.setAttribute('data-ghp-workspace-entry', '')
      node.setAttribute('data-ghp-workspace-entry-bound', '0')
      node.setAttribute('title', t('projects.openEntry'))
      node.setAttribute('aria-label', t('projects.openEntry'))
      node.appendChild(workspaceEntryGlyph())
      node.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const workspaceId = node.__ghpWorkspaceId
        if (typeof workspaceId === 'string' && workspaceId !== '') openProjectTab(workspaceId)
      })
      node.__ghpWorkspaceId = ''
      return node
    }

    function removeWorkspaceEntries() {
      for (const node of document.querySelectorAll('[data-ghp-workspace-entry]')) node.remove()
    }

    /**
     * Guarded workspace-row decorator (§4.7): one always-visible project icon
     * before the hover actions; clicking opens the right-sidebar board. Installed
     * only when sidebarRight/sidebarRightTabs are available.
     */
    function installWorkspaceEntries(ctx, t) {
      ctx.effect(() => {
        let stopped = false
        let scheduled = false
        let observer = null
        let observedTree = null

        const findTree = () => {
          const sampleRow = document.querySelector('[data-row-key^="workspace:"]')
          if (sampleRow === null) return null
          const tree = sampleRow.closest('[role="tree"]')
          if (tree !== null) return tree
          const parent = sampleRow.parentElement
          return parent === null ? null : parent.parentElement ?? parent
        }

        const ensureObserver = () => {
          if (stopped) return
          if (observedTree !== null && observedTree.isConnected) return
          if (observer === null) observer = new MutationObserver(() => schedule())
          observer.disconnect()
          observedTree = findTree()
          if (observedTree !== null) observer.observe(observedTree, { childList: true, subtree: true })
        }

        const actionSpanOf = (row) => {
          const children = [...row.children]
          for (let index = children.length - 1; index >= 0; index -= 1) {
            const child = children[index]
            if (child instanceof HTMLElement && child.tagName === 'SPAN' && child.querySelector('button') !== null) return child
          }
          return null
        }

        const sweep = () => {
          scheduled = false
          if (stopped) return
          if (sidebarRightFace === null || sidebarRightFace === undefined) {
            removeWorkspaceEntries()
            return
          }
          ensureObserver()
          const rows = document.querySelectorAll('[data-row-key^="workspace:"]')
          for (const row of rows) {
            if (!(row instanceof HTMLElement)) continue
            const rowKey = row.getAttribute('data-row-key') ?? ''
            if (!rowKey.startsWith('workspace:')) continue
            const workspaceId = rowKey.slice('workspace:'.length)
            const existing = row.querySelector(':scope > [data-ghp-workspace-entry]')
            if (workspaceId === '' || workspaceId === 'ungrouped') {
              if (existing !== null) existing.remove()
              continue
            }
            const actions = actionSpanOf(row)
            if (actions === null) continue
            let node = existing
            if (node === null) {
              node = workspaceEntryNodeFor(t)
              actions.parentElement.insertBefore(node, actions)
            }
            node.__ghpWorkspaceId = workspaceId
            const bound = workspaceBindingOf(workspaceId) === null ? '0' : '1'
            if (node.getAttribute('data-ghp-workspace-entry-bound') !== bound) {
              node.setAttribute('data-ghp-workspace-entry-bound', bound)
            }
          }
        }

        const schedule = () => {
          if (stopped || scheduled) return
          scheduled = true
          window.requestAnimationFrame(sweep)
        }

        schedule()
        const timer = window.setInterval(() => { ensureObserver(); schedule() }, 1500)
        const unsubscribe = subscribeBindingMap(schedule)
        const offEvent = onBindingChanged(schedule)
        window.addEventListener('resize', schedule)
        return () => {
          stopped = true
          if (observer !== null) observer.disconnect()
          window.clearInterval(timer)
          unsubscribe()
          offEvent()
          window.removeEventListener('resize', schedule)
          removeWorkspaceEntries()
        }
      }, 'github-projects: workspace project entries')
    }

    /**
     * Body of the keyed `sidebar.right.pane.tab` seat: the existing projects view
     * inside the right sidebar, driven by the tab's navigation params.
     */
    function SidebarProjectView(props) {
      const { t, sessionId, useTabInfo } = props
      const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null
      const tab = isPlainObject(tabInfo) && isPlainObject(tabInfo.tab) ? tabInfo.tab : null
      const navigation = tab !== null && isPlainObject(tab.navigation) ? tab.navigation : null
      const params = isPlainObject(navigation) && isPlainObject(navigation.params) ? navigation.params : {}
      const workspaceId = textOf(params.workspaceId)
      const pick = params.pick === true
      const pickToken = textOf(params.pickToken)
      const pickKey = pick ? (pickToken === '' ? 'pick' : pickToken) : ''
      const paneId = isPlainObject(tabInfo) && isPlainObject(tabInfo.panel) ? textOf(tabInfo.panel.id) : ''
      const tabActions = tab !== null && isPlainObject(tab.actions) ? tab.actions : null
      // The first render must already know about the requested picker, otherwise
      // consuming the intent before ProjectsView mounts would swallow it.
      const [viewRequest, setViewRequest] = useState(() => (pick ? { view: 'github-projects', focus: 'pick' } : null))
      const handledPickRef = useRef(pickKey)
      const consumedPickRef = useRef('')
      const completeViewRequest = useCallback(() => {}, [])

      /** Clear the one-shot `pick` intent from the tab navigation (fix A). */
      const consumePick = useCallback(() => {
        if (tabActions === null || typeof tabActions.openTab !== 'function') return false
        try {
          tabActions.openTab(PROJECT_TAB_KIND, {
            ...(paneId === '' ? {} : { paneId }),
            params: { workspaceId },
            revealIfOpened: false,
          })
          return true
        } catch (_consumeFailed) {
          return false
        }
      }, [tabActions, paneId, workspaceId])

      useEffect(() => {
        if (!pick) return
        const key = pickToken === '' ? 'pick' : pickToken
        if (handledPickRef.current !== key) {
          // A newer explicit request: capture it before clearing navigation so
          // this picker still opens even if the consume call re-renders us.
          handledPickRef.current = key
          setViewRequest({ view: 'github-projects', focus: 'pick' })
        }
        if (consumedPickRef.current !== key && consumePick()) consumedPickRef.current = key
      }, [pick, pickToken, workspaceId, consumePick])

      return h('div', { className: 'ghp-sidebar-project', 'data-ghp-sidebar-project': workspaceId === '' ? undefined : workspaceId },
        h(ProjectsView, {
          key: workspaceId,
          sessionId,
          t,
          workspaceIdOverride: workspaceId,
          openView: null,
          completeViewRequest,
          viewRequest,
          useWorkspaces: null,
          sidebar: true,
        }))
    }

    /* 8. `projects` view.                                                 */
    /* ------------------------------------------------------------------ */

    function ProjectsSkeleton() {
      return h('div', { className: 'ghp-skeleton', 'aria-hidden': true },
        h(SkeletonBlock, { className: 'ghp-sk-toolbar' }),
        h(SkeletonBlock, { className: 'ghp-sk-line' }),
        h('div', { className: 'ghp-list ghp-list-skeleton' },
          h(SkeletonBlock, { className: 'ghp-sk-row' }),
          h(SkeletonBlock, { className: 'ghp-sk-row' }),
          h(SkeletonBlock, { className: 'ghp-sk-row' }),
          h(SkeletonBlock, { className: 'ghp-sk-row' })))
    }

    function ViewModeToggle({ t, viewMode, onChange }) {
      const modes = [
        { key: 'board', action: 'view-board', label: t('projects.viewBoard'), icon: h(IconLayoutBoard, { size: 13 }) },
        { key: 'list', action: 'view-list', label: t('projects.viewList'), icon: h(IconLayoutList, { size: 13 }) },
      ]
      return h('div', { className: 'ghp-seg', role: 'group', 'aria-label': t('projects.viewModeAria') },
        modes.map((mode) => h('button', {
          key: mode.key,
          type: 'button',
          className: 'ghp-seg-btn',
          'data-ghp-action': mode.action,
          'aria-pressed': viewMode === mode.key ? 'true' : 'false',
          onClick: () => onChange(mode.key),
        },
        h('span', { className: 'ghp-seg-icon', 'aria-hidden': true }, mode.icon),
        h('span', { className: 'ghp-seg-label' }, mode.label))))
    }

    function MilestoneDropdown({ t, value, milestoneOptions, onChange }) {
      const [open, setOpen] = useState(false)
      const rootRef = useRef(null)
      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setOpen(false)
          }
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])
      const options = asArray(milestoneOptions)
      const current = options.find((option) => option.key === value) ?? options[0]
      const labelOf = (option) => (option.labelKey === undefined ? textOf(option.label) : t(option.labelKey))
      const currentLabel = current === undefined ? t('projects.milestone.all') : labelOf(current)
      return h('div', { className: 'ghp-dropdown', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'ghp-btn ghp-btn-ghost ghp-btn-sm ghp-dropdown-toggle',
          'data-ghp-action': 'milestone',
          'aria-haspopup': 'listbox',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': t('projects.milestone.filterAria'),
          title: t('projects.milestone.filterAria'),
          onClick: () => setOpen((previous) => !previous),
        },
        h('span', { className: 'ghp-btn-icon', 'aria-hidden': true }, h(IconMilestone, { size: 14 })),
        h('span', { className: 'ghp-btn-label ghp-dropdown-value' }, currentLabel),
        h('span', { className: 'ghp-dropdown-caret', 'aria-hidden': true }, h(IconChevronDown, { size: 13 }))),
        open
          ? h('div', { className: 'ghp-dropdown-menu', role: 'listbox', 'aria-label': t('projects.milestone.filterAria') },
            options.map((option) => {
              const active = option.key === value
              return h('button', {
                key: option.key,
                type: 'button',
                role: 'option',
                className: `ghp-dropdown-item${active ? ' ghp-dropdown-item-active' : ''}`,
                'aria-selected': active ? 'true' : 'false',
                'data-ghp-milestone-option': option.key,
                'data-active': active ? 'true' : undefined,
                title: option.key === 'backlog' ? t('projects.milestone.backlogHint') : undefined,
                onClick: () => {
                  setOpen(false)
                  onChange(option.key)
                },
              },
              h('span', { className: 'ghp-dropdown-label' }, labelOf(option)),
              h('span', { className: 'ghp-dropdown-count' }, String(option.count)))
            }))
          : null)
    }

    function BoardCard({ t, item, boundIssue, bindingId, onBind }) {
      const type = item.type === 'pr' || item.type === 'draft' ? item.type : 'issue'
      const repo = textOf(item.repo)
      const hasNumber = typeof item.number === 'number' && Number.isFinite(item.number)
      const fullRef = `${repo}${hasNumber ? `#${item.number}` : ''}`
      const labels = asArray(item.labels).filter((label) => typeof label === 'string' && label !== '')
      const milestone = textOf(item.milestone)
      const isBound = type === 'issue'
        && isPlainObject(boundIssue)
        && boundIssue.repo === item.repo
        && boundIssue.number === item.number
      const binding = bindingId !== null && bindingId === itemIdentity(item)
      const url = safeHref(item.url)
      const isIssue = type === 'issue' && repo !== '' && hasNumber
      const typeLabel = type === 'pr' ? t('item.pr') : (type === 'draft' ? t('item.draft') : null)
      const repoNode = repo === '' && !hasNumber
        ? null
        : h('span', { key: 'repo', className: 'ghp-board-card-repo', title: fullRef === '' ? undefined : fullRef },
          repo === '' ? null : h('span', { key: 'repo-name', className: 'ghp-board-card-repo-name' }, repo),
          hasNumber ? h('span', { key: 'repo-number', className: 'ghp-board-card-repo-number' }, `#${item.number}`) : null)
      const content = [
        h('span', { key: 'title', className: 'ghp-board-card-title' }, textOf(item.title)),
        h('span', { key: 'meta', className: 'ghp-board-card-meta' },
          h('span', {
            key: 'type-dot',
            className: `ghp-type-dot ghp-type-dot-${type}`,
            'aria-hidden': true,
          }),
          typeLabel === null ? null : h('span', { key: 'type', className: 'ghp-board-card-type' }, typeLabel),
          repoNode,
          isBound ? h('span', { key: 'bound', className: 'ghp-badge ghp-badge-bound' }, t('common.bound')) : null,
          binding ? h('span', { key: 'busy', className: 'ghp-board-card-spinner', 'aria-hidden': true }, h(Spinner, { size: 11 })) : null),
      ]
      const foot = []
      labels.slice(0, 2).forEach((label, index) => {
        foot.push(h(LabelPill, { key: `label-${index}`, name: label }))
      })
      if (labels.length > 2) {
        foot.push(h('span', { key: 'labels-more', className: 'ghp-board-card-more' }, `+${labels.length - 2}`))
      }
      if (milestone !== '') {
        foot.push(h('span', { key: 'milestone', className: 'ghp-board-card-milestone', title: milestone },
          h(IconMilestone, { size: 11 }),
          h('span', { className: 'ghp-board-card-milestone-text' }, milestone)))
      }
      if (foot.length > 0) content.push(h('span', { key: 'foot', className: 'ghp-board-card-foot' }, ...foot))

      // v0.4.0: the card body opens the GitHub page in the built-in browser;
      // binding is the explicit action below (never on body click).
      const body = url === null
        ? h('div', { className: 'ghp-board-card-body ghp-board-card-body-static' }, ...content)
        : h('button', {
          type: 'button',
          className: 'ghp-board-card-body',
          'data-ghp-card-action': 'open',
          'aria-label': t('card.openAria', { title: textOf(item.title) }),
          title: t('card.openAria', { title: textOf(item.title) }),
          onClick: () => openGithubUrl(item.url),
        }, ...content)
      const bindAction = isIssue
        ? h('div', { className: 'ghp-board-card-actions' },
          h('button', {
            type: 'button',
            className: `ghp-board-card-bind${isBound ? ' ghp-board-card-bind-active' : ''}`,
            'data-ghp-card-action': 'bind',
            'aria-pressed': isBound ? 'true' : 'false',
            disabled: binding,
            'aria-label': t('projects.bindIssueAria', { title: textOf(item.title) }),
            onClick: (event) => {
              if (event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation()
              onBind(item)
            },
          },
          binding ? h(Spinner, { size: 11 }) : null,
          isBound ? t('common.bound') : t('common.bind')))
        : null
      return h('div', {
        className: `ghp-board-card${isBound ? ' ghp-board-card-bound' : ''}${binding ? ' ghp-board-card-busy' : ''}`,
        'data-ghp-card': '',
        'aria-busy': binding ? 'true' : undefined,
        ...(isIssue ? { 'data-issue': `${repo}#${item.number}` } : {}),
      }, body, bindAction)
    }

    function BoardView({ t, columns, hiddenLanes, sessionIssue, bindingId, onBind }) {
      return h('div', {
        className: 'ghp-board',
        'data-ghp-board': '',
        'data-ghp-hidden-lanes': asArray(hiddenLanes).join(','),
      },
      columns.map((column) => h('section', {
        key: column.key,
        className: 'ghp-board-column',
        style: { '--ghp-lane-accent': laneAccentOf(column.key) },
        'data-ghp-column': column.key,
        'data-ghp-count': String(column.items.length),
        'aria-label': `${column.label} (${column.items.length})`,
      },
      h('header', { className: 'ghp-board-column-head' },
        h('span', { className: 'ghp-lane-dot', 'aria-hidden': true }),
        h('span', { className: 'ghp-board-column-title' }, column.label),
        h('span', { className: 'ghp-lane-count' }, String(column.items.length))),
        h('div', { className: 'ghp-board-column-body' },
          column.items.length === 0
            ? h('div', { className: 'ghp-board-empty' }, t('projects.board.emptyColumn'))
            : column.items.map((item) => h(BoardCard, {
              key: itemIdentity(item),
              t,
              item,
              boundIssue: sessionIssue,
              bindingId,
              onBind,
            }))))))
    }

    function ProjectToolbar({ t, project, itemCount, refreshing, updating, viewMode, onViewModeChange, milestoneValue, milestoneOptions, onMilestoneChange, onRefresh, onChange, onUnbind, unbinding }) {
      const title = textOf(project.title) || `${textOf(project.owner)} #${project.number}`
      const meta = []
      meta.push(h('span', { key: 'owner', className: 'ghp-repochip' }, `${textOf(project.owner)} / #${project.number}`))
      meta.push(h('span', { key: 'dot', className: 'ghp-dot', 'aria-hidden': true }, '·'))
      meta.push(h('span', { key: 'count', className: 'ghp-count-pill' }, isPositiveInteger(itemCount) || itemCount === 0 ? t('common.items', { count: itemCount }) : t('common.itemsUnknown')))
      if (project.closed === true) {
        meta.push(h('span', { key: 'closed', className: 'ghp-badge ghp-badge-closed' }, t('common.closed')))
      }
      return h('div', { className: 'ghp-toolbar' },
        h('div', { className: 'ghp-toolbar-main' },
          h('div', { className: 'ghp-toolbar-icon', 'aria-hidden': true }, h(IconProject, { size: 20 })),
          h('div', { className: 'ghp-toolbar-text' },
            h('div', { className: 'ghp-toolbar-title' },
              safeHref(project.url) === null
                ? title
                : h('a', { href: project.url, target: '_blank', rel: 'noreferrer noopener' }, title, h(IconExternal, { size: 13 }))),
            h('div', { className: 'ghp-toolbar-meta' }, meta),
            textOf(project.description) === ''
              ? null
              : h('div', { className: 'ghp-toolbar-desc' }, textOf(project.description)))),
        h('div', { className: 'ghp-toolbar-actions' },
          h(ViewModeToggle, { t, viewMode, onChange: onViewModeChange }),
          h(MilestoneDropdown, {
            t,
            value: milestoneValue,
            milestoneOptions,
            onChange: onMilestoneChange,
          }),
          refreshing || updating
            ? h('span', { className: 'ghp-toolbar-sync', role: 'status' },
              h(Spinner, { size: 12 }),
              updating ? t('common.updating') : t('projects.refreshing'))
            : null,
          h(Button, {
            variant: 'ghost',
            size: 'sm',
            icon: h(IconRefresh, { size: 14 }),
            onClick: onRefresh,
            disabled: refreshing,
          }, t('common.refresh')),
          h(Button, {
            variant: 'ghost',
            size: 'sm',
            icon: h(IconLink, { size: 14 }),
            onClick: onChange,
          }, t('projects.change')),
          h(ConfirmAction, {
            t,
            label: t('common.unbind'),
            confirmLabel: t('common.confirmUnbind'),
            onConfirm: onUnbind,
            busy: unbinding,
            className: 'ghp-btn ghp-btn-ghost ghp-btn-sm ghp-btn-unbind',
          })))
    }

    function ProjectsFilters({ t, query, onQueryChange, statuses, counts, statusFilter, onStatusChange, total, matched, refreshing, showStatusChips }) {
      const filtering = query.trim() !== '' || (showStatusChips && statusFilter !== ALL_STATUS)
      const chips = []
      if (showStatusChips) {
        chips.push(h('button', {
          key: ALL_STATUS,
          type: 'button',
          className: 'ghp-chip',
          'aria-pressed': statusFilter === ALL_STATUS,
          onClick: () => onStatusChange(ALL_STATUS),
        },
        h('span', null, t('common.all')),
        h('span', { className: 'ghp-chip-count' }, String(total))))
        for (const key of statuses) {
          const label = key === NO_STATUS ? t('projects.uncategorized') : key
          chips.push(h('button', {
            key,
            type: 'button',
            className: 'ghp-chip',
            'aria-pressed': statusFilter === key,
            onClick: () => onStatusChange(key),
          },
          h('span', { className: 'ghp-chip-label' }, label),
          h('span', { className: 'ghp-chip-count' }, String(counts.get(key) ?? 0))))
        }
      }
      return h('div', { className: 'ghp-filters' },
        h('div', { className: 'ghp-filters-row' },
          h(SearchInput, {
            value: query,
            onChange: onQueryChange,
            placeholder: t('projects.filterPlaceholder'),
            ariaLabel: t('projects.filterPlaceholder'),
          }),
          h('div', { className: 'ghp-filter-meta' },
            filtering
              ? h('button', {
                type: 'button',
                className: 'ghp-linkbtn',
                onClick: () => { onStatusChange(ALL_STATUS); onQueryChange('') },
              }, t('common.clearFilter'))
              : null,
            refreshing
              ? h('span', { className: 'ghp-toolbar-sync', role: 'status' }, h(Spinner, { size: 12 }), t('projects.refreshing'))
              : h('span', { className: 'ghp-filter-count' }, `${matched} / ${total}`))),
        showStatusChips
          ? h('div', { className: 'ghp-chips', role: 'group', 'aria-label': t('projects.filterPlaceholder') }, chips)
          : null)
    }

    function ProjectItemRow({ t, item, boundIssue, bindingId, onBind }) {
      const type = item.type === 'pr' || item.type === 'draft' ? item.type : 'issue'
      const repo = textOf(item.repo)
      const hasNumber = typeof item.number === 'number' && Number.isFinite(item.number)
      const repoLabel = repo === ''
        ? (hasNumber ? `#${item.number}` : (type === 'draft' ? t('item.draft') : ''))
        : (hasNumber ? `${repo}#${item.number}` : repo)
      const labels = asArray(item.labels).filter((label) => typeof label === 'string' && label !== '')
      const milestone = textOf(item.milestone)
      const isBound = type === 'issue'
        && isPlainObject(boundIssue)
        && boundIssue.repo === item.repo
        && boundIssue.number === item.number
      const binding = bindingId !== null && bindingId === itemIdentity(item)
      const url = safeHref(item.url)
      const canBind = type === 'issue' && repo !== '' && hasNumber
      const rowContent = [
        h('span', { key: 'glyph', className: `ghp-item-glyph ghp-glyph-${type}`, 'aria-hidden': true }, itemTypeIcon(type)),
        h('span', { key: 'main', className: 'ghp-item-main' },
          h('span', { className: 'ghp-item-titleline' },
            h('span', { className: 'ghp-item-title' }, textOf(item.title)),
            isBound ? h('span', { className: 'ghp-badge ghp-badge-bound' }, t('common.bound')) : null),
          h('span', { className: 'ghp-item-meta' },
            repoLabel === '' ? null : h('span', { key: 'repo', className: 'ghp-item-repo' }, repoLabel),
            labels.slice(0, 3).map((label, index) => h(LabelPill, { key: `label-${index}`, name: label })),
            labels.length > 3 ? h('span', { key: 'labels-more', className: 'ghp-muted' }, `+${labels.length - 3}`) : null,
            milestone === ''
              ? null
              : h('span', { key: 'milestone', className: 'ghp-milestone' },
                h(IconMilestone, { size: 12 }), milestone))),
      ]
      // v0.4.0: clicking the row opens the GitHub page in the built-in browser;
      // the 绑定 action stays an explicit sibling button.
      const openBody = url === null
        ? h('div', { className: 'ghp-item-open ghp-item-open-static' }, ...rowContent)
        : h('button', {
          type: 'button',
          className: 'ghp-item-open',
          'aria-label': t('card.openAria', { title: textOf(item.title) }),
          title: t('card.openAria', { title: textOf(item.title) }),
          onClick: () => openGithubUrl(item.url),
        }, ...rowContent)
      return h('div', { className: `ghp-item${isBound ? ' ghp-item-bound' : ''}` },
        openBody,
        h('span', { className: 'ghp-item-actions' },
          canBind
            ? (isBound
              ? h('span', { className: 'ghp-item-boundlabel' }, h(IconCheck, { size: 13 }), t('common.bound'))
              : h(Button, {
                variant: 'accent',
                size: 'sm',
                disabled: binding,
                onClick: (event) => {
                  if (event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation()
                  onBind(item)
                },
                'aria-label': t('projects.bindIssueAria', { title: textOf(item.title) }),
              }, binding ? h(Spinner, { size: 12 }) : null, t('common.bind')))
            : null))
    }

    function ProjectsEmpty({ t, workspace, onChoose }) {
      const title = textOf(workspace === null || workspace === undefined ? '' : workspace.title)
      const path = textOf(workspace === null || workspace === undefined ? '' : workspace.path)
      return h('div', { className: 'ghp-empty' },
        h('div', { className: 'ghp-empty-icon', 'aria-hidden': true }, h(IconProject, { size: 24 })),
        h('h2', { className: 'ghp-empty-title' }, t('projects.unboundTitle')),
        h('p', { className: 'ghp-empty-text' }, t('projects.unboundText')),
        h('div', { className: 'ghp-empty-actions' },
          h(Button, { variant: 'primary', onClick: onChoose }, t('projects.unboundAction'))),
        title === ''
          ? null
          : h('p', { className: 'ghp-empty-hint' },
            t('projects.workspaceHint', { title }),
            path === '' ? null : h('span', { className: 'ghp-empty-path' }, t('projects.workspacePath', { path }))))
    }

    function ProjectsNoWorkspace({ t }) {
      return h('div', { className: 'ghp-empty' },
        h('div', { className: 'ghp-empty-icon', 'aria-hidden': true }, h(IconProject, { size: 24 })),
        h('h2', { className: 'ghp-empty-title' }, t('projects.noWorkspaceTitle')),
        h('p', { className: 'ghp-empty-text' }, t('projects.noWorkspaceText')))
    }

    function useNoWorkspaceSource() { return null }

    function ProjectsView({
      sessionId,
      t,
      openView,
      completeViewRequest,
      viewRequest,
      useWorkspaces,
      workspaceIdOverride,
      sidebar = false,
    }) {
      const rootRef = useRef(null)
      const viewportHeight = useContainedViewport(rootRef)
      const ackedRequestRef = useRef(null)
      const mountedRef = useRef(true)
      useEffect(() => () => { mountedRef.current = false }, [])

      // A mounted instance keeps one workspace source forever (hook order stays
      // stable); the sidebar body has no workspaces service and passes an override.
      const workspaceSource = typeof useWorkspaces === 'function' ? useWorkspaces : useNoWorkspaceSource
      const workspace = workspaceSource((snapshot) => {
        if (snapshot === null || snapshot === undefined) return null
        const items = Array.isArray(snapshot.items) ? snapshot.items : (Array.isArray(snapshot) ? snapshot : [])
        return items.find((candidate) => candidate !== null
          && candidate !== undefined
          && Array.isArray(candidate.sessionIds)
          && candidate.sessionIds.includes(sessionId)) ?? null
      })
      const overrideWorkspaceId = textOf(workspaceIdOverride)
      const workspaceId = overrideWorkspaceId !== ''
        ? overrideWorkspaceId
        : (workspace === null || workspace === undefined ? null : textOf(workspace.workspaceId))
      const workspacePath = overrideWorkspaceId !== ''
        ? null
        : (workspace === null || workspace === undefined ? null : textOf(workspace.path))
      const rootClass = `ghp-root${sidebar ? ' ghp-root-sidebar' : ''}`

      // Warm mount: paint the SWR caches immediately (no skeleton); the effects
      // below only revalidate in the background.
      const bootstrapConfig = workspaceId === null || workspaceId === '' ? null : cachedResponseOf(configCacheKey(sessionId, workspaceId))
      const bootstrapConfigProject = isPlainObject(bootstrapConfig)
        && isPlainObject(bootstrapConfig.workspace) && isPlainObject(bootstrapConfig.workspace.project)
        ? bootstrapConfig.workspace.project
        : null
      const bootstrapProject = bootstrapConfigProject ?? readRememberedProject(workspaceId)
      const bootstrapItems = isPlainObject(bootstrapProject)
        && textOf(bootstrapProject.owner) !== '' && isPositiveInteger(bootstrapProject.number)
        ? cachedResponseOf(itemsCacheKey(bootstrapProject.owner, bootstrapProject.number))
        : null

      const [configState, setConfigState] = useState(() => (bootstrapConfig !== null
        ? { status: 'ready', error: null }
        : { status: 'loading', error: null }))
      const [project, setProject] = useState(() => bootstrapConfigProject)
      const [sessionIssue, setSessionIssue] = useState(() => (isPlainObject(bootstrapConfig)
        && isPlainObject(bootstrapConfig.session) && isPlainObject(bootstrapConfig.session.issue)
        ? bootstrapConfig.session.issue
        : null))
      const [gh, setGh] = useState(() => (isPlainObject(bootstrapConfig) && isPlainObject(bootstrapConfig.gh) ? bootstrapConfig.gh : null))
      useGhPendingRetry(gh, sessionId, workspaceId, setGh)
      const [configTick, setConfigTick] = useState(0)
      const [updating, setUpdating] = useState(() => bootstrapConfig !== null)

      const [itemsQuery, setItemsQuery] = useState({ n: 0, refresh: false })
      const [itemsState, setItemsState] = useState(() => (bootstrapItems !== null
        ? { status: 'ready', data: bootstrapItems, error: null }
        : { status: 'idle', data: null, error: null }))

      const [pickerOpen, setPickerOpen] = useState(false)
      const [pickerBounds, setPickerBounds] = useState(null)
      const [actionError, setActionError] = useState(null)
      const [bindingItemId, setBindingItemId] = useState(null)
      const [unbinding, setUnbinding] = useState(false)

      const [query, setQuery] = useState('')
      const [statusFilter, setStatusFilter] = useState(ALL_STATUS)
      const [viewMode, setViewMode] = useState(readStoredViewMode)
      const [milestoneFilter, setMilestoneFilter] = useState('all')
      const [milestoneNotice, setMilestoneNotice] = useState(null)
      const projectKey = isPlainObject(project) ? `${textOf(project.owner)}/${project.number ?? ''}` : ''

      useEffect(() => { storeViewMode(viewMode) }, [viewMode])

      // A different Project has a different milestone universe.
      useEffect(() => {
        setMilestoneFilter('all')
        setMilestoneNotice(null)
      }, [projectKey])

      // Bindings: cache-first paint, then background revalidation. After our own
      // bind/unbind (`configTick` > 0) the read must bypass the cache.
      useEffect(() => {
        if (workspaceId === null || workspaceId === '') {
          setConfigState({ status: 'no-workspace', error: null })
          setProject(null)
          setSessionIssue(null)
          return undefined
        }
        let cancelled = false
        const key = configCacheKey(sessionId, workspaceId)
        const cached = configTick === 0 ? cachedResponseOf(key) : null
        const applyConfig = (data) => {
          if (cancelled || !isPlainObject(data)) return
          setGh(isPlainObject(data.gh) ? data.gh : null)
          const boundProject = isPlainObject(data.workspace) && isPlainObject(data.workspace.project) ? data.workspace.project : null
          const boundIssue = isPlainObject(data.session) && isPlainObject(data.session.issue) ? data.session.issue : null
          setProject(boundProject)
          setSessionIssue(boundIssue)
          setConfigState({ status: 'ready', error: null })
          if (boundProject !== null) rememberProject(workspaceId, boundProject)
          if (boundIssue !== null) prefetchIssueDetail(boundIssue)
        }
        if (cached !== null) {
          applyConfig(cached)
          setUpdating(true)
          requestWithCache(configRequestPath(sessionId, workspaceId), key, { allowStaleRetry: false })
            .then((data) => { if (!cancelled) applyConfig(data) })
            .catch(() => { /* keep the cached binding */ })
            .finally(() => { if (!cancelled) setUpdating(false) })
        } else {
          setConfigState((previous) => (previous.status === 'ready' ? previous : { status: 'loading', error: null }))
          const read = configTick === 0
            ? requestWithCache(configRequestPath(sessionId, workspaceId), key, { allowStaleRetry: false })
            : readConfigNow(sessionId, workspaceId)
          read
            .then((data) => { if (!cancelled) applyConfig(data) })
            .catch((error) => { if (!cancelled) setConfigState({ status: 'error', error: describeError(error) }) })
        }
        return () => { cancelled = true }
      }, [workspaceId, sessionId, configTick])

      // Project items: cache-first; a remembered workspace→Project mapping lets
      // this read start in parallel with `/config`. Previous data is kept while
      // `refresh=1` re-reads (only the user's Refresh sends refresh=1).
      useEffect(() => {
        const configResolved = configState.status === 'ready' || configState.status === 'no-workspace' || configState.status === 'error'
        const candidateProject = isPlainObject(project)
          ? project
          : (configResolved ? null : readRememberedProject(workspaceId))
        if (!isPlainObject(candidateProject)) {
          setItemsState({ status: 'idle', data: null, error: null })
          return undefined
        }
        const owner = textOf(candidateProject.owner)
        const number = candidateProject.number
        if (owner === '' || !isPositiveInteger(number)) return undefined
        let cancelled = false
        const key = itemsCacheKey(owner, number)
        const basePath = itemsRequestPath(owner, number, false)
        const cached = itemsQuery.refresh ? null : cachedResponseOf(key)
        if (cached !== null) {
          setItemsState({ status: 'ready', data: cached, error: null })
          setUpdating(true)
          requestWithCache(basePath, key)
            .then((data) => { if (!cancelled) setItemsState({ status: 'ready', data, error: null }) })
            .catch(() => { /* keep the cached board */ })
            .finally(() => { if (!cancelled) setUpdating(false) })
        } else {
          setItemsState((previous) => ({
            status: previous.data === null || previous.data === undefined ? 'loading' : 'refreshing',
            data: previous.data ?? null,
            error: null,
          }))
          const path = itemsQuery.refresh ? itemsRequestPath(owner, number, true) : basePath
          requestWithCache(path, key, { retryPath: basePath })
            .then((data) => { if (!cancelled) setItemsState({ status: 'ready', data, error: null }) })
            .catch((error) => {
              if (!cancelled) setItemsState((previous) => ({ status: 'error', data: previous.data ?? null, error: describeError(error) }))
            })
        }
        return () => { cancelled = true }
      }, [configState.status, project, itemsQuery.n, workspaceId])

      const allItems = useMemo(
        () => asArray(itemsState.data === null || itemsState.data === undefined ? null : itemsState.data.items),
        [itemsState.data],
      )
      const milestoneOptions = useMemo(() => buildMilestoneOptions(allItems), [allItems])

      // A selected milestone that disappears after a refresh falls back to 全部
      // and leaves a dismissible notice instead of silently hiding everything.
      useEffect(() => {
        if (itemsState.status !== 'ready') return
        if (milestoneFilter === 'all' || milestoneFilter === 'backlog') return
        if (allItems.some((item) => milestoneKeyOf(item) === milestoneFilter)) return
        setMilestoneFilter('all')
        setMilestoneNotice(milestoneFilter)
      }, [itemsState.status, allItems, milestoneFilter])

      // Cross-view focus: an issue-view "从项目选择" lands here with focus=pick.
      useEffect(() => {
        if (viewRequest === null || viewRequest === undefined) return
        if (viewRequest.view !== 'github-projects') return
        if (ackedRequestRef.current === viewRequest) return
        ackedRequestRef.current = viewRequest
        if (textOf(viewRequest.focus) === 'pick') setPickerOpen(true)
        if (typeof completeViewRequest === 'function') completeViewRequest()
      }, [viewRequest, completeViewRequest])

      // Keep the picker scrim pinned to the View's rect (scroll / resize /
      // composer growth change that rect while the picker is open).
      useLayoutEffect(() => {
        if (!pickerOpen) {
          setPickerBounds(null)
          return undefined
        }
        const root = rootRef.current
        if (root === null || root === undefined) return undefined
        const update = () => {
          const rect = root.getBoundingClientRect()
          setPickerBounds((previous) => {
            if (previous !== null
              && Math.abs(previous.top - rect.top) < 0.5
              && Math.abs(previous.left - rect.left) < 0.5
              && Math.abs(previous.width - rect.width) < 0.5
              && Math.abs(previous.height - rect.height) < 0.5) {
              return previous
            }
            return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
          })
        }
        update()
        // The right-sidebar pane slides in/out without a window resize event, so
        // keep tracking for the first animation frames as well.
        let disposed = false
        let frames = 0
        const track = () => {
          if (disposed) return
          update()
          frames += 1
          if (frames < 45) window.requestAnimationFrame(track)
        }
        window.requestAnimationFrame(track)
        window.addEventListener('resize', update)
        root.addEventListener('scroll', update, { passive: true })
        let observer = null
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(update)
          observer.observe(root)
        }
        return () => {
          disposed = true
          window.removeEventListener('resize', update)
          root.removeEventListener('scroll', update)
          if (observer !== null) observer.disconnect()
        }
      }, [pickerOpen])

      const reloadConfig = useCallback(() => {
        setConfigTick((value) => value + 1)
      }, [])

      const refreshItems = useCallback(() => {
        setItemsQuery((current) => ({ n: current.n + 1, refresh: true }))
      }, [])

      const bindProject = useCallback(async (nextProject, options = {}) => {
        if (workspaceId === null || workspaceId === '') {
          throw new GhpError('bad-request', 'missing workspace')
        }
        if (!isPlainObject(nextProject) || textOf(nextProject.owner) === '' || !isPositiveInteger(nextProject.number)) {
          throw new GhpError('bad-request', 'invalid project')
        }
        const payload = { sessionId, workspaceId, workspacePath, project: nextProject }
        await apiPost('/bind-workspace', payload)
        // Manual bindings only know owner+number; resolve the real summary
        // through the items read and store it when it matches exactly.
        if (options.manual === true) {
          try {
            const data = await apiGet(`/items${queryString({
              owner: textOf(nextProject.owner),
              number: nextProject.number,
              refresh: 1,
            })}`)
            const authoritative = isPlainObject(data.project) ? data.project : null
            if (authoritative !== null
              && authoritative.owner === nextProject.owner
              && authoritative.number === nextProject.number) {
              await apiPost('/bind-workspace', { ...payload, project: authoritative })
            }
          } catch (_resolutionFailed) {
            // The manual summary is still a usable binding; the list view
            // surfaces any read problem on its own.
          }
        }
        setWorkspaceProjectBinding(workspaceId, nextProject)
        rememberProject(workspaceId, nextProject)
        setPickerOpen(false)
        setItemsQuery((current) => ({ n: current.n + 1, refresh: false }))
        if (mountedRef.current) reloadConfig()
        dispatchBindingChanged()
      }, [sessionId, workspaceId, workspacePath, reloadConfig])

      const unbindProject = useCallback(async () => {
        if (workspaceId === null || workspaceId === '') return
        setUnbinding(true)
        setActionError(null)
        try {
          await apiPost('/unbind-workspace', { sessionId, workspaceId })
          if (!mountedRef.current) return
          setProject(null)
          setSessionIssue(null)
          setSessionIssueBinding(sessionId, null)
          setWorkspaceProjectBinding(workspaceId, null)
          setItemsState({ status: 'idle', data: null, error: null })
          reloadConfig()
          dispatchBindingChanged()
        } catch (error) {
          if (mountedRef.current) setActionError(describeError(error))
        } finally {
          if (mountedRef.current) setUnbinding(false)
        }
      }, [sessionId, workspaceId, reloadConfig])

      const bindIssue = useCallback(async (item) => {
        if (!isPlainObject(item) || textOf(item.repo) === '' || !isPositiveInteger(item.number)) return
        const identity = itemIdentity(item)
        setBindingItemId(identity)
        setActionError(null)
        try {
          const issue = {
            repo: item.repo,
            number: item.number,
            title: textOf(item.title),
            url: textOf(item.url),
            state: 'open',
          }
          await apiPost('/bind-issue', { sessionId, workspaceId, issue })
          await readConfigNow(sessionId, workspaceId).catch(() => { /* config stays cached */ })
          prefetchIssueDetail(issue)
          if (!mountedRef.current) return
          setSessionIssue(issue)
          setSessionIssueBinding(sessionId, issue)
          dispatchBindingChanged()
          if (typeof openView === 'function') openView('github-issue', 'bound')
        } catch (error) {
          if (mountedRef.current) setActionError(describeError(error))
        } finally {
          if (mountedRef.current) setBindingItemId(null)
        }
      }, [sessionId, workspaceId, openView])

      const rootStyle = viewportHeight === null ? undefined : { height: `${viewportHeight}px` }

      const renderPage = (children, center = false, extraClass = '') => h('div', {
        className: `ghp-page${center ? ' ghp-page-center' : ''}${extraClass === '' ? '' : ` ${extraClass}`}`,
      }, children)

      if (configState.status === 'no-workspace') {
        return h('div', { className: rootClass, ref: rootRef, style: rootStyle, 'data-ghp-view-mode': viewMode },
          renderPage(ProjectsNoWorkspace({ t }), true))
      }
      if (configState.status === 'loading') {
        return h('div', { className: rootClass, ref: rootRef, style: rootStyle, 'data-ghp-view-mode': viewMode },
          renderPage(h(ProjectsSkeleton)))
      }
      if (configState.status === 'error') {
        return h('div', { className: rootClass, ref: rootRef, style: rootStyle, 'data-ghp-view-mode': viewMode },
          renderPage(h('div', { className: 'ghp-empty' },
            h(ErrorCard, {
              t,
              error: configState.error,
              title: t('error.configHint'),
              onRetry: reloadConfig,
            })), true))
      }

      if (!isPlainObject(project)) {
        return h('div', { className: rootClass, ref: rootRef, style: rootStyle, 'data-ghp-view-mode': viewMode },
          renderPage(ProjectsEmpty({ t, workspace, onChoose: () => setPickerOpen(true) }), true),
          pickerOpen
            ? h(ProjectPicker, {
              t,
              onClose: () => setPickerOpen(false),
              onSelect: bindProject,
              currentProject: project,
              bounds: pickerBounds,
            })
            : null)
      }

      const milestoneScopedItems = filterByMilestone(allItems, milestoneFilter)
      const statuses = collectStatuses(milestoneScopedItems)
      const counts = statusCountsOf(milestoneScopedItems)
      const isBoardMode = viewMode === 'board'
      const effectiveStatusFilter = statusFilter === ALL_STATUS || statuses.includes(statusFilter)
        ? statusFilter
        : ALL_STATUS
      const listFilteredItems = filterItems(milestoneScopedItems, query, effectiveStatusFilter)
      const groups = groupItems(listFilteredItems, statuses)
      const boardFilteredItems = filterItems(milestoneScopedItems, query, ALL_STATUS)
      const boardLayout = buildBoardColumns(allItems, boardFilteredItems)
      const boardColumns = boardLayout.columns
      const hiddenLanes = boardLayout.hiddenLanes
      const matchedCount = isBoardMode ? boardFilteredItems.length : listFilteredItems.length
      const refreshing = itemsState.status === 'refreshing'
      const itemsProject = isPlainObject(itemsState.data) && isPlainObject(itemsState.data.project) ? itemsState.data.project : null
      const shownProject = itemsProject !== null
        && itemsProject.owner === project.owner
        && itemsProject.number === project.number
        ? { ...project, ...itemsProject }
        : project
      const itemCount = isPositiveInteger(shownProject.itemCount)
        ? shownProject.itemCount
        : (itemsState.status === 'ready' ? allItems.length : null)

      const truncatedNotice = itemsState.data !== null && itemsState.data !== undefined && itemsState.data.truncated === true
        ? h('div', { key: 'truncated', className: 'ghp-notice' },
          h('span', { className: 'ghp-notice-icon', 'aria-hidden': true }, h(IconAlert, { size: 14 })),
          t('projects.truncated', {
            shown: allItems.length,
            total: isPositiveInteger(shownProject.itemCount) ? shownProject.itemCount : allItems.length,
          }))
        : null

      let body
      if (itemsState.status === 'loading') {
        body = h(ProjectsSkeleton)
      } else if (itemsState.status === 'error') {
        body = h('div', { className: 'ghp-section' },
          h(ErrorCard, {
            t,
            title: t('projects.loadFailed'),
            error: itemsState.error,
            onRetry: refreshItems,
          }))
      } else if (allItems.length === 0) {
        body = h('div', { className: 'ghp-empty ghp-empty-inline' },
          h('div', { className: 'ghp-empty-icon', 'aria-hidden': true }, h(IconProject, { size: 24 })),
          h('h3', { className: 'ghp-empty-title-sm' }, t('projects.emptyItemsTitle')),
          h('p', { className: 'ghp-empty-text' }, t('projects.emptyItemsText')),
          h('div', { className: 'ghp-empty-actions' },
            h(Button, { variant: 'secondary', size: 'sm', onClick: refreshItems }, t('common.refresh'))))
      } else if (isBoardMode) {
        body = h(BoardView, {
          t,
          columns: boardColumns,
          hiddenLanes,
          sessionIssue,
          bindingId: typeof bindingItemId === 'string' ? bindingItemId : null,
          onBind: bindIssue,
        })
      } else {
        const sections = groups.map((group) => {
          const sectionLabel = group.key === NO_STATUS ? t('projects.uncategorized') : group.key
          return h('section', {
            key: group.key,
            className: 'ghp-section',
            style: { '--ghp-lane-accent': sectionAccentOf(group.key) },
            'aria-label': `${sectionLabel} (${group.items.length})`,
          },
          h('div', { className: 'ghp-section-head' },
            h('span', { className: 'ghp-lane-dot', 'aria-hidden': true }),
            h('h3', { className: 'ghp-section-title' }, sectionLabel),
            h('span', { className: 'ghp-lane-count' }, String(group.items.length))),
          h('div', { className: 'ghp-list' },
            group.items.map((item) => h(ProjectItemRow, {
              key: itemIdentity(item),
              t,
              item,
              boundIssue: sessionIssue,
              bindingId: typeof bindingItemId === 'string' ? bindingItemId : null,
              onBind: bindIssue,
            }))))
        })
        body = h('div', { className: 'ghp-sections', 'data-ghp-list': '' },
          sections.length > 0
            ? sections
            : h('div', { className: 'ghp-empty ghp-empty-inline' },
              h('h3', { className: 'ghp-empty-title-sm' }, t('projects.filterEmpty')),
              h('div', { className: 'ghp-empty-actions' },
                h(Button, {
                  variant: 'secondary',
                  size: 'sm',
                  onClick: () => { setStatusFilter(ALL_STATUS); setQuery('') },
                }, t('common.clearFilter')))))
      }

      const milestoneNoticeNode = milestoneNotice === null
        ? null
        : h('div', { key: 'milestone-notice', className: 'ghp-notice ghp-notice-warn', role: 'status' },
          h('span', { className: 'ghp-notice-icon', 'aria-hidden': true }, h(IconAlert, { size: 14 })),
          h('span', { className: 'ghp-notice-text' }, t('projects.milestone.missing', { title: milestoneNotice })),
          h('button', {
            type: 'button',
            className: 'ghp-iconbtn',
            onClick: () => setMilestoneNotice(null),
            'aria-label': t('common.close'),
            title: t('common.close'),
          }, h(IconClose, { size: 13 })))

      return h('div', { className: 'ghp-root', ref: rootRef, style: rootStyle, 'data-ghp-view-mode': viewMode },
        renderPage([
          h(GHWarning, { key: 'gh', t, gh }),
          h(ActionBanner, {
            key: 'action-error',
            t,
            title: t('projects.issueBindFailed'),
            error: actionError,
            onDismiss: () => setActionError(null),
          }),
          h(ProjectToolbar, {
            key: 'toolbar',
            t,
            project: shownProject,
            itemCount,
            refreshing,
            updating,
            viewMode,
            onViewModeChange: setViewMode,
            milestoneValue: milestoneFilter,
            milestoneOptions,
            onMilestoneChange: setMilestoneFilter,
            onRefresh: refreshItems,
            onChange: () => setPickerOpen(true),
            onUnbind: unbindProject,
            unbinding,
          }),
          allItems.length === 0 || itemsState.status === 'loading' || itemsState.status === 'error'
            ? null
            : h(ProjectsFilters, {
              key: 'filters',
              t,
              query,
              onQueryChange: setQuery,
              statuses,
              counts,
              statusFilter: effectiveStatusFilter,
              onStatusChange: setStatusFilter,
              total: milestoneScopedItems.length,
              matched: matchedCount,
              refreshing,
              showStatusChips: !isBoardMode,
            }),
          milestoneNoticeNode,
          isBoardMode ? truncatedNotice : null,
          h('div', { key: 'body', className: `ghp-body${isBoardMode ? ' ghp-body-board' : ''}` }, body),
          isBoardMode ? null : truncatedNotice,
        ], false, isBoardMode ? 'ghp-page-board' : ''),
        pickerOpen
          ? h(ProjectPicker, {
            t,
            onClose: () => setPickerOpen(false),
            onSelect: bindProject,
            currentProject: project,
            bounds: pickerBounds,
          })
          : null)
    }

    /* ------------------------------------------------------------------ */
    /* 9. `issue` view.                                                    */
    /* ------------------------------------------------------------------ */

    const EMPTY_COMMENTS = []

    function IssueSkeleton() {
      return h('div', { className: 'ghp-skeleton', 'aria-hidden': true },
        h(SkeletonBlock, { className: 'ghp-sk-toolbar' }),
        h(SkeletonBlock, { className: 'ghp-sk-code' }),
        h(SkeletonBlock, { className: 'ghp-sk-line' }),
        h(SkeletonBlock, { className: 'ghp-sk-line' }),
        h(SkeletonBlock, { className: 'ghp-sk-row' }))
    }

    function MarkdownCard({ title, children }) {
      const parts = Array.isArray(children) ? children : [children]
      return h('article', { className: 'ghp-card' },
        title === null || title === undefined ? null : h('h3', { className: 'ghp-card-title' }, title),
        ...parts)
    }

    function IssueComments({ t, comments, commentCount, truncated }) {
      const truncatedCount = Math.max(0, commentCount - comments.length)
      return h('section', { className: 'ghp-comments' },
        h('div', { className: 'ghp-comments-head' },
          h('h3', { className: 'ghp-card-title' }, t('issue.comments', { count: commentCount }))),
        comments.length === 0 ? h('div', { className: 'ghp-muted ghp-comments-empty' }, t('issue.noComments')) : null,
        comments.map((comment) => h('article', { key: textOf(comment.id) || `${comment.author}-${comment.createdAt}`, className: 'ghp-comment' },
          h('header', { className: 'ghp-comment-head' },
            h('span', {
              className: 'ghp-comment-avatar',
              style: { '--ghp-avatar-color': hashColorOf(textOf(comment.author) || t('issue.ghost')) },
              'aria-hidden': true,
            }, initialsOf(textOf(comment.author) || t('issue.ghost'))),
            h('span', { className: 'ghp-comment-author' }, textOf(comment.author) || t('issue.ghost')),
            h('span', { className: 'ghp-dot', 'aria-hidden': true }, '·'),
            h('time', { className: 'ghp-comment-time', dateTime: textOf(comment.createdAt) }, relativeTime(t, comment.createdAt)),
            safeHref(comment.url) === null
              ? null
              : h('a', {
                className: 'ghp-iconbtn ghp-comment-link',
                href: comment.url,
                target: '_blank',
                rel: 'noreferrer noopener',
                'aria-label': t('common.openGithub'),
                title: t('common.openGithub'),
              }, h(IconExternal, { size: 13 }))),
          h(Markdown, { text: textOf(comment.body) }))),
        truncatedCount > 0
          ? h('div', { className: 'ghp-notice' },
            h('span', { className: 'ghp-notice-icon', 'aria-hidden': true }, h(IconComment, { size: 14 })),
            t('issue.commentsTruncated', { count: truncatedCount }))
          : null)
    }

    function IssueEmpty({ t, gh, input, onInputChange, onSubmit, busy, error, onChoose, workspaceId }) {
      const canChoose = workspaceId !== null && workspaceId !== ''
      return h('div', { className: 'ghp-empty' },
        h('div', { className: 'ghp-empty-icon', 'aria-hidden': true }, h(IconIssue, { size: 24 })),
        h('h2', { className: 'ghp-empty-title' }, t('issue.unboundTitle')),
        h('p', { className: 'ghp-empty-text' }, t('issue.unboundText')),
        h('div', { className: 'ghp-empty-actions' },
          h(Button, { variant: 'primary', onClick: onChoose, disabled: !canChoose }, t('issue.unboundAction'))),
        h('form', { className: 'ghp-bindrow', onSubmit },
          h('input', {
            className: 'ghp-input',
            type: 'text',
            value: input,
            placeholder: t('issue.refPlaceholder'),
            'aria-label': t('issue.refAria'),
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event) => onInputChange(event.target.value),
          }),
          h(Button, { variant: 'secondary', type: 'submit', disabled: busy },
            busy ? h(Spinner, { size: 12 }) : null,
            t('common.bind'))),
        error === null ? null : h('div', { className: 'ghp-inline-error', role: 'alert' }, hintForError(t, error) ?? errorMessageOf(error)),
        h('p', { className: 'ghp-empty-hint' }, t('issue.unboundHint')),
        h(GHWarning, { t, gh }))
    }

    function IssueView({ sessionId, t, openView, completeViewRequest, viewRequest, useWorkspaces }) {
      const rootRef = useRef(null)
      const viewportHeight = useContainedViewport(rootRef)
      const ackedRequestRef = useRef(null)
      const mountedRef = useRef(true)
      useEffect(() => () => { mountedRef.current = false }, [])

      const workspace = useWorkspaces((snapshot) => {
        if (snapshot === null || snapshot === undefined) return null
        const items = Array.isArray(snapshot.items) ? snapshot.items : (Array.isArray(snapshot) ? snapshot : [])
        return items.find((candidate) => candidate !== null
          && candidate !== undefined
          && Array.isArray(candidate.sessionIds)
          && candidate.sessionIds.includes(sessionId)) ?? null
      })
      const workspaceId = workspace === null || workspace === undefined ? null : textOf(workspace.workspaceId)

      // Warm mount: paint cached bindings + issue detail immediately.
      const bootstrapConfig = cachedResponseOf(configCacheKey(sessionId, workspaceId))
      const bootstrapSummary = isPlainObject(bootstrapConfig)
        && isPlainObject(bootstrapConfig.session) && isPlainObject(bootstrapConfig.session.issue)
        ? bootstrapConfig.session.issue
        : null
      const bootstrapDetail = isPlainObject(bootstrapSummary)
        && textOf(bootstrapSummary.repo) !== '' && isPositiveInteger(bootstrapSummary.number)
        ? cachedResponseOf(issueCacheKey(textOf(bootstrapSummary.repo), bootstrapSummary.number))
        : null
      const bootstrapIssue = isPlainObject(bootstrapDetail) && isPlainObject(bootstrapDetail.issue)
        ? bootstrapDetail.issue
        : null

      const [configState, setConfigState] = useState(() => (bootstrapConfig !== null
        ? { status: 'ready', error: null }
        : { status: 'loading', error: null }))
      const [summary, setSummary] = useState(() => bootstrapSummary)
      const [gh, setGh] = useState(() => (isPlainObject(bootstrapConfig) && isPlainObject(bootstrapConfig.gh) ? bootstrapConfig.gh : null))
      useGhPendingRetry(gh, sessionId, workspaceId, setGh)
      const [configTick, setConfigTick] = useState(0)
      const [updating, setUpdating] = useState(() => bootstrapConfig !== null)

      const [detailQuery, setDetailQuery] = useState({ n: 0, refresh: false })
      const [detailState, setDetailState] = useState(() => (bootstrapIssue !== null
        ? { status: 'ready', data: bootstrapIssue, error: null }
        : { status: 'idle', data: null, error: null }))

      const [refInput, setRefInput] = useState('')
      const [bindState, setBindState] = useState({ busy: false, error: null })
      const [unbinding, setUnbinding] = useState(false)
      const [actionError, setActionError] = useState(null)
      const [refreshingFlag, setRefreshingFlag] = useState(false)

      // Bindings: cache-first paint then background revalidation. The poll and
      // the binding-changed event pick up agent-tool / cross-view changes within
      // ~4 s without a manual refresh (§3.4/§4.5).
      useEffect(() => {
        let cancelled = false
        const key = configCacheKey(sessionId, workspaceId)
        const cached = configTick === 0 ? cachedResponseOf(key) : null
        const applyConfig = (data) => {
          if (cancelled || !isPlainObject(data)) return
          setGh(isPlainObject(data.gh) ? data.gh : null)
          const session = isPlainObject(data.session) ? data.session : null
          const bound = session !== null && isPlainObject(session.issue) ? session.issue : null
          setSummary(bound)
          setConfigState({ status: 'ready', error: null })
          if (bound !== null) prefetchIssueDetail(bound)
        }
        if (cached !== null) {
          applyConfig(cached)
          setUpdating(true)
          requestWithCache(configRequestPath(sessionId, workspaceId), key, { allowStaleRetry: false })
            .then((data) => { if (!cancelled) applyConfig(data) })
            .catch(() => { /* keep cached binding */ })
            .finally(() => { if (!cancelled) setUpdating(false) })
        } else {
          setConfigState((previous) => (previous.status === 'ready' ? previous : { status: 'loading', error: null }))
          const read = configTick === 0
            ? requestWithCache(configRequestPath(sessionId, workspaceId), key, { allowStaleRetry: false })
            : readConfigNow(sessionId, workspaceId)
          read
            .then((data) => { if (!cancelled) applyConfig(data) })
            .catch((error) => { if (!cancelled) setConfigState({ status: 'error', error: describeError(error) }) })
        }
        return () => { cancelled = true }
      }, [sessionId, workspaceId, configTick])

      // Binding changes (our own writes, other tabs, agent tools) arrive through
      // the shared /bindings map; this view needs no second /config poll.
      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        const sync = () => {
          if (!mountedRef.current) return
          const next = issueBindingOf(sessionId)
          setSummary((previous) => (sameIssueSummary(previous, next) ? previous : next))
        }
        sync()
        return subscribeBindingMap(sync)
      }, [sessionId])

      const summaryRepo = summary === null || summary === undefined ? '' : textOf(summary.repo)
      const summaryNumber = summary === null || summary === undefined ? null : summary.number

      useEffect(() => {
        if (!isPositiveInteger(summaryNumber) || summaryRepo === '') {
          setDetailState({ status: 'idle', data: null, error: null })
          return undefined
        }
        let cancelled = false
        const key = issueCacheKey(summaryRepo, summaryNumber)
        const basePath = issueRequestPath(summaryRepo, summaryNumber, false)
        const cached = detailQuery.refresh ? null : cachedResponseOf(key)
        const cachedIssue = isPlainObject(cached) && isPlainObject(cached.issue) ? cached.issue : null
        const pullIssue = (data) => (isPlainObject(data) && isPlainObject(data.issue) ? data.issue : null)
        if (cachedIssue !== null) {
          setDetailState({ status: 'ready', data: cachedIssue, error: null })
          setUpdating(true)
          requestWithCache(basePath, key)
            .then((data) => { if (!cancelled) setDetailState({ status: 'ready', data: pullIssue(data), error: null }) })
            .catch(() => { /* keep the cached detail */ })
            .finally(() => { if (!cancelled) setUpdating(false) })
        } else {
          setDetailState((previous) => ({
            status: previous.data === null || previous.data === undefined ? 'loading' : 'refreshing',
            data: previous.data ?? null,
            error: null,
          }))
          const path = detailQuery.refresh ? issueRequestPath(summaryRepo, summaryNumber, true) : basePath
          requestWithCache(path, key, { retryPath: basePath })
            .then((data) => {
              if (cancelled) return
              setDetailState({ status: 'ready', data: pullIssue(data), error: null })
            })
            .catch((error) => {
              if (cancelled) return
              setDetailState((previous) => ({ status: 'error', data: previous.data ?? null, error: describeError(error) }))
            })
        }
        return () => { cancelled = true }
      }, [summaryRepo, summaryNumber, detailQuery.n])

      useEffect(() => {
        if (viewRequest === null || viewRequest === undefined) return
        if (viewRequest.view !== 'github-issue') return
        if (ackedRequestRef.current === viewRequest) return
        ackedRequestRef.current = viewRequest
        // The focus is opaque: re-read the binding from the server, then
        // refresh the detail so a just-bound Issue renders immediately.
        setConfigTick((value) => value + 1)
        setDetailQuery((current) => ({ n: current.n + 1, refresh: false }))
        if (typeof completeViewRequest === 'function') completeViewRequest()
      }, [viewRequest, completeViewRequest])

      const reloadConfig = useCallback(() => {
        setConfigTick((value) => value + 1)
      }, [])

      const reloadDetail = useCallback((refresh = true) => {
        if (refresh) setRefreshingFlag(true)
        setDetailQuery((current) => ({ n: current.n + 1, refresh }))
      }, [])

      useEffect(() => {
        if (detailState.status !== 'refreshing' && detailState.status !== 'loading' && detailState.status !== 'ready') return
        setRefreshingFlag(false)
      }, [detailState.status])

      const unbindIssue = useCallback(async () => {
        setUnbinding(true)
        setActionError(null)
        try {
          await apiPost('/unbind-issue', { sessionId })
          if (!mountedRef.current) return
          setSummary(null)
          setDetailState({ status: 'idle', data: null, error: null })
          setSessionIssueBinding(sessionId, null)
          reloadConfig()
          dispatchBindingChanged()
        } catch (error) {
          if (mountedRef.current) setActionError(describeError(error))
        } finally {
          if (mountedRef.current) setUnbinding(false)
        }
      }, [sessionId, reloadConfig])

      const submitRef = useCallback(async (event) => {
        if (event !== null && event !== undefined) event.preventDefault()
        const value = refInput.trim()
        if (value === '') {
          setBindState({ busy: false, error: new GhpError('invalid-ref', t('issue.invalidRef')) })
          return
        }
        setBindState({ busy: true, error: null })
        try {
          const result = await apiPost('/bind-issue', {
            sessionId,
            workspaceId: workspaceId === null || workspaceId === '' ? undefined : workspaceId,
            ref: value,
          })
          if (!mountedRef.current) return
          const bound = isPlainObject(result.session) && isPlainObject(result.session.issue) ? result.session.issue : null
          setSummary(bound)
          setRefInput('')
          setBindState({ busy: false, error: null })
          if (bound !== null) setSessionIssueBinding(sessionId, bound)
          setDetailQuery((current) => ({ n: current.n + 1, refresh: false }))
          setConfigTick((value2) => value2 + 1)
          dispatchBindingChanged()
        } catch (error) {
          if (mountedRef.current) setBindState({ busy: false, error: describeError(error) })
        }
      }, [refInput, sessionId, workspaceId, t])

      const rootStyle = viewportHeight === null ? undefined : { height: `${viewportHeight}px` }
      const renderPage = (children, center = false) => h('div', { className: `ghp-page${center ? ' ghp-page-center' : ''}` }, children)

      if (configState.status === 'loading') {
        return h('div', { className: 'ghp-root', ref: rootRef, style: rootStyle },
          renderPage(h(IssueSkeleton)))
      }
      if (configState.status === 'error') {
        return h('div', { className: 'ghp-root', ref: rootRef, style: rootStyle },
          renderPage(h('div', { className: 'ghp-empty' },
            h(ErrorCard, {
              t,
              error: configState.error,
              title: t('error.configHint'),
              onRetry: reloadConfig,
            })), true))
      }

      if (!isPlainObject(summary)) {
        return h('div', { className: 'ghp-root', ref: rootRef, style: rootStyle },
          renderPage(h(IssueEmpty, {
            t,
            gh,
            input: refInput,
            onInputChange: setRefInput,
            onSubmit: submitRef,
            busy: bindState.busy,
            error: bindState.error,
            onChoose: () => openProjectTab(workspaceId, { pick: true }),
            workspaceId,
          }), true))
      }

      const detail = isPlainObject(detailState.data) ? detailState.data : null
      const comments = detail === null ? EMPTY_COMMENTS : asArray(detail.comments)
      const commentCount = detail !== null && Number.isFinite(Number(detail.commentCount))
        ? Number(detail.commentCount)
        : comments.length
      const title = detail !== null ? textOf(detail.title) || textOf(summary.title) : textOf(summary.title)
      const url = detail !== null && safeHref(detail.url) !== null ? detail.url : summary.url
      const state = detail !== null ? detail.state : summary.state
      const detailBusy = detailState.status === 'loading' || detailState.status === 'refreshing' || refreshingFlag
      const labels = detail !== null ? asArray(detail.labels).filter((label) => typeof label === 'string' && label !== '') : []
      const assignees = detail !== null ? asArray(detail.assignees).filter((name) => typeof name === 'string' && name !== '') : []
      const bodyText = detail !== null ? textOf(detail.body) : ''
      const showBody = detail !== null
      const author = detail !== null ? textOf(detail.author) : ''
      const createdAt = detail !== null ? textOf(detail.createdAt) : ''
      const updatedAt = detail !== null ? textOf(detail.updatedAt) : ''
      const metaNodes = []
      if (detail !== null) {
        metaNodes.push(h('span', { key: 'opened' }, t('issue.openedBy', {
          author: author === '' ? t('issue.ghost') : author,
          date: formatDate(createdAt) || '—',
        })))
        metaNodes.push(h('span', { key: 'dot-1', className: 'ghp-dot', 'aria-hidden': true }, '·'))
        metaNodes.push(h('span', { key: 'comments' }, t('issue.commentCount', { count: commentCount })))
        if (updatedAt !== '') {
          metaNodes.push(h('span', { key: 'dot-2', className: 'ghp-dot', 'aria-hidden': true }, '·'))
          metaNodes.push(h('span', { key: 'updated' }, t('issue.updated', { time: relativeTime(t, updatedAt) })))
        }
        if (assignees.length > 0) {
          metaNodes.push(h('span', { key: 'dot-3', className: 'ghp-dot', 'aria-hidden': true }, '·'))
          metaNodes.push(h('span', { key: 'assignees' }, t('issue.assignees', { names: assignees.join(', ') })))
        }
      }

      const header = h('header', { className: 'ghp-issue-head' },
        h('div', { className: 'ghp-issue-topline' },
          h('span', { className: 'ghp-repochip' }, textOf(summary.repo)),
          h('span', { className: 'ghp-issuenum' }, `#${summary.number}`),
          h(StateBadge, { state, t }),
          h('div', { className: 'ghp-issue-actions' },
            h(Button, {
              variant: 'ghost',
              size: 'sm',
              icon: detailBusy ? h(Spinner, { size: 13 }) : h(IconRefresh, { size: 14 }),
              onClick: () => reloadDetail(true),
              disabled: detailBusy,
            }, t('common.refresh')),
            h(ConfirmAction, {
              t,
              label: t('common.unbind'),
              confirmLabel: t('common.confirmUnbind'),
              onConfirm: unbindIssue,
              busy: unbinding,
              className: 'ghp-btn ghp-btn-ghost ghp-btn-sm ghp-btn-unbind',
            }),
            h(Button, {
              variant: 'ghost',
              size: 'sm',
              icon: h(IconExternal, { size: 14 }),
              onClick: () => openGithubUrl(url),
              'aria-label': t('common.openGithub'),
              title: t('common.openGithub'),
            }, t('common.openGithub')))),
        h('h2', { className: 'ghp-issue-title' }, title),
        metaNodes.length === 0
          ? null
          : h('div', { className: 'ghp-issue-meta' }, metaNodes),
        labels.length === 0
          ? null
          : h('div', { className: 'ghp-issue-labels' }, labels.map((label, index) => h(LabelPill, { key: `label-${index}`, name: label }))))

      return h('div', { className: 'ghp-root', ref: rootRef, style: rootStyle },
        renderPage([
          h(GHWarning, { key: 'gh', t, gh }),
          h(ActionBanner, {
            key: 'action-error',
            t,
            title: t('common.unbindFailed'),
            error: actionError,
            onDismiss: () => setActionError(null),
          }),
          header,
          detailState.status === 'error'
            ? h(ErrorCard, {
              key: 'detail-error',
              t,
              title: t('issue.loadFailed'),
              error: detailState.error,
              onRetry: () => reloadDetail(true),
            })
            : null,
          !showBody && detailState.status !== 'error'
            ? h('div', { key: 'body-skeleton', className: 'ghp-card' },
              h(SkeletonBlock, { className: 'ghp-sk-line' }),
              h(SkeletonBlock, { className: 'ghp-sk-line ghp-sk-line-wide' }))
            : h(MarkdownCard, { key: 'body' },
              bodyText.trim() === ''
                ? h('div', { key: 'body-empty', className: 'ghp-muted' }, t('issue.noBody'))
                : h(Markdown, { key: 'body-md', text: bodyText }),
              detail.bodyTruncated === true
                ? h('div', { key: 'body-truncated', className: 'ghp-notice' },
                  h('span', { className: 'ghp-notice-icon', 'aria-hidden': true }, h(IconAlert, { size: 14 })),
                  t('issue.bodyTruncated'))
                : null),
          showBody
            ? h(IssueComments, {
              key: 'comments',
              t,
              comments,
              commentCount,
              truncated: detail.commentsTruncated === true,
            })
            : null,
        ]))
    }

    /* ------------------------------------------------------------------ */
    /* 10. Stylesheet — one <style data-plugin="github-projects"> tag.     */
    /* ------------------------------------------------------------------ */

    const CSS = `/* ==========================================================================
   v0.3.0 visual system (contract §4.2.0).
   Color = state, not decoration: only status lanes/sections, type glyphs,
   bound/active accents, actions and error/success states are colored. Titles,
   meta, labels and body text use neutral label tokens. Accents are
   theme-independent; every tint is derived with color-mix from the active
   DSH theme tokens, so light and dark both resolve correctly.
   ========================================================================== */
.ghp-root, .ghp-overlay, .ghp-session-subtitle, .ghp-sidebar-subtitle, .ghp-workspace-entry {
  --ghp-accent-no-status: var(--dsw-alias-label-tertiary, #8a8a8a);
  --ghp-accent-todo: var(--dsw-static-blue-500, #3b82f6);
  --ghp-accent-in-progress: var(--dsw-static-amber-500, #f59e0b);
  --ghp-accent-in-review: #8b5cf6;
  --ghp-accent-done: var(--dsw-alias-state-success-primary, #3fb950);
  --ghp-accent-other: #06b6d4;
  --ghp-accent-issue: var(--dsw-alias-state-success-primary, #3fb950);
  --ghp-accent-pr: #8b5cf6;
  --ghp-accent-draft: var(--dsw-alias-label-tertiary, #8a8a8a);
  --ghp-accent-brand: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary, #4f7cff));
  --ghp-accent-error: var(--dsw-alias-state-error-primary, #f85149);
  --ghp-accent-success: var(--dsw-alias-state-success-primary, #3fb950);
  --ghp-accent-warn: var(--dsw-alias-state-warn-primary, #d97706);
  --ghp-surface-sunken: var(--dsw-alias-bg-layer-1, #1a1a1a);
  --ghp-surface-raised: var(--dsw-alias-bg-layer-2, #222);
  --ghp-surface-hover: var(--dsw-alias-bg-layer-3, #2a2a2a);
  --ghp-border: var(--dsw-alias-border-l1, #333);
  --ghp-border-strong: var(--dsw-alias-border-l2, #3a3a3a);
  --ghp-border-hover: var(--dsw-alias-border-l3, #4a4a4a);
  --ghp-text-primary: var(--dsw-alias-label-primary, #e6e6e6);
  --ghp-text-secondary: var(--dsw-alias-label-secondary, #a3a3a3);
  --ghp-text-tertiary: var(--dsw-alias-label-tertiary, #8a8a8a);
  --ghp-radius-sm: var(--dsw-radius-sm, 8px);
  --ghp-radius-md: var(--dsw-radius-md, 10px);
  --ghp-radius-lg: var(--dsw-radius-lg, 14px);
  --ghp-motion: 120ms ease;
}


.ghp-root {
  position: relative;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 0;
  color: var(--dsw-alias-label-primary, #e6e6e6);
  font-size: 13px;
  line-height: 20px;
  text-align: left;
}
.ghp-root *, .ghp-overlay * { box-sizing: border-box; }
.ghp-root::-webkit-scrollbar, .ghp-picker-body::-webkit-scrollbar, .ghp-md-pre::-webkit-scrollbar { width: 8px; height: 8px; }
.ghp-root::-webkit-scrollbar-thumb, .ghp-picker-body::-webkit-scrollbar-thumb, .ghp-md-pre::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l1, rgba(255, 255, 255, .16));
  border-radius: 4px;
}
.ghp-root::-webkit-scrollbar-track, .ghp-picker-body::-webkit-scrollbar-track { background: transparent; }
.ghp-root :focus-visible, .ghp-overlay :focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4f7cff));
  outline-offset: 2px;
}
.ghp-page {
  box-sizing: border-box;
  width: 100%;
  /* v1.1.1: the plugin page is adaptive full width — no centred fixed column.
     Intentional reading measures only live on copy elements (empty-state text,
     error card, inline bind form), never on the page itself. */
  max-width: none;
  min-height: 100%;
  margin: 0;
  padding: 24px 32px 28px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.ghp-page-center { justify-content: center; }
@media (max-width: 760px) {
  .ghp-page { padding: 16px 16px 20px; }
}

/* Buttons ------------------------------------------------------------------ */
.ghp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-sizing: border-box;
  min-height: 30px;
  padding: 3px 12px;
  border: 1px solid var(--ghp-border-strong);
  border-radius: var(--ghp-radius-sm);
  background: var(--dsw-alias-button-elevated-fill, var(--dsw-alias-fill-l2, rgba(255, 255, 255, .06)));
  color: var(--ghp-text-primary);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color var(--ghp-motion), border-color var(--ghp-motion), color var(--ghp-motion);
}
.ghp-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .09));
  border-color: var(--ghp-border-hover);
}
.ghp-btn:disabled { opacity: .5; cursor: default; }
.ghp-btn-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; }
.ghp-btn-icon svg { display: block; }
.ghp-btn-sm { min-height: 26px; padding: 2px 9px; font-size: 12px; line-height: 16px; border-radius: var(--dsw-radius-xs, 6px); }
/* Accent-outline action (list "绑定"): color only to mark the actionable state. */
.ghp-btn-accent {
  border-color: color-mix(in srgb, var(--ghp-accent-brand) 45%, transparent);
  background: transparent;
  color: var(--ghp-accent-brand);
}
.ghp-btn-accent:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--ghp-accent-brand) 68%, transparent);
  background: color-mix(in srgb, var(--ghp-accent-brand) 12%, transparent);
  color: var(--ghp-accent-brand);
}
/* Unbind stays neutral until hover, then only the error tint marks the risk. */
.ghp-btn-unbind:hover:not(:disabled) {
  border-color: transparent;
  background: color-mix(in srgb, var(--ghp-accent-error) 12%, transparent);
  color: var(--ghp-accent-error);
}
.ghp-btn-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4f7cff));
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.ghp-btn-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #5b86ff));
  border-color: transparent;
}
.ghp-btn-ghost {
  border-color: transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #a3a3a3);
}
.ghp-btn-ghost:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .06));
  border-color: transparent;
  color: var(--dsw-alias-label-primary, #e6e6e6);
}
.ghp-btn-danger {
  border-color: color-mix(in srgb, var(--ghp-accent-error) 40%, transparent);
  background: color-mix(in srgb, var(--ghp-accent-error) 10%, transparent);
  color: var(--ghp-accent-error);
}
.ghp-btn-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ghp-accent-error) 16%, transparent);
  border-color: var(--ghp-accent-error);
}
.ghp-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: none;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-xs, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  cursor: pointer;
  text-decoration: none;
}
.ghp-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .06)); color: var(--dsw-alias-label-primary, #e6e6e6); }
.ghp-linkbtn {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--ghp-accent-brand);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.ghp-linkbtn:hover { text-decoration: underline; }
.ghp-confirm {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px;
  border-radius: var(--dsw-radius-xs, 6px);
  background: var(--dsw-alias-bg-layer-1, #1c1c1c);
  border: 1px solid var(--dsw-alias-border-l2, #3a3a3a);
}

/* Spinner / skeleton -------------------------------------------------------- */
.ghp-spinner {
  display: inline-block;
  flex: none;
  border-radius: 50%;
  border: 1.6px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, .3));
  border-top-color: var(--dsw-alias-label-secondary, #c8c8c8);
  animation: ghp-spin .7s linear infinite;
}
@keyframes ghp-spin { to { transform: rotate(360deg); } }
.ghp-skeleton { display: flex; flex-direction: column; gap: 12px; }
.ghp-sk {
  position: relative;
  overflow: hidden;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-skeleton, rgba(255, 255, 255, .06));
}
.ghp-sk::after {
  content: "";
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--ghp-text-primary) 7%, transparent), transparent);
  animation: ghp-shimmer 1.4s infinite;
}
@keyframes ghp-shimmer { 100% { transform: translateX(100%); } }
.ghp-sk-toolbar { height: 88px; border-radius: var(--dsw-radius-lg, 14px); }
.ghp-sk-row { height: 50px; }
.ghp-sk-line { height: 12px; width: 42%; }
.ghp-sk-line-wide { width: 72%; }
.ghp-sk-code { height: 120px; width: 100%; }
@media (prefers-reduced-motion: reduce) {
  .ghp-sk::after { animation: none; }
  .ghp-spinner { animation-duration: 2s; }
}

/* Banners / notices --------------------------------------------------------- */
.ghp-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1, #333);
  border-radius: var(--dsw-radius-md, 10px);
  font-size: 12px;
  line-height: 18px;
}
.ghp-banner-warn {
  border-color: color-mix(in srgb, var(--ghp-accent-warn) 32%, transparent);
  background: color-mix(in srgb, var(--ghp-accent-warn) 9%, transparent);
  color: var(--ghp-text-secondary);
}
.ghp-banner-warn .ghp-banner-icon { color: var(--dsw-alias-state-warn-label, var(--ghp-accent-warn)); }
.ghp-banner-error {
  border-color: color-mix(in srgb, var(--ghp-accent-error) 32%, transparent);
  background: color-mix(in srgb, var(--ghp-accent-error) 9%, transparent);
  color: var(--ghp-text-secondary);
}
.ghp-banner-error .ghp-banner-icon { color: var(--ghp-accent-error); }
.ghp-banner-icon { display: flex; flex: none; margin-top: 2px; }
.ghp-banner-body { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.ghp-banner-title { color: var(--ghp-text-primary); font-weight: 600; }
.ghp-banner-hint { color: var(--ghp-text-secondary); overflow-wrap: anywhere; }
.ghp-banner-close { margin-left: auto; width: 22px; height: 22px; }
.ghp-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-border-l1, #333);
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, .04));
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  font-size: 12px;
  line-height: 18px;
}
.ghp-notice-icon { display: flex; flex: none; }
.ghp-muted { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 18px; }
.ghp-inline-error { color: var(--dsw-alias-state-error-primary, #f85149); font-size: 12px; line-height: 18px; }

/* Empty / error states ------------------------------------------------------ */
.ghp-empty {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 320px;
  padding: 48px 16px;
  text-align: center;
}
.ghp-empty-inline { min-height: 180px; padding: 28px 16px; }
.ghp-empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border: 1px solid color-mix(in srgb, var(--ghp-accent-brand) 26%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--ghp-accent-brand) 13%, transparent);
  color: var(--ghp-accent-brand);
}
.ghp-empty-title { margin: 6px 0 0; color: var(--ghp-text-primary); font-size: 16px; line-height: 24px; font-weight: 600; }
.ghp-empty-title-sm { margin: 4px 0 0; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 15px; line-height: 22px; font-weight: 600; }
.ghp-empty-text { max-width: 470px; margin: 0; color: var(--dsw-alias-label-secondary, #a3a3a3); font-size: 13px; line-height: 20px; }
.ghp-empty-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 6px; }
.ghp-empty-hint { max-width: 560px; margin: 10px 0 0; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 18px; }
.ghp-empty-path { display: block; margin-top: 2px; font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; overflow-wrap: anywhere; }
.ghp-errorcard {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  max-width: 640px;
  margin: 0 auto;
  padding: 14px 16px;
  border: 1px solid color-mix(in srgb, var(--ghp-accent-error) 32%, transparent);
  border-radius: var(--ghp-radius-lg);
  background: var(--ghp-surface-raised);
  text-align: left;
}
.ghp-errorcard-compact { padding: 12px; }
.ghp-errorcard-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 48px;
  height: 48px;
  border: 1px solid color-mix(in srgb, var(--ghp-accent-error) 26%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--ghp-accent-error) 12%, transparent);
  color: var(--ghp-accent-error);
}
.ghp-errorcard-icon svg { width: 22px; height: 22px; }
.ghp-errorcard-compact .ghp-errorcard-icon { width: 32px; height: 32px; border-radius: 10px; }
.ghp-errorcard-compact .ghp-errorcard-icon svg { width: 16px; height: 16px; }
.ghp-errorcard-body { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.ghp-errorcard-title { color: var(--ghp-text-primary); font-size: 16px; line-height: 22px; font-weight: 600; }
.ghp-errorcard-compact .ghp-errorcard-title { font-size: 13px; line-height: 18px; }
.ghp-errorcard-hint { color: var(--dsw-alias-label-secondary, #a3a3a3); font-size: 12px; line-height: 18px; }
.ghp-errorcard-message { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.ghp-errorcard-code { color: var(--dsw-alias-label-quaternary, #6e6e6e); font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; }

/* Inputs -------------------------------------------------------------------- */
.ghp-input {
  box-sizing: border-box;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2, #3a3a3a);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-1, #191919);
  color: var(--dsw-alias-label-primary, #e6e6e6);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
}
.ghp-input::placeholder { color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.ghp-input:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4f7cff)); outline-offset: 1px; border-color: transparent; }
.ghp-search { position: relative; display: flex; align-items: center; flex: 1 1 260px; max-width: 430px; min-width: 0; }
.ghp-search-icon { position: absolute; left: 10px; display: flex; color: var(--dsw-alias-label-tertiary, #8a8a8a); pointer-events: none; }
.ghp-search-input { width: 100%; padding-left: 32px; }
.ghp-bindrow { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; width: 100%; max-width: 540px; margin-top: 4px; }
.ghp-bindrow .ghp-input { flex: 1 1 260px; }

/* Toolbar ------------------------------------------------------------------- */
.ghp-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 16px;
  padding: 16px 18px;
  border: 1px solid var(--dsw-alias-border-l1, #333);
  border-radius: var(--dsw-radius-lg, 14px);
  background: var(--dsw-alias-bg-layer-2, #222);
  box-shadow: var(--dsw-elevation-soft, none);
}
.ghp-toolbar-main { display: flex; flex: 1 1 320px; gap: 12px; min-width: 0; }
.ghp-toolbar-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--ghp-accent-brand) 26%, transparent);
  background: color-mix(in srgb, var(--ghp-accent-brand) 14%, transparent);
  color: var(--ghp-accent-brand);
}
.ghp-toolbar-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.ghp-toolbar-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--ghp-text-primary); font-size: 15px; line-height: 22px; font-weight: 600; overflow-wrap: anywhere; }
.ghp-toolbar-title a { display: inline-flex; align-items: center; gap: 6px; color: inherit; text-decoration: none; }
.ghp-toolbar-title a:hover { color: var(--ghp-accent-brand); text-decoration: underline; }
.ghp-toolbar-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--ghp-text-tertiary); font-size: 12px; line-height: 18px; }
.ghp-toolbar-desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-top: 2px;
  color: var(--dsw-alias-label-secondary, #a3a3a3);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.ghp-toolbar-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px; flex: 0 1 auto; }
.ghp-count-pill {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--dsw-alias-fill-l2, rgba(255, 255, 255, .07));
  color: var(--ghp-text-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.ghp-toolbar-sync { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; }
@media (max-width: 720px) {
  .ghp-toolbar { flex-direction: column; }
  .ghp-toolbar-actions { justify-content: flex-start; width: 100%; }
}

/* Filter row ---------------------------------------------------------------- */
.ghp-filters { display: flex; flex-direction: column; gap: 10px; }
.ghp-filters-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.ghp-filter-meta { display: flex; align-items: center; gap: 10px; margin-left: auto; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; }
.ghp-filter-count { font-variant-numeric: tabular-nums; }
.ghp-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ghp-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 2px 10px;
  border: 1px solid var(--dsw-alias-border-l2, #3a3a3a);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #a3a3a3);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
  transition: background .12s ease, border-color .12s ease, color .12s ease;
}
.ghp-chip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .06)); color: var(--dsw-alias-label-primary, #e6e6e6); }
.ghp-chip[aria-pressed="true"] {
  border-color: color-mix(in srgb, var(--ghp-accent-brand) 55%, transparent);
  background: color-mix(in srgb, var(--ghp-accent-brand) 12%, transparent);
  color: var(--ghp-text-primary);
}
.ghp-chip[aria-pressed="true"] .ghp-chip-count { color: var(--ghp-text-secondary); }
.ghp-chip[aria-pressed="true"] .ghp-chip-count { color: var(--dsw-alias-label-secondary, #a3a3a3); }
.ghp-chip-count { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-variant-numeric: tabular-nums; }

/* Sections and rows --------------------------------------------------------- */
.ghp-sections { display: flex; flex-direction: column; gap: 18px; }
.ghp-section { display: flex; flex-direction: column; gap: 8px; }
.ghp-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px 6px;
  border-bottom: 2px solid color-mix(in srgb, var(--ghp-lane-accent, var(--ghp-accent-no-status)) 45%, transparent);
}
.ghp-section-title { margin: 0; color: var(--ghp-text-secondary); font-size: 12px; font-weight: 600; letter-spacing: .02em; }
.ghp-lane-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--ghp-lane-accent, var(--ghp-accent-no-status));
}
.ghp-lane-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 18px;
  padding: 0 7px;
  border: 1px solid color-mix(in srgb, var(--ghp-lane-accent, var(--ghp-accent-no-status)) 24%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ghp-lane-accent, var(--ghp-accent-no-status)) 16%, transparent);
  color: var(--ghp-text-secondary);
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.ghp-section-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dsw-alias-fill-l2, rgba(255, 255, 255, .08));
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.ghp-list {
  overflow: hidden;
  border: 1px solid var(--ghp-border);
  border-radius: var(--ghp-radius-lg);
  background: var(--ghp-surface-raised);
}
.ghp-list-skeleton { display: flex; flex-direction: column; gap: 1px; }
.ghp-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--ghp-border); transition: background-color var(--ghp-motion); }
.ghp-item:first-child { border-top: none; }
.ghp-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .04)); }
.ghp-item-bound { background: color-mix(in srgb, var(--ghp-accent-brand) 8%, transparent); }
.ghp-item-glyph { display: flex; align-items: center; justify-content: center; flex: none; width: 20px; height: 20px; margin-top: 1px; border-radius: 50%; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.ghp-glyph-issue { color: var(--ghp-accent-issue); }
.ghp-glyph-pr { color: var(--ghp-accent-pr); }
.ghp-glyph-draft { color: var(--ghp-accent-draft); }
.ghp-item-main { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.ghp-item-titleline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.ghp-item-title { color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; line-height: 20px; font-weight: 500; text-decoration: none; overflow-wrap: anywhere; }
a.ghp-item-title:hover { color: var(--dsw-alias-link, #6ea8fe); text-decoration: underline; }
.ghp-item-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 18px; }
.ghp-item-repo { color: var(--dsw-alias-label-secondary, #a3a3a3); font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; }
.ghp-item-actions { display: flex; flex: none; align-items: center; gap: 4px; margin-left: 8px; }
.ghp-item-boundlabel { display: inline-flex; align-items: center; gap: 4px; color: var(--ghp-accent-brand); font-size: 12px; }
.ghp-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  max-width: 100%;
  padding: 0 7px;
  border: 1px solid var(--ghp-border-strong);
  border-radius: 999px;
  background: var(--dsw-alias-fill-l1, transparent);
  color: var(--ghp-text-secondary);
  font-size: 11px;
  line-height: 16px;
}
.ghp-label-dot { width: 5px; height: 5px; flex: none; border-radius: 50%; }
.ghp-label-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghp-milestone {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 17px;
  padding: 0 7px;
  border: 1px solid color-mix(in srgb, var(--ghp-accent-pr) 26%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ghp-accent-pr) 12%, transparent);
  color: var(--ghp-text-secondary);
  font-size: 11px;
  line-height: 15px;
}
.ghp-milestone svg { width: 11px; height: 11px; flex: none; color: var(--ghp-accent-pr); }
.ghp-dot { color: var(--dsw-alias-separator-primary, #5a5a5a); }
.ghp-repochip {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  background: var(--dsw-alias-fill-l2, rgba(255, 255, 255, .07));
  color: var(--dsw-alias-label-secondary, #a3a3a3);
  font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px;
  white-space: nowrap;
}
.ghp-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  white-space: nowrap;
}
.ghp-badge-bound {
  border: 1px solid color-mix(in srgb, var(--ghp-accent-brand) 32%, transparent);
  background: color-mix(in srgb, var(--ghp-accent-brand) 14%, transparent);
  color: var(--ghp-accent-brand);
}
.ghp-badge-closed {
  border: 1px solid var(--dsw-alias-border-l2, #3a3a3a);
  background: var(--dsw-alias-fill-l2, rgba(255, 255, 255, .07));
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.ghp-state {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
}
.ghp-state-open { border-color: color-mix(in srgb, var(--ghp-accent-success) 32%, transparent); background: color-mix(in srgb, var(--ghp-accent-success) 12%, transparent); color: var(--ghp-accent-success); }
.ghp-state-closed { border-color: var(--ghp-border-strong); background: var(--dsw-alias-fill-l2, transparent); color: var(--ghp-text-secondary); }
.ghp-state-merged { border-color: color-mix(in srgb, var(--ghp-accent-pr) 32%, transparent); background: color-mix(in srgb, var(--ghp-accent-pr) 12%, transparent); color: var(--ghp-accent-pr); }

/* View-mode toggle + milestone dropdown ------------------------------------ */
.ghp-seg {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--dsw-alias-border-l2, #3a3a3a);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-1, #191919);
}
.ghp-seg-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 22px;
  padding: 1px 8px;
  border: none;
  border-radius: var(--dsw-radius-xs, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
  transition: background .12s ease, color .12s ease;
}
.ghp-seg-btn:hover { color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .06)); }
.ghp-seg-btn[aria-pressed="true"] { color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-fill-l2, rgba(255, 255, 255, .1)); }
.ghp-seg-icon { display: inline-flex; align-items: center; }
.ghp-seg-icon svg { display: block; }
.ghp-seg-label { white-space: nowrap; }

.ghp-dropdown { position: relative; display: inline-flex; }
.ghp-dropdown-toggle { gap: 5px; }
.ghp-dropdown-value { max-width: 132px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghp-dropdown-caret { display: inline-flex; align-items: center; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.ghp-dropdown-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 40;
  box-sizing: border-box;
  min-width: 210px;
  max-width: 300px;
  max-height: 264px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l1, #3a3a3a);
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-bg-layer-2, #242424);
  box-shadow: var(--dsw-elevation-prominent, 0 16px 40px rgba(0, 0, 0, .5));
}
.ghp-dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--dsw-radius-xs, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #a3a3a3);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
.ghp-dropdown-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .06)); color: var(--dsw-alias-label-primary, #e6e6e6); }
.ghp-dropdown-item-active { background: var(--dsw-alias-fill-l2, rgba(255, 255, 255, .08)); color: var(--dsw-alias-label-primary, #e6e6e6); }
.ghp-dropdown-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghp-dropdown-count { flex: none; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 11px; font-variant-numeric: tabular-nums; }

/* Swimlane board ------------------------------------------------------------ */
.ghp-page-board { height: 100%; min-height: 0; }
.ghp-body-board { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
.ghp-board {
  display: flex;
  flex: 1 1 auto;
  align-items: stretch;
  gap: 8px;
  min-height: 220px;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 4px;
  overscroll-behavior-x: contain;
}
.ghp-board::-webkit-scrollbar { height: 8px; }
.ghp-board::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1, rgba(255, 255, 255, .16)); border-radius: 4px; }
.ghp-board::-webkit-scrollbar-track { background: transparent; }
.ghp-board-column {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-width: 176px;
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
  border: 1px solid var(--ghp-border);
  border-radius: var(--ghp-radius-lg);
  background: var(--ghp-surface-sunken);
}
.ghp-board-column-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 9px;
  border-bottom: 2px solid color-mix(in srgb, var(--ghp-lane-accent, var(--ghp-accent-no-status)) 45%, transparent);
}
.ghp-board-column-title { min-width: 0; overflow: hidden; color: var(--ghp-text-secondary); font-size: 12px; font-weight: 600; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.ghp-board-column-body { display: flex; flex: 1 1 auto; flex-direction: column; gap: 8px; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 8px; }
.ghp-board-column-body::-webkit-scrollbar { width: 8px; }
.ghp-board-column-body::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1, rgba(255, 255, 255, .14)); border-radius: 4px; }
.ghp-board-empty { padding: 12px 4px; color: var(--ghp-text-tertiary); font-size: 12px; line-height: 18px; text-align: center; }
.ghp-board-card {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--ghp-border);
  border-radius: var(--ghp-radius-md);
  background: var(--ghp-surface-raised);
  color: var(--ghp-text-primary);
  font: inherit;
  text-align: left;
  transition: background-color var(--ghp-motion), border-color var(--ghp-motion);
}
button.ghp-board-card, a.ghp-board-card { cursor: pointer; }
button.ghp-board-card:hover, a.ghp-board-card:hover {
  border-color: var(--ghp-border-hover);
  background: var(--ghp-surface-hover);
}
button.ghp-board-card:disabled { cursor: default; opacity: .7; }
.ghp-board-card:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4f7cff)); outline-offset: 1px; }
a.ghp-board-card { text-decoration: none; }
.ghp-board-card-bound {
  border-color: color-mix(in srgb, var(--ghp-accent-brand) 55%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ghp-accent-brand) 30%, transparent);
}
.ghp-board-card-title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--ghp-text-primary);
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.ghp-board-card-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; color: var(--ghp-text-tertiary); font-size: 11px; line-height: 16px; }
.ghp-type-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; }
.ghp-type-dot-issue { background: var(--ghp-accent-issue); }
.ghp-type-dot-pr { background: var(--ghp-accent-pr); }
.ghp-type-dot-draft { background: var(--ghp-accent-draft); }
.ghp-board-card-type {
  padding: 0 5px;
  border: 1px solid var(--ghp-border-strong);
  border-radius: 999px;
  color: var(--ghp-text-tertiary);
  font-size: 10px;
  line-height: 14px;
}
.ghp-board-card-repo { display: inline-flex; align-items: baseline; min-width: 0; max-width: 100%; overflow: hidden; color: var(--dsw-alias-label-secondary, #a3a3a3); font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; }
.ghp-board-card-repo-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghp-board-card-repo-number { flex: none; white-space: nowrap; }
.ghp-board-card-spinner { display: inline-flex; align-items: center; }
.ghp-board-card-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.ghp-board-card .ghp-label { height: 17px; max-width: 100%; padding: 0 6px; overflow: hidden; font-size: 10px; line-height: 15px; }
.ghp-board-card-more { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 10.5px; }
.ghp-board-card-milestone {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 100%;
  height: 17px;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--ghp-accent-pr) 26%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ghp-accent-pr) 12%, transparent);
  color: var(--ghp-text-secondary);
  font-size: 10px;
  line-height: 15px;
}
.ghp-board-card-milestone svg { flex: none; color: var(--ghp-accent-pr); }
.ghp-board-card-milestone-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghp-notice-warn { border-color: color-mix(in srgb, var(--ghp-accent-warn) 34%, transparent); }
.ghp-notice-text { flex: 1; min-width: 0; }

/* Issue view ---------------------------------------------------------------- */
.ghp-issue-head {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 18px;
  border: 1px solid var(--dsw-alias-border-l1, #333);
  border-radius: var(--dsw-radius-lg, 14px);
  background: var(--dsw-alias-bg-layer-2, #222);
  box-shadow: var(--dsw-elevation-panel, 0 6px 20px rgba(0, 0, 0, .3));
}
.ghp-issue-topline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ghp-issuenum { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 13px; font-variant-numeric: tabular-nums; }
.ghp-issue-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-left: auto; }
.ghp-issue-title { margin: 2px 0 0; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 20px; line-height: 28px; font-weight: 600; overflow-wrap: anywhere; }
.ghp-issue-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 18px; }
.ghp-issue-labels { display: flex; flex-wrap: wrap; gap: 6px; }
.ghp-card {
  padding: 16px 18px;
  border: 1px solid var(--dsw-alias-border-l1, #333);
  border-radius: var(--dsw-radius-lg, 14px);
  background: var(--dsw-alias-bg-layer-2, #222);
}
.ghp-card-title { margin: 0 0 10px; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; font-weight: 600; line-height: 20px; }
.ghp-comments { display: flex; flex-direction: column; gap: 10px; }
.ghp-comments-head { display: flex; align-items: center; gap: 8px; }
.ghp-comments-head .ghp-card-title { margin: 0; }
.ghp-comments-empty { padding: 4px 2px 2px; }
.ghp-comment {
  padding: 12px 14px;
  border: 1px solid var(--ghp-border);
  border-radius: var(--ghp-radius-md);
  background: var(--ghp-surface-sunken);
}
.ghp-comment-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 18px; }
.ghp-comment-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  border: 1px solid color-mix(in srgb, var(--ghp-avatar-color, var(--ghp-text-tertiary)) 32%, transparent);
  border-radius: 50%;
  background: color-mix(in srgb, var(--ghp-avatar-color, var(--ghp-text-tertiary)) 20%, transparent);
  color: var(--ghp-text-primary);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}
.ghp-comment-icon { display: flex; }
.ghp-comment-author { color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 500; }
.ghp-comment-link { width: 22px; height: 22px; margin-left: auto; }

/* Markdown ------------------------------------------------------------------ */
.ghp-md { color: var(--dsw-alias-label-secondary, #c8c8c8); font-size: 13px; line-height: 21px; overflow-wrap: anywhere; }
.ghp-md > :first-child { margin-top: 0; }
.ghp-md > :last-child { margin-bottom: 0; }
.ghp-md-p { margin: 0 0 10px; }
.ghp-md-heading { margin: 16px 0 8px; color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 600; line-height: 1.35; }
.ghp-md h3 { font-size: 17px; }
.ghp-md h4 { font-size: 15px; }
.ghp-md h5 { font-size: 14px; }
.ghp-md h6 { font-size: 13px; }
.ghp-md-list { margin: 0 0 10px; padding-left: 22px; }
.ghp-md-li { margin: 2px 0; }
.ghp-md-quote { margin: 0 0 12px; padding: 2px 0 2px 12px; border-left: 3px solid var(--dsw-alias-border-l3, #4a4a4a); color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.ghp-md-quote > :last-child { margin-bottom: 0; }
.ghp-md-hr { margin: 14px 0; border: none; border-top: 1px solid var(--dsw-alias-border-l1, #333); }
.ghp-md a { color: var(--ghp-accent-brand); text-decoration: none; }
.ghp-md a:hover { text-decoration: underline; }
.ghp-md strong { color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 600; }
.ghp-md-inlinecode, .ghp-md-codeblock {
  font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.ghp-md-inlinecode {
  padding: 1px 5px;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-markdown-inline-code, rgba(255, 255, 255, .08));
  color: var(--dsw-alias-label-primary, #e6e6e6);
  font-size: 12px;
}
.ghp-md-pre {
  margin: 0 0 12px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l1, #333);
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-markdown-code-block, #141414);
  overflow: auto;
}
.ghp-md-codeblock { color: var(--dsw-alias-label-secondary, #c8c8c8); font-size: 12px; line-height: 18px; white-space: pre; }
.ghp-md-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-right: 6px;
  border: 1px solid var(--dsw-alias-border-l3, #4a4a4a);
  border-radius: 3px;
  vertical-align: -2px;
  color: var(--dsw-alias-state-success-primary, #3fb950);
}
.ghp-md-check-on { border-color: var(--ghp-accent-success); background: color-mix(in srgb, var(--ghp-accent-success) 12%, transparent); }
.ghp-md-check svg { width: 10px; height: 10px; }

/* Picker modal -------------------------------------------------------------- */
.ghp-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px 20px;
  background: var(--dsw-alias-bg-mask-drop, rgba(0, 0, 0, .52));
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  animation: ghp-fade .12s ease;
}
@keyframes ghp-fade { from { opacity: .5; } to { opacity: 1; } }
.ghp-picker {
  display: flex;
  flex-direction: column;
  width: min(760px, 100%);
  min-height: 0;
  max-height: min(100%, 760px);
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1, #3a3a3a);
  border-radius: var(--dsw-radius-xl, 16px);
  background: var(--dsw-alias-bg-layer-2, #242424);
  box-shadow: var(--dsw-elevation-prominent, 0 24px 64px rgba(0, 0, 0, .6));
  animation: ghp-rise .14s ease;
}
@keyframes ghp-rise { from { transform: translateY(8px); opacity: .65; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .ghp-overlay, .ghp-picker { animation: none; }
}
.ghp-picker-head { display: flex; align-items: flex-start; gap: 12px; flex: none; padding: 18px 20px 12px; }
.ghp-picker-heading { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ghp-picker-title { margin: 0; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 16px; line-height: 24px; font-weight: 600; }
.ghp-picker-sub { margin: 0; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 18px; }
.ghp-picker-close { margin-left: auto; flex: none; }
.ghp-picker-search { flex: none; padding: 0 20px 10px; }
.ghp-picker-action-error { flex: none; padding: 0 20px 10px; }
.ghp-picker-note { flex: none; margin: 0 20px 10px; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 18px; }
.ghp-picker-body { flex: 1 1 auto; min-height: 80px; overflow-y: auto; padding: 0 10px 10px 12px; }
.ghp-picker-loading { display: flex; flex-direction: column; gap: 10px; padding: 10px 8px; }
.ghp-picker-error { padding: 6px 8px 10px; }
.ghp-picker-group { padding: 4px 0 6px; }
.ghp-picker-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px 4px 6px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.ghp-picker-group-type {
  padding: 0 5px;
  border: 1px solid var(--dsw-alias-border-l2, #3a3a3a);
  border-radius: 999px;
  color: var(--dsw-alias-label-quaternary, #6e6e6e);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
}
.ghp-picker-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  border: none;
  border-radius: var(--dsw-radius-md, 10px);
  background: transparent;
  color: var(--dsw-alias-label-primary, #e6e6e6);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ghp-picker-row:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .06)); }
.ghp-picker-row:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4f7cff)); outline-offset: -2px; }
.ghp-picker-row:disabled { opacity: .6; cursor: default; }
.ghp-picker-row-glyph { display: flex; align-items: center; justify-content: center; flex: none; width: 28px; height: 28px; border-radius: 8px; background: var(--dsw-alias-fill-l2, rgba(255, 255, 255, .06)); color: var(--dsw-alias-label-secondary, #a3a3a3); }
.ghp-picker-row-main { display: flex; flex: 1; flex-direction: column; gap: 1px; min-width: 0; }
.ghp-picker-row-titleline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.ghp-picker-row-title { overflow: hidden; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; font-weight: 500; line-height: 19px; text-overflow: ellipsis; white-space: nowrap; }
.ghp-picker-row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 17px; }
.ghp-picker-row-desc { overflow: hidden; max-width: 46em; color: var(--dsw-alias-label-quaternary, #6e6e6e); font-size: 12px; line-height: 17px; text-overflow: ellipsis; white-space: nowrap; }
.ghp-picker-row-trail { display: flex; align-items: center; justify-content: center; flex: none; width: 20px; color: var(--dsw-alias-label-quaternary, #6e6e6e); }
.ghp-picker-empty { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 36px 16px; text-align: center; }
.ghp-picker-empty-title { color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 14px; font-weight: 600; }
.ghp-picker-empty-hint { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 18px; }
.ghp-picker-cap { padding: 4px 8px 2px 6px; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 18px; }
.ghp-picker-foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: none;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--dsw-alias-border-l1, #333);
  background: var(--dsw-alias-bg-layer-1, #1c1c1c);
}
.ghp-picker-foot .ghp-picker-note { margin: 0; }
.ghp-picker-foot-title { color: var(--dsw-alias-label-secondary, #a3a3a3); font-size: 12px; font-weight: 600; }
.ghp-manual { display: flex; flex-wrap: wrap; gap: 8px; }
.ghp-manual .ghp-input { flex: 1 1 150px; }
.ghp-manual .ghp-manual-number { flex: 0 1 88px; }
.ghp-manual .ghp-btn { flex: none; }

/* v0.4.0 card/list open actions: card body opens the built-in browser, the
   bind action is an explicit sibling button (never a body click). */
.ghp-board-card {
  display: flex;
  flex-direction: column;
  gap: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--ghp-border);
  border-radius: var(--ghp-radius-md);
  background: var(--ghp-surface-raised);
  color: var(--ghp-text-primary);
  transition: background-color var(--ghp-motion), border-color var(--ghp-motion);
}
.ghp-board-card:hover { border-color: var(--ghp-border-hover); background: var(--ghp-surface-hover); }
.ghp-board-card.ghp-board-card-bound {
  border-color: color-mix(in srgb, var(--ghp-accent-brand) 55%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ghp-accent-brand) 30%, transparent);
}
.ghp-board-card.ghp-board-card-bound:hover { border-color: color-mix(in srgb, var(--ghp-accent-brand) 72%, transparent); }
.ghp-board-card-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px 6px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ghp-board-card-body-static { cursor: default; }
.ghp-board-card-body:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4f7cff));
  outline-offset: -2px;
}
.ghp-board-card-actions { display: flex; flex: none; justify-content: flex-end; padding: 0 10px 9px; }
.ghp-board-card-bind {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 22px;
  padding: 1px 8px;
  border: 1px solid color-mix(in srgb, var(--ghp-accent-brand) 42%, transparent);
  border-radius: var(--dsw-radius-xs, 6px);
  background: transparent;
  color: var(--ghp-accent-brand);
  font: inherit;
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
  transition: background-color var(--ghp-motion), border-color var(--ghp-motion);
}
.ghp-board-card-bind:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--ghp-accent-brand) 62%, transparent);
  background: color-mix(in srgb, var(--ghp-accent-brand) 12%, transparent);
}
.ghp-board-card-bind:disabled { opacity: .6; cursor: default; }
.ghp-board-card-bind-active {
  border-color: color-mix(in srgb, var(--ghp-accent-brand) 55%, transparent);
  background: color-mix(in srgb, var(--ghp-accent-brand) 14%, transparent);
}
.ghp-board-card-bind:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4f7cff));
  outline-offset: 1px;
}
.ghp-item-open {
  display: flex;
  flex: 1 1 auto;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ghp-item-open-static { cursor: default; }
.ghp-item-open:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4f7cff));
  outline-offset: 2px;
}

/* Sidebar session subtitle (§4.6): a wrapping second line inside the shipped
   session-tree row. Layout override uses :has so unbound rows keep the 32px row. */
[data-row-key^="session:"]:has([data-ghp-sidebar-subtitle]) {
  height: auto;
  min-height: 32px;
  flex-wrap: wrap;
  padding-block: 2px;
  row-gap: 2px;
  overflow: hidden;
  min-width: 0;
}
.ghp-sidebar-subtitle {
  box-sizing: border-box;
  flex: 1 1 100%;
  max-width: 100%;
  min-width: 0;
  margin-inline-start: 0;
  padding-inline-start: 20px;
  overflow: hidden;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  font-size: 11px;
  line-height: 15px;
}
.ghp-sidebar-subtitle-chip {
  display: inline-flex;
  align-items: center;
  flex: none;
  box-sizing: border-box;
  height: 14px;
  padding: 0 4px;
  border: 1px solid color-mix(in srgb, var(--ghp-accent-brand) 26%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--ghp-accent-brand) 14%, transparent);
  color: var(--ghp-accent-brand);
  font-size: 10px;
  line-height: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ghp-sidebar-subtitle-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: inherit;
  font-size: 11px;
  line-height: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Workspace project entry (§4.7, v1.0.2 preview): an always-visible board icon
   before the workspace row's hover actions. */
.ghp-workspace-entry {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  box-sizing: border-box;
  width: 20px;
  height: 20px;
  margin-inline-start: auto;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  cursor: pointer;
}
.ghp-workspace-entry:hover {
  color: var(--dsw-alias-label-secondary, #a3a3a3);
  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .08));
}
.ghp-workspace-entry:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--ghp-accent-brand, #4f7cff));
  outline-offset: 1px;
}
.ghp-workspace-entry[data-ghp-workspace-entry-bound="1"] { color: var(--ghp-accent-brand); }
.ghp-workspace-entry svg { display: block; width: 14px; height: 14px; }

/* Right-sidebar project board (v1.0.2 preview, §4.7): the existing projects
   view adapted to the narrow pane. */
.ghp-sidebar-project {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ghp-sidebar-project > .ghp-root {
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-height: 0;
}
.ghp-sidebar-project .ghp-page {
  padding: 12px 12px 16px;
  gap: 10px;
  min-height: 0;
}
.ghp-sidebar-project .ghp-page-board { min-height: 0; }
.ghp-sidebar-project .ghp-toolbar { padding: 12px; gap: 10px; }
.ghp-sidebar-project .ghp-toolbar-main { flex: 1 1 100%; }
.ghp-sidebar-project .ghp-toolbar-actions { justify-content: flex-start; }
.ghp-sidebar-project .ghp-body-board { min-height: 0; overflow-x: auto; }
.ghp-sidebar-project .ghp-board { min-height: 200px; padding-bottom: 6px; gap: 6px; }
.ghp-sidebar-project .ghp-board-column { min-width: 148px; }
.ghp-sidebar-project .ghp-filters-row { gap: 8px; }

/* Session issue subtitle (§4.5): a second, quieter line under the session title. */
.ghp-session-subtitle {
  box-sizing: border-box;
  min-width: 0;
  display: flex;
  align-items: center;
  padding-bottom: 3px;
}
.ghp-session-subtitle-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  border-radius: var(--dsw-radius-xs, 4px);
}
.ghp-session-subtitle-row:hover .ghp-session-subtitle-title { color: var(--ghp-text-primary); }
.ghp-session-subtitle-chip {
  display: inline-flex;
  align-items: center;
  flex: none;
  height: 16px;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--ghp-accent-brand) 26%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--ghp-accent-brand) 14%, transparent);
  color: var(--ghp-accent-brand);
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ghp-session-subtitle-title {
  min-width: 0;
  overflow: hidden;
  color: var(--ghp-text-secondary);
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Motion & a11y (contract §4.2.0): 120ms color/border transitions only; every
   colored dot is decorative with the text label always present; focus rings use
   the shipped focus token. Non-essential motion is disabled on request. */
@media (prefers-reduced-motion: reduce) {
  .ghp-root *, .ghp-overlay * {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
}
`

    /* ------------------------------------------------------------------ */
    /* 11. Plugin body.                                                    */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      installBindingMap(ctx)
      installSidebarSubtitles(ctx)

      // v1.0.2 preview: the workspace board lives in DSH's right sidebar as a
      // custom tab type (§4.7), not as a session tab.
      ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
        sidebarRightFace = scope.sidebarRight
        scope.effect(() => scope.sidebarRightTabs.register({
          id: PROJECT_TAB_ID,
          kind: PROJECT_TAB_KIND,
          title: () => t('projects.sidebarTab'),
        }), 'github-projects: right-sidebar tab type')
        scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
          name: 'sidebar.right.pane.tab',
          key: PROJECT_TAB_ID,
          locale: NS,
          inject: (sessionId) => ({ sessionId }),
        }, SidebarProjectView)), 'github-projects: right-sidebar pane body')
        installWorkspaceEntries(scope, t)
        scope.effect(() => () => { sidebarRightFace = null }, 'github-projects: sidebarRight face')
      })

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'github-projects'
        tag.dataset.pluginCss = '@ceasarxuu/dsh-github-projects/client.css'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }, 'github-projects: stylesheet')

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'github-projects: dictionaries')

      // Hidden helper (renders null in the actions row) that owns the session
      // issue subtitle line under the conversation title (§4.5).
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'github-projects-session-issue',
        order: 5,
        locale: NS,
      }, SessionIssueSubtitle))

      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'github-issue',
        order: 21,
        locale: NS,
        label: () => 'issue',
      }, IssueView))
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
