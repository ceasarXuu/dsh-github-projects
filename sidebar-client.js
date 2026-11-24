import { createSidebarViews, sortedEntries, unsupportedLayout, writableField } from './sidebar-view.js'
import { createSidebarDetail } from './sidebar-detail.js'
import { SIDEBAR_COPY, SIDEBAR_STYLE } from './sidebar-style.js'
import { createViewOptions } from './sidebar-options.js'

const EMPTY = []
const localViews = [
  { id: 'local-board', layout: 'BOARD_LAYOUT', filter: '', fields: [], columns: [], groups: [], sorts: [] },
  { id: 'local-table', layout: 'TABLE_LAYOUT', filter: '', fields: [], columns: [], groups: [], sorts: [] },
]

export function createSidebarManagement({ React, Button, ConfirmAction, AutoBindNotice, Markdown, apiGet, apiPost }) {
  const h = React.createElement
  const { useCallback, useEffect, useMemo, useRef, useState } = React
  const rememberedViews = new Map()

  function useResource(path, revision) {
    const [state, setState] = useState({ path: null, value: null, error: null, loading: false })
    useEffect(() => {
      if (!path) return
      const controller = new AbortController()
      setState(previous => ({ path, value: previous.path === path ? previous.value : null, error: null, loading: true }))
      apiGet(path, { signal: controller.signal, timeoutMs: 90_000 }).then(value => {
        if (!controller.signal.aborted) setState({ path, value, error: null, loading: false })
      }, failure => {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, error: failure.message, loading: false }))
      })
      return () => controller.abort()
    }, [path, revision])
    return state.path === path ? state : { value: null, error: null, loading: Boolean(path) }
  }

  function useRefreshWhenVisible(ref, refresh) {
    useEffect(() => {
      const element = ref.current
      if (!element) return
      const isVisible = () => document.visibilityState !== 'hidden' && element.getClientRects().length > 0
      const onFocus = () => { if (isVisible()) refresh() }
      window.addEventListener('focus', onFocus)
      document.addEventListener('visibilitychange', onFocus)
      let observer
      if (typeof IntersectionObserver === 'function') {
        let wasVisible = isVisible()
        observer = new IntersectionObserver(([entry]) => {
          if (entry.isIntersecting && !wasVisible && isVisible()) refresh()
          wasVisible = entry.isIntersecting
        })
        observer.observe(element)
      }
      return () => {
        observer?.disconnect()
        window.removeEventListener('focus', onFocus)
        document.removeEventListener('visibilitychange', onFocus)
      }
    }, [ref, refresh])
  }

  function Filter({ t, value, onFilter }) {
    const [typed, setTyped] = useState(value)
    useEffect(() => setTyped(value), [value])
    return h('form', { className: 'ghp-m-inline ghp-m-filter', onSubmit: (event) => { event.preventDefault(); onFilter(typed.trim()) } }, [
      h('input', { key: 'filter', value: typed, autoComplete: 'off', 'aria-label': t('sidebar.filter'),
        placeholder: t('sidebar.filterPlaceholder'), maxLength: 1500, onChange: event => setTyped(event.target.value) }),
      h(Button, { key: 'submit', size: 'sm', type: 'submit' }, t('sidebar.filter')),
      value ? h(Button, { key: 'clear', size: 'sm', onClick: () => onFilter('') }, t('common.clearFilter')) : null,
    ])
  }

  function Sidebar({ t: translate, workspaceId, project, sessionIssue, allowWrites, onChangeProject, onUnbind, onBind, unbinding, autoBindNote }) {
    const t = useCallback((key, values) => {
      const copy = key.startsWith('sidebar.') ? SIDEBAR_COPY[key.slice(8)] : undefined
      return copy ? copy[translate('common.refresh') === '刷新' ? 0 : 1] : translate(key, values)
    }, [translate])
    const [revision, setRevision] = useState(0)
    const [pending, setPending] = useState(false)
    const [message, setMessage] = useState(null)
    const [selected, setSelected] = useState(null)
    const [add, setAdd] = useState(null)
    const [drafts, setDrafts] = useState({})
    const [requestedView, setRequestedView] = useState(() => rememberedViews.get(`${workspaceId}:${project.owner}/${project.number}`))
    const root = useRef(null)
    const board = useRef(null)
    const source = useRef(null)
    const restore = useRef(false)
    const activeWrite = useRef(false)
    const refreshedAt = useRef(Date.now())
    const target = useMemo(() => ({ workspaceId, owner: project.owner, number: project.number }), [workspaceId, project.owner, project.number])
    const targetKey = `${workspaceId}:${project.owner}/${project.number}`
    const url = useCallback((path, params = {}) => `${path}?${new URLSearchParams({ ...target, ...params })}`, [target])
    // Soft refresh: bump the revision and let the host serve its cache while it
    // revalidates. A hard refresh is only what the user asks for by button, so an
    // ordinary open stops paying for a cold read of every page.
    const [force, setForce] = useState(false)
    const refresh = useCallback(() => {
      setForce(false)
      setRevision(current => current + 1)
    }, [])
    const hardRefresh = useCallback(() => {
      setForce(true)
      setRevision(current => current + 1)
    }, [])
    useRefreshWhenVisible(root, useCallback(() => {
      if (activeWrite.current || Date.now() - refreshedAt.current < 1000) return
      refreshedAt.current = Date.now()
      refresh()
    }, [refresh]))

    const meta = useResource(url('/project-layout', force ? { refresh: 1 } : {}), revision)
    const fields = meta.value?.fields ?? EMPTY
    const views = meta.value?.views?.length ? meta.value.views : localViews
    const saved = views.find(view => view.id === requestedView) ?? views[0]
    const draft = drafts[saved.id] ?? {}
    const view = { ...saved, ...draft }
    const items = useResource(meta.value && view.layout !== 'ROADMAP_LAYOUT'
      ? url('/project-view-items', { filter: view.filter, ...(force ? { refresh: 1 } : { limit: 100 }) }) : null, revision)
    // The first page is on screen; the host is filling the complete set in the
    // background. Ask for it a few times at most, then leave the capped view alone.
    const partialTries = useRef(0)
    const [partialGaveUp, setPartialGaveUp] = useState(false)
    useEffect(() => {
      if (items.value?.partial !== true) {
        partialTries.current = 0
        setPartialGaveUp(false)
        return undefined
      }
      if (partialTries.current >= 4) {
        // Stop asking. Leaving "Loading…" up for ever would be worse than an
        // honest capped view, so fall back to the truncation notice.
        setPartialGaveUp(true)
        return undefined
      }
      const timer = window.setTimeout(() => { partialTries.current += 1; refresh() }, 1200)
      return () => window.clearTimeout(timer)
    }, [items.value, revision, refresh])

    const detail = useResource(selected ? url('/project-item', { itemId: selected.id }) : null, revision)
    const { Board, Table, FieldControl, AddForm } = useMemo(() => createSidebarViews({ React, Button, t }), [t])
    const Detail = useMemo(() => createSidebarDetail({ React, Button, Markdown, FieldControl, t }), [FieldControl, t])
    const ViewOptions = useMemo(() => createViewOptions({ React, Button }), [])
    const projectWritable = allowWrites && meta.value?.project?.viewerCanUpdate === true
    const openItem = Boolean(selected)
    const showingBoard = !add && !openItem

    function change(patch) {
      setDrafts(previous => ({ ...previous, [saved.id]: { ...previous[saved.id], ...patch } }))
    }

    const loadChoices = useCallback((search, signal) => apiGet(url('/project-choices', { itemId: selected?.id, search }), { signal }), [selected?.id, url])

    async function write(action) {
      if (activeWrite.current) return null
      activeWrite.current = true
      setPending(true)
      setMessage(null)
      try {
        const outcome = await apiPost('/project-operation', { ...target, ...action }, { timeoutMs: 90_000 })
        if (!outcome.warning) setMessage({ text: t('sidebar.saved') })
        return outcome
      } finally {
        activeWrite.current = false
        setPending(false)
        refresh()
      }
    }

    async function update(item, field, value, expected = item.values?.[field.id] ?? null) {
      try {
        return await write({ action: 'update-field', itemId: item.id, fieldId: field.id, expected, value })
      } catch (failure) {
        setMessage({ text: failure.message, error: true })
        return null
      }
    }

    async function archive(item) {
      try { await write({ action: 'archive', itemId: item.id }) }
      catch (failure) { setMessage({ text: failure.message, error: true }) }
    }

    function rememberSource(trigger, itemId) {
      const scrollers = board.current ? [...board.current.querySelectorAll('.ghp-m-board, .ghp-m-table-scroll')] : []
      source.current = { trigger, itemId, scroll: scrollers.map(node => [node.scrollLeft, node.scrollTop]), top: root.current?.scrollTop ?? 0 }
    }

    function back(result) {
      if (result?.warning) setMessage({ text: result.warning, error: true })
      if (result?.itemId && source.current) source.current.itemId = result.itemId
      restore.current = true
      setSelected(null)
      setAdd(null)
    }

    useEffect(() => {
      if (openItem) root.current?.querySelector('[data-sidebar-back]')?.focus()
      if (!showingBoard || !restore.current) return
      restore.current = false
      const savedSource = source.current
      const card = savedSource?.itemId && [...root.current.querySelectorAll('[data-item-id]')].find(node => node.dataset.itemId === savedSource.itemId)
      const previous = savedSource?.trigger
      const focus = card || (previous?.isConnected && previous) || root.current.querySelector('.ghp-m-filter input')
      focus?.focus({ preventScroll: true })
      const scrollers = [...board.current.querySelectorAll('.ghp-m-board, .ghp-m-table-scroll')]
      savedSource?.scroll.forEach(([left, top], index) => scrollers[index]?.scrollTo(left, top))
      if (savedSource) root.current.scrollTop = savedSource.top
    }, [openItem, showingBoard])

    const chosenFields = view.fields.length || Object.hasOwn(draft, 'fields')
      ? view.fields.map(id => fields.find(field => field.id === id)).filter(Boolean)
      : fields.filter(field => ['TITLE', 'ASSIGNEES', 'LABELS'].includes(field.type) || field.name === 'Status' || field.name === 'Priority')
    const column = view.columns.length
      ? fields.find(field => field.id === view.columns[0] && ['SINGLE_SELECT', 'ITERATION'].includes(field.type))
      : !saved.number && !Object.hasOwn(draft, 'columns') ? fields.find(field => field.type === 'SINGLE_SELECT' && field.name === 'Status') : null
    const rows = sortedEntries(items.value?.items ?? EMPTY, fields, view.sorts)
    const group = fields.find(field => field.id === view.groups[0])
    const layoutUnsupported = view.layout === 'ROADMAP_LAYOUT'
    const canSave = projectWritable && Boolean(saved.number) && !layoutUnsupported &&
      (view.filter !== saved.filter || view.layout !== saved.layout || Object.hasOwn(draft, 'fields'))

    async function saveView() {
      try {
        await write({ action: 'save-view', viewId: saved.id, filter: view.filter, layout: view.layout, fields: chosenFields.map(field => field.id),
          previousFilter: saved.filter, previousLayout: saved.layout, previousFields: saved.fields })
        setDrafts(previous => ({ ...previous, [saved.id]: { columns: view.columns, groups: view.groups, sorts: view.sorts } }))
      } catch (failure) { setMessage({ text: failure.message, error: true }) }
    }

    function choose(viewId) {
      setRequestedView(viewId)
      rememberedViews.set(targetKey, viewId)
      if (rememberedViews.size > 30) rememberedViews.delete(rememberedViews.keys().next().value)
      setMessage(null)
    }

    const listProps = {
      items: rows, fields: chosenFields, column, group, sessionIssue, pending, allowed: projectWritable,
      onOpen(item) {
        rememberSource(null, item.id)
        setMessage(null)
        setSelected(item)
      },
      onAdd(trigger, initial, mode, title) {
        rememberSource(trigger)
        setMessage(null)
        setAdd({ initial, mode, title })
      },
      async onQuickAdd(trigger, title, initial) {
        const outcome = await write({ action: 'create-draft', title, initial })
        if (outcome?.retry) {
          rememberSource(trigger, outcome.itemId)
          setAdd({ initial, outcome })
        }
        return outcome
      },
      onUpdate: update, onArchive: archive, onBind,
    }

    return h('div', { className: 'ghp-management', ref: root, 'data-ghp-management': '' }, [
      h('style', { key: 'styles' }, SIDEBAR_STYLE),
      message ? h('p', { key: 'message', className: 'ghp-m-notice', role: message.error ? 'alert' : 'status' }, message.text) : null,
      h('div', { key: 'views', ref: board, hidden: !showingBoard }, [
        h('header', { key: 'header', className: 'ghp-m-row ghp-m-spread' }, [
          h('h2', { key: 'title' }, meta.value?.project?.title ?? project.title),
          h('div', { key: 'actions', className: 'ghp-m-row' }, [
            h(Button, { key: 'refresh', onClick: hardRefresh, disabled: pending, size: 'sm' }, t('common.refresh')),
            h(Button, { key: 'change', onClick: onChangeProject, disabled: pending, size: 'sm' }, t('projects.change')),
            h(ConfirmAction, { key: 'unbind', t, label: t('common.unbind'), confirmLabel: t('common.confirmUnbind'), onConfirm: onUnbind, busy: unbinding, disabled: pending }),
          ]),
        ]),
        h(AutoBindNotice, { key: 'auto', note: autoBindNote, t }),
        !projectWritable && meta.value ? h('p', { key: 'readonly', className: 'ghp-m-muted' }, t('sidebar.readOnly')) : null,
        (meta.error || items.error) ? h('p', { key: 'error', role: 'alert' }, meta.error ?? items.error) : null,
        meta.value ? h(React.Fragment, { key: 'display' }, [
          h('nav', { key: 'tabs', className: 'ghp-m-tabs', 'aria-label': t('sidebar.views') }, views.map(candidate => h(Button, {
            key: candidate.id, onClick: () => choose(candidate.id), size: 'sm', 'aria-pressed': view.id === candidate.id,
          }, candidate.name ?? t(candidate.layout === 'BOARD_LAYOUT' ? 'sidebar.board' : 'sidebar.table')))),
          h('div', { key: 'toolbar', className: 'ghp-m-row ghp-m-spread' }, [
            h(Filter, { key: saved.id, t, value: view.filter, onFilter: filter => change({ filter }) }),
            h(ViewOptions, { key: 'options', t, view, fields: chosenFields, allFields: fields, change, canSave, pending, onSave: saveView }),
          ]),
          layoutUnsupported ? h('p', { key: 'unsupported', className: 'ghp-m-notice' }, [t('sidebar.roadmapUnsupported'), ' ',
            h('a', { key: 'origin', href: `${meta.value.project.url}/views/${saved.number}`, target: '_blank', rel: 'noopener noreferrer' }, t('common.openGithub'))]) : null,
          !layoutUnsupported && unsupportedLayout(view, fields) ? h('p', { key: 'rules', className: 'ghp-m-notice' }, t('sidebar.rulesUnsupported')) : null,
          meta.value.truncated || items.value?.truncated || partialGaveUp ? h('p', { key: 'truncated', className: 'ghp-m-notice' }, t('sidebar.truncated')) : null,
          items.value ? h('p', { key: 'count', className: 'ghp-m-muted' }, t('common.items', { count: items.value.total })) : null,
          items.value ? h(view.layout === 'BOARD_LAYOUT' ? Board : Table, { key: 'list', ...listProps }) : null,
        ]) : null,
        meta.loading || items.loading || (items.value?.partial === true && !partialGaveUp) ? h('p', { key: 'loading', role: 'status' }, t('sidebar.loading')) : null,
      ]),
      selected ? h(Detail, { key: selected.id, selected, item: detail.value?.item, loading: detail.loading, error: detail.error,
        onBack: back, onRetry: hardRefresh, onWrite: write, onUpdate: update, fields, loadChoices, writesAllowed: allowWrites, projectWritable, pending }) : null,
      add ? h(AddForm, { key: 'add', ...add, repositories: meta.value?.repositories ?? EMPTY, onBack: back, onWrite: write, pending }) : null,
    ])
  }

  return Sidebar
}
