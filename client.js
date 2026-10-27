// GitHub Projects — browser half.
//
// Two Conversation Views (`conversation.view` slot entries) for the installed
// DSH web client (0.2.1): `projects` and `issue`.
//
//   projects — the GitHub Project bound to the **workspace** of the current
//              session: a status-grouped, filterable item list. Picking an
//              Issue binds it to the current **session** and switches to the
//              `issue` tab.
//   issue    — the Issue bound to the current **session**: header, body,
//              labels and comments, rendered through a deliberately small,
//              safe Markdown subset (React elements only — no HTML injection).
//
// Only `react` / `react-dom` from the platform module table are required. The
// HTTP contract lives in the host half (`/plugin/github-projects`, see
// docs/CONTRACT.md §3.1). Everything is read-only against GitHub; the only
// writes are the durable bindings.
window.__ModuleLoader__.load({
  id: '@local/dsh-github-projects',
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
      'common.closed': '已关闭',
      'common.all': '全部',
      'common.clearFilter': '清除筛选',
      'common.unbindFailed': '解绑失败',
      'common.refreshFailed': '刷新失败',

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
      'projects.truncated': '列表已截断：仅显示前 {shown} 个条目（共 {total} 个）。',
      'projects.filterPlaceholder': '筛选标题、repo、编号或标签',
      'projects.uncategorized': '未分类',
      'projects.filterEmpty': '没有匹配的条目',
      'projects.refreshing': '正在刷新…',
      'projects.selectAria': '绑定 Project：{title}',
      'projects.ghWarningTitle': 'gh CLI 不可用',
      'projects.ghWarningHint': '安装 GitHub CLI 并运行 gh auth login 后即可读取项目数据。',
      'projects.issueBindFailed': '绑定 Issue 失败',
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
      'issue.unboundHint': '也可以切到 projects 页签，在列表里点击 Issue 的「绑定」。',
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
      'common.closed': 'Closed',
      'common.all': 'All',
      'common.clearFilter': 'Clear filter',
      'common.unbindFailed': 'Failed to unbind',
      'common.refreshFailed': 'Failed to refresh',

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
      'issue.unboundHint': 'You can also switch to the projects tab and click “Bind” on an Issue.',
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

    function LinkButton({ href, variant = 'ghost', size = 'md', icon, children, ariaLabel }) {
      if (safeHref(href) === null) return null
      const classes = ['ghp-btn']
      if (variant !== 'secondary') classes.push(`ghp-btn-${variant}`)
      if (size === 'sm') classes.push('ghp-btn-sm')
      return h('a', {
        className: classes.join(' '),
        href,
        target: '_blank',
        rel: 'noreferrer noopener',
        'aria-label': ariaLabel,
      },
      icon === undefined || icon === null ? null : h('span', { className: 'ghp-btn-icon', 'aria-hidden': true }, icon),
      children === undefined || children === null ? null : h('span', { className: 'ghp-btn-label' }, children))
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
      return h('span', { className: 'ghp-label' }, name)
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
          : h(Button, { variant: 'secondary', size: 'sm', onClick: onRetry }, t('common.retry')))
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

    function GHWarning({ t, gh }) {
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
     * Contain the view inside the conversation viewport. The shipped shell
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
        setState((previous) => ({
          status: previous.data === null || previous.data === undefined ? 'loading' : 'refreshing',
          data: previous.data ?? null,
          error: null,
        }))
        apiGet('/projects')
          .then((data) => {
            if (cancelled) return
            setState({ status: 'ready', data, error: null })
          })
          .catch((error) => {
            if (cancelled) return
            setState((previous) => ({ status: 'error', data: previous.data ?? null, error }))
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

    function ProjectToolbar({ t, project, itemCount, refreshing, onRefresh, onChange, onUnbind, unbinding }) {
      const title = textOf(project.title) || `${textOf(project.owner)} #${project.number}`
      const meta = []
      meta.push(h('span', { key: 'owner', className: 'ghp-repochip' }, `${textOf(project.owner)} / #${project.number}`))
      meta.push(h('span', { key: 'dot', className: 'ghp-dot', 'aria-hidden': true }, '·'))
      meta.push(h('span', { key: 'count' }, isPositiveInteger(itemCount) || itemCount === 0 ? t('common.items', { count: itemCount }) : t('common.itemsUnknown')))
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
          refreshing ? h('span', { className: 'ghp-toolbar-sync', role: 'status' }, h(Spinner, { size: 12 }), t('projects.refreshing')) : null,
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
            className: 'ghp-btn ghp-btn-ghost ghp-btn-sm',
          })))
    }

    function ProjectsFilters({ t, query, onQueryChange, statuses, counts, statusFilter, onStatusChange, total, matched, refreshing }) {
      const chips = [h('button', {
        key: ALL_STATUS,
        type: 'button',
        className: 'ghp-chip',
        'aria-pressed': statusFilter === ALL_STATUS,
        onClick: () => onStatusChange(ALL_STATUS),
      },
      h('span', null, t('common.all')),
      h('span', { className: 'ghp-chip-count' }, String(total)))]
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
      const filtering = query.trim() !== '' || statusFilter !== ALL_STATUS
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
        h('div', { className: 'ghp-chips', role: 'group', 'aria-label': t('projects.filterPlaceholder') }, chips))
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
      const titleNode = url === null
        ? h('span', { className: 'ghp-item-title' }, textOf(item.title))
        : h('a', {
          className: 'ghp-item-title',
          href: url,
          target: '_blank',
          rel: 'noreferrer noopener',
        }, textOf(item.title))
      return h('div', { className: `ghp-item${isBound ? ' ghp-item-bound' : ''}` },
        h('span', { className: `ghp-item-glyph ghp-glyph-${type}`, 'aria-hidden': true }, itemTypeIcon(type)),
        h('div', { className: 'ghp-item-main' },
          h('div', { className: 'ghp-item-titleline' },
            titleNode,
            isBound ? h('span', { className: 'ghp-badge ghp-badge-bound' }, t('common.bound')) : null),
          h('div', { className: 'ghp-item-meta' },
            repoLabel === '' ? null : h('span', { key: 'repo', className: 'ghp-item-repo' }, repoLabel),
            labels.slice(0, 3).map((label, index) => h(LabelPill, { key: `label-${index}`, name: label })),
            labels.length > 3 ? h('span', { key: 'labels-more', className: 'ghp-muted' }, `+${labels.length - 3}`) : null,
            milestone === ''
              ? null
              : h('span', { key: 'milestone', className: 'ghp-milestone' },
                h(IconMilestone, { size: 12 }), milestone))),
        h('div', { className: 'ghp-item-actions' },
          canBind
            ? (isBound
              ? h('span', { className: 'ghp-item-boundlabel' }, h(IconCheck, { size: 13 }), t('common.bound'))
              : h(Button, {
                variant: 'secondary',
                size: 'sm',
                disabled: binding,
                onClick: () => onBind(item),
                'aria-label': t('projects.bindIssueAria', { title: textOf(item.title) }),
              }, binding ? h(Spinner, { size: 12 }) : null, t('common.bind')))
            : (url === null
              ? null
              : h('a', {
                className: 'ghp-iconbtn',
                href: url,
                target: '_blank',
                rel: 'noreferrer noopener',
                'aria-label': t('common.openGithub'),
                title: t('common.openGithub'),
              }, h(IconExternal, { size: 14 })))))
    }

    function ProjectsEmpty({ t, workspace, onChoose }) {
      const title = textOf(workspace === null || workspace === undefined ? '' : workspace.title)
      const path = textOf(workspace === null || workspace === undefined ? '' : workspace.path)
      return h('div', { className: 'ghp-empty' },
        h('div', { className: 'ghp-empty-icon', 'aria-hidden': true }, h(IconProject, { size: 26 })),
        h('h2', { className: 'ghp-empty-title' }, t('projects.unboundTitle')),
        h('p', { className: 'ghp-empty-text' }, t('projects.unboundText')),
        h('div', { className: 'ghp-empty-actions' },
          h(Button, { variant: 'primary', onClick: onChoose }, t('projects.unboundAction'))),
        h('p', { className: 'ghp-empty-hint' },
          title === ''
            ? t('projects.workspaceHint', { title: '—' })
            : t('projects.workspaceHint', { title }),
          path === '' ? null : h('span', { className: 'ghp-empty-path' }, t('projects.workspacePath', { path }))))
    }

    function ProjectsNoWorkspace({ t }) {
      return h('div', { className: 'ghp-empty' },
        h('div', { className: 'ghp-empty-icon', 'aria-hidden': true }, h(IconProject, { size: 26 })),
        h('h2', { className: 'ghp-empty-title' }, t('projects.noWorkspaceTitle')),
        h('p', { className: 'ghp-empty-text' }, t('projects.noWorkspaceText')))
    }

    function ProjectsView({ sessionId, t, openView, completeViewRequest, viewRequest, useWorkspaces }) {
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
      const workspacePath = workspace === null || workspace === undefined ? null : textOf(workspace.path)

      const [configState, setConfigState] = useState({ status: 'loading', error: null })
      const [project, setProject] = useState(null)
      const [sessionIssue, setSessionIssue] = useState(null)
      const [gh, setGh] = useState(null)
      const [configTick, setConfigTick] = useState(0)

      const [itemsQuery, setItemsQuery] = useState({ n: 0, refresh: false })
      const [itemsState, setItemsState] = useState({ status: 'idle', data: null, error: null })

      const [pickerOpen, setPickerOpen] = useState(false)
      const [pickerBounds, setPickerBounds] = useState(null)
      const [actionError, setActionError] = useState(null)
      const [bindingItemId, setBindingItemId] = useState(null)
      const [unbinding, setUnbinding] = useState(false)

      const [query, setQuery] = useState('')
      const [statusFilter, setStatusFilter] = useState(ALL_STATUS)

      // Bindings for this session's workspace: one read, then re-read after
      // bind/unbind and after a cross-view focus request.
      useEffect(() => {
        if (workspaceId === null || workspaceId === '') {
          setConfigState({ status: 'no-workspace', error: null })
          setProject(null)
          setSessionIssue(null)
          return undefined
        }
        let cancelled = false
        setConfigState({ status: 'loading', error: null })
        apiGet(`/config${queryString({ sessionId, workspaceId })}`)
          .then((data) => {
            if (cancelled) return
            setGh(isPlainObject(data.gh) ? data.gh : null)
            setProject(isPlainObject(data.workspace) && isPlainObject(data.workspace.project) ? data.workspace.project : null)
            setSessionIssue(isPlainObject(data.session) && isPlainObject(data.session.issue) ? data.session.issue : null)
            setConfigState({ status: 'ready', error: null })
          })
          .catch((error) => {
            if (cancelled) return
            setConfigState({ status: 'error', error: describeError(error) })
          })
        return () => { cancelled = true }
      }, [workspaceId, sessionId, configTick])

      // Project items: previous data is kept while `refresh=1` re-reads.
      useEffect(() => {
        if (configState.status !== 'ready' || !isPlainObject(project)) {
          setItemsState({ status: 'idle', data: null, error: null })
          return undefined
        }
        const owner = textOf(project.owner)
        const number = project.number
        if (owner === '' || !isPositiveInteger(number)) return undefined
        let cancelled = false
        setItemsState((previous) => ({
          status: previous.data === null || previous.data === undefined ? 'loading' : 'refreshing',
          data: previous.data ?? null,
          error: null,
        }))
        apiGet(`/items${queryString({ owner, number, refresh: itemsQuery.refresh ? 1 : undefined })}`)
          .then((data) => {
            if (cancelled) return
            setItemsState({ status: 'ready', data, error: null })
          })
          .catch((error) => {
            if (cancelled) return
            setItemsState((previous) => ({ status: 'error', data: previous.data ?? null, error: describeError(error) }))
          })
        return () => { cancelled = true }
      }, [configState.status, project, itemsQuery.n])

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
        window.addEventListener('resize', update)
        root.addEventListener('scroll', update, { passive: true })
        let observer = null
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(update)
          observer.observe(root)
        }
        return () => {
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
        setPickerOpen(false)
        setItemsQuery((current) => ({ n: current.n + 1, refresh: true }))
        if (mountedRef.current) reloadConfig()
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
          setItemsState({ status: 'idle', data: null, error: null })
          reloadConfig()
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
          if (!mountedRef.current) return
          setSessionIssue(issue)
          if (typeof openView === 'function') openView('github-issue', 'bound')
        } catch (error) {
          if (mountedRef.current) setActionError(describeError(error))
        } finally {
          if (mountedRef.current) setBindingItemId(null)
        }
      }, [sessionId, workspaceId, openView])

      const rootStyle = viewportHeight === null ? undefined : { height: `${viewportHeight}px` }

      const renderPage = (children, center = false) => h('div', { className: `ghp-page${center ? ' ghp-page-center' : ''}` }, children)

      if (configState.status === 'no-workspace') {
        return h('div', { className: 'ghp-root', ref: rootRef, style: rootStyle },
          renderPage(ProjectsNoWorkspace({ t }), true))
      }
      if (configState.status === 'loading') {
        return h('div', { className: 'ghp-root', ref: rootRef, style: rootStyle },
          renderPage(h(ProjectsSkeleton)))
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

      if (!isPlainObject(project)) {
        return h('div', { className: 'ghp-root', ref: rootRef, style: rootStyle },
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

      const allItems = asArray(itemsState.data === null || itemsState.data === undefined ? null : itemsState.data.items)
      const statuses = collectStatuses(allItems)
      const counts = statusCountsOf(allItems)
      const filteredItems = filterItems(allItems, query, statusFilter)
      const groups = groupItems(filteredItems, statuses)
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
      } else {
        const sections = groups.map((group) => {
          const sectionLabel = group.key === NO_STATUS ? t('projects.uncategorized') : group.key
          return h('section', {
            key: group.key,
            className: 'ghp-section',
            'aria-label': `${sectionLabel} (${group.items.length})`,
          },
          h('div', { className: 'ghp-section-head' },
            h('h3', { className: 'ghp-section-title' }, sectionLabel),
            h('span', { className: 'ghp-section-count' }, String(group.items.length))),
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
        body = h('div', { className: 'ghp-sections' },
          sections.length > 0
            ? sections
            : h('div', { className: 'ghp-empty ghp-empty-inline' },
              h('h3', { className: 'ghp-empty-title-sm' }, t('projects.filterEmpty')),
              h('div', { className: 'ghp-empty-actions' },
                h(Button, {
                  variant: 'secondary',
                  size: 'sm',
                  onClick: () => { setStatusFilter(ALL_STATUS); setQuery('') },
                }, t('common.clearFilter')))),
        itemsState.data !== null && itemsState.data !== undefined && itemsState.data.truncated === true
          ? h('div', { className: 'ghp-notice' },
            h('span', { className: 'ghp-notice-icon', 'aria-hidden': true }, h(IconAlert, { size: 14 })),
            t('projects.truncated', {
              shown: allItems.length,
              total: isPositiveInteger(shownProject.itemCount) ? shownProject.itemCount : allItems.length,
            }))
          : null)
      }

      return h('div', { className: 'ghp-root', ref: rootRef, style: rootStyle },
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
              statusFilter,
              onStatusChange: setStatusFilter,
              total: allItems.length,
              matched: filteredItems.length,
              refreshing,
            }),
          h('div', { key: 'body', className: 'ghp-body' }, body),
        ]),
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
            h('span', { className: 'ghp-comment-icon', 'aria-hidden': true }, h(IconComment, { size: 13 })),
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
        h('div', { className: 'ghp-empty-icon', 'aria-hidden': true }, h(IconIssue, { size: 26 })),
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

      const [configState, setConfigState] = useState({ status: 'loading', error: null })
      const [summary, setSummary] = useState(null)
      const [gh, setGh] = useState(null)
      const [configTick, setConfigTick] = useState(0)

      const [detailQuery, setDetailQuery] = useState({ n: 0, refresh: false })
      const [detailState, setDetailState] = useState({ status: 'idle', data: null, error: null })

      const [refInput, setRefInput] = useState('')
      const [bindState, setBindState] = useState({ busy: false, error: null })
      const [unbinding, setUnbinding] = useState(false)
      const [actionError, setActionError] = useState(null)
      const [refreshingFlag, setRefreshingFlag] = useState(false)

      useEffect(() => {
        let cancelled = false
        setConfigState({ status: 'loading', error: null })
        apiGet(`/config${queryString({ sessionId, workspaceId })}`)
          .then((data) => {
            if (cancelled) return
            setGh(isPlainObject(data.gh) ? data.gh : null)
            const session = isPlainObject(data.session) ? data.session : null
            setSummary(session !== null && isPlainObject(session.issue) ? session.issue : null)
            setConfigState({ status: 'ready', error: null })
          })
          .catch((error) => {
            if (cancelled) return
            setConfigState({ status: 'error', error: describeError(error) })
          })
        return () => { cancelled = true }
      }, [sessionId, workspaceId, configTick])

      const summaryRepo = summary === null || summary === undefined ? '' : textOf(summary.repo)
      const summaryNumber = summary === null || summary === undefined ? null : summary.number

      useEffect(() => {
        if (!isPositiveInteger(summaryNumber) || summaryRepo === '') {
          setDetailState({ status: 'idle', data: null, error: null })
          return undefined
        }
        let cancelled = false
        setDetailState((previous) => ({
          status: previous.data === null || previous.data === undefined ? 'loading' : 'refreshing',
          data: previous.data ?? null,
          error: null,
        }))
        apiGet(`/issue${queryString({
          repo: summaryRepo,
          number: summaryNumber,
          refresh: detailQuery.refresh ? 1 : undefined,
        })}`)
          .then((data) => {
            if (cancelled) return
            setDetailState({ status: 'ready', data: isPlainObject(data.issue) ? data.issue : null, error: null })
          })
          .catch((error) => {
            if (cancelled) return
            setDetailState((previous) => ({ status: 'error', data: previous.data ?? null, error: describeError(error) }))
          })
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
        setDetailQuery((current) => ({ n: current.n + 1, refresh: true }))
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
          reloadConfig()
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
          setDetailQuery((current) => ({ n: current.n + 1, refresh: true }))
          setConfigTick((value2) => value2 + 1)
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
            onChoose: () => openView('github-projects', 'pick'),
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
              className: 'ghp-btn ghp-btn-ghost ghp-btn-sm',
            }),
            h(LinkButton, {
              href: url,
              variant: 'ghost',
              size: 'sm',
              icon: h(IconExternal, { size: 14 }),
              ariaLabel: t('common.openGithub'),
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

    const CSS = `
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
  max-width: 1000px;
  min-height: 100%;
  margin: 0 auto;
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
  border: 1px solid var(--dsw-alias-border-l2, #3a3a3a);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-button-elevated-fill, rgba(255, 255, 255, .06));
  color: var(--dsw-alias-label-primary, #e6e6e6);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition: background .12s ease, border-color .12s ease, color .12s ease;
}
.ghp-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .09));
  border-color: var(--dsw-alias-border-l3, #4a4a4a);
}
.ghp-btn:disabled { opacity: .5; cursor: default; }
.ghp-btn-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; }
.ghp-btn-icon svg { display: block; }
.ghp-btn-sm { min-height: 26px; padding: 2px 9px; font-size: 12px; line-height: 16px; border-radius: var(--dsw-radius-xs, 6px); }
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
  border-color: var(--dsw-alias-state-error-secondary, rgba(248, 81, 73, .4));
  background: rgba(248, 81, 73, .1);
  color: var(--dsw-alias-state-error-primary, #f85149);
}
.ghp-btn-danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(248, 81, 73, .16));
  border-color: var(--dsw-alias-state-error-primary, #f85149);
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
  color: var(--dsw-alias-link, #6ea8fe);
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
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .06), transparent);
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
  border-color: var(--dsw-alias-state-warn-secondary, rgba(217, 119, 6, .4));
  background: rgba(217, 119, 6, .08);
  color: var(--dsw-alias-state-warn-label, #e8a33d);
}
.ghp-banner-error {
  border-color: var(--dsw-alias-state-error-secondary, rgba(248, 81, 73, .4));
  background: rgba(248, 81, 73, .08);
  color: var(--dsw-alias-state-error-primary, #f85149);
}
.ghp-banner-icon { display: flex; flex: none; margin-top: 2px; }
.ghp-banner-body { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.ghp-banner-title { font-weight: 600; }
.ghp-banner-hint { color: var(--dsw-alias-label-secondary, #a3a3a3); overflow-wrap: anywhere; }
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
  width: 62px;
  height: 62px;
  border: 1px solid var(--dsw-alias-border-l1, #333);
  border-radius: 20px;
  background: var(--dsw-alias-bg-layer-2, #222);
  color: var(--dsw-alias-label-secondary, #a3a3a3);
  box-shadow: var(--dsw-elevation-soft, none);
}
.ghp-empty-title { margin: 6px 0 0; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 18px; line-height: 26px; font-weight: 600; }
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
  border: 1px solid var(--dsw-alias-state-error-secondary, rgba(248, 81, 73, .35));
  border-radius: var(--dsw-radius-lg, 14px);
  background: var(--dsw-alias-bg-layer-2, #222);
  text-align: left;
}
.ghp-errorcard-compact { padding: 12px; }
.ghp-errorcard-icon { display: flex; flex: none; margin-top: 1px; color: var(--dsw-alias-state-error-primary, #f85149); }
.ghp-errorcard-body { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.ghp-errorcard-title { color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; font-weight: 600; }
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
  align-items: flex-start;
  gap: 16px;
  padding: 16px 18px;
  border: 1px solid var(--dsw-alias-border-l1, #333);
  border-radius: var(--dsw-radius-lg, 14px);
  background: var(--dsw-alias-bg-layer-2, #222);
  box-shadow: var(--dsw-elevation-soft, none);
}
.ghp-toolbar-main { display: flex; flex: 1; gap: 12px; min-width: 0; }
.ghp-toolbar-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  background: var(--dsw-alias-fill-l2, rgba(255, 255, 255, .07));
  color: var(--dsw-alias-brand-primary, #4f7cff);
}
.ghp-toolbar-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.ghp-toolbar-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 16px; line-height: 24px; font-weight: 600; overflow-wrap: anywhere; }
.ghp-toolbar-title a { display: inline-flex; align-items: center; gap: 6px; color: inherit; text-decoration: none; }
.ghp-toolbar-title a:hover { color: var(--dsw-alias-link, #6ea8fe); text-decoration: underline; }
.ghp-toolbar-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 18px; }
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
.ghp-toolbar-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px; flex: none; }
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
  border-color: var(--dsw-alias-brand-primary, #4f7cff);
  background: var(--dsw-alias-fill-l2, rgba(255, 255, 255, .08));
  color: var(--dsw-alias-label-primary, #e6e6e6);
}
.ghp-chip[aria-pressed="true"] .ghp-chip-count { color: var(--dsw-alias-label-secondary, #a3a3a3); }
.ghp-chip-count { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-variant-numeric: tabular-nums; }

/* Sections and rows --------------------------------------------------------- */
.ghp-sections { display: flex; flex-direction: column; gap: 18px; }
.ghp-section { display: flex; flex-direction: column; gap: 8px; }
.ghp-section-head { display: flex; align-items: center; gap: 8px; padding: 0 2px; }
.ghp-section-title { margin: 0; color: var(--dsw-alias-label-secondary, #a3a3a3); font-size: 12px; font-weight: 600; letter-spacing: .02em; }
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
  border: 1px solid var(--dsw-alias-border-l1, #333);
  border-radius: var(--dsw-radius-lg, 14px);
  background: var(--dsw-alias-bg-layer-2, #222);
}
.ghp-list-skeleton { display: flex; flex-direction: column; gap: 1px; }
.ghp-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1, #333); transition: background .1s ease; }
.ghp-item:first-child { border-top: none; }
.ghp-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .04)); }
.ghp-item-bound { background: rgba(63, 185, 80, .06); }
.ghp-item-glyph { display: flex; align-items: center; justify-content: center; flex: none; width: 20px; height: 20px; margin-top: 1px; border-radius: 50%; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.ghp-glyph-issue { color: var(--dsw-alias-state-success-primary, #3fb950); }
.ghp-glyph-pr { color: var(--dsw-alias-state-business-primary, #a371f7); }
.ghp-glyph-draft { color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.ghp-item-main { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.ghp-item-titleline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.ghp-item-title { color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; line-height: 20px; font-weight: 500; text-decoration: none; overflow-wrap: anywhere; }
a.ghp-item-title:hover { color: var(--dsw-alias-link, #6ea8fe); text-decoration: underline; }
.ghp-item-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 18px; }
.ghp-item-repo { color: var(--dsw-alias-label-secondary, #a3a3a3); font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; }
.ghp-item-actions { display: flex; flex: none; align-items: center; gap: 4px; margin-left: 8px; }
.ghp-item-boundlabel { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-state-success-primary, #3fb950); font-size: 12px; }
.ghp-label {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border: 1px solid var(--dsw-alias-border-l2, #3a3a3a);
  border-radius: 999px;
  background: var(--dsw-alias-fill-l1, rgba(255, 255, 255, .04));
  color: var(--dsw-alias-label-secondary, #a3a3a3);
  font-size: 11px;
  line-height: 16px;
}
.ghp-milestone { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
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
  border: 1px solid rgba(63, 185, 80, .3);
  background: rgba(63, 185, 80, .14);
  color: var(--dsw-alias-state-success-primary, #3fb950);
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
.ghp-state-open { border-color: rgba(63, 185, 80, .3); background: rgba(63, 185, 80, .12); color: var(--dsw-alias-state-success-primary, #3fb950); }
.ghp-state-closed { border-color: rgba(248, 81, 73, .25); background: rgba(248, 81, 73, .1); color: var(--dsw-alias-state-error-primary, #f85149); }
.ghp-state-merged { border-color: rgba(163, 113, 247, .3); background: rgba(163, 113, 247, .12); color: var(--dsw-alias-state-business-primary, #a371f7); }

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
  border: 1px solid var(--dsw-alias-border-l1, #333);
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-bg-layer-1, #1c1c1c);
}
.ghp-comment-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 18px; }
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
.ghp-md a { color: var(--dsw-alias-link, #6ea8fe); text-decoration: none; }
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
.ghp-md-check-on { border-color: var(--dsw-alias-state-success-primary, #3fb950); background: rgba(63, 185, 80, .12); }
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
`

    /* ------------------------------------------------------------------ */
    /* 11. Plugin body.                                                    */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'github-projects'
        tag.dataset.pluginCss = '@local/dsh-github-projects/client.css'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }, 'github-projects: stylesheet')

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'github-projects: dictionaries')

      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'github-projects',
        order: 20,
        locale: NS,
        label: () => 'projects',
      }, ProjectsView))

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
