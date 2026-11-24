const CHOICES = new Set(['SINGLE_SELECT', 'ITERATION', 'MULTI_SELECT'])
const EDITABLE = new Set([...CHOICES, 'TEXT', 'NUMBER', 'DATE'])
const BUILTIN_FIELDS = new Set(['TITLE', 'ASSIGNEES', 'LABELS', 'MILESTONE', 'REPOSITORY', 'CLOSED'])

export const writableField = (field) => field && !field.issueField && EDITABLE.has(field.type)
const toList = value => Array.isArray(value) ? value : [value]

export function fieldValue(item, field) {
  switch (field.type) {
    case 'TITLE': return item.title
    case 'ASSIGNEES': return item.assignees
    case 'LABELS': return item.labels
    case 'MILESTONE': return item.milestone
    case 'REPOSITORY': return item.repo
    case 'CLOSED': return item.state
    default: return item.values?.[field.id] ?? null
  }
}

export function fieldText(item, field) {
  const value = fieldValue(item, field)
  if (value == null) return ''
  if (!CHOICES.has(field.type)) return toList(value).join(', ')
  return toList(value).map(id => field.options.find(option => option.id === id)?.name ?? id).join(', ')
}

export function sortedEntries(rows, fields, sorts) {
  if (!sorts.length) return rows
  return [...rows].sort((a, b) => {
    for (const { fieldId, direction } of sorts) {
      const field = fields.find(candidate => candidate.id === fieldId)
      if (!field) continue
      const first = fieldValue(a, field), second = fieldValue(b, field)
      if (first == null || second == null) {
        if (first != null || second != null) return first == null ? 1 : -1
        continue
      }
      const options = field.options
      const left = options.findIndex(option => option.id === first)
      const right = options.findIndex(option => option.id === second)
      const order = left >= 0 && right >= 0 ? left - right
        : typeof first === 'number' && typeof second === 'number' ? first - second
          : String(first).localeCompare(String(second), undefined, { numeric: true })
      if (order !== 0) return direction === 'DESC' ? -order : order
    }
    return 0
  })
}

export function unsupportedLayout(view, fields) {
  const known = field => field && (EDITABLE.has(field.type) || BUILTIN_FIELDS.has(field.type))
  return view.columns.length > 1 || view.groups.length > 1 ||
    [...view.columns, ...view.groups, ...view.sorts.map(sort => sort.fieldId)].some(id => !known(fields.find(field => field.id === id)))
}

export function createSidebarViews({ React, Button, t }) {
  const h = React.createElement
  const { useEffect, useRef, useState } = React


  /* --- view options ------------------------------------------------------
   * A button in the toolbar opens a floating panel, and the field list opens a
   * dialog. Neither one takes a row of the board: the panel is positioned over
   * the page and dismissed on Escape or an outside click, the dialog is a modal.
   */
  function Pick({ label, value, options, onChange }) {
    const [open, setOpen] = useState(false)
    const current = options.find(option => option.id === value)
    return h('div', { className: 'ghp-m-pick' }, [
      h('span', { key: 'l', className: 'ghp-m-pick-label' }, label),
      h('button', {
        key: 'b', type: 'button', className: 'ghp-m-pick-btn', 'aria-expanded': open, 'aria-haspopup': 'listbox',
        onClick: () => setOpen(previous => !previous),
      }, [h('span', { key: 'v', className: 'ghp-m-pick-value' }, current ? current.name : '—'),
        h('span', { key: 'c', className: 'ghp-m-chev', 'aria-hidden': 'true' }, '⌄')]),
      open ? h('div', { key: 'o', className: 'ghp-m-pick-list', role: 'listbox', 'aria-label': label }, [
        h('button', { key: '__none', type: 'button', role: 'option', className: 'ghp-m-pick-item', 'aria-selected': !current, onClick: () => { setOpen(false); onChange('') } }, '—'),
        ...options.map(option => h('button', {
          key: option.id, type: 'button', role: 'option', className: 'ghp-m-pick-item', 'aria-selected': option.id === value,
          onClick: () => { setOpen(false); onChange(option.id) },
        }, option.name)),
      ]) : null,
    ])
  }

  function FieldsDialog({ allFields, fields, onChange, onClose }) {
    const chosen = new Set(fields.map(field => field.id))
    function toggle(field) {
      onChange(chosen.has(field.id) ? fields.filter(candidate => candidate.id !== field.id) : [...fields, field])
    }
    return h('div', {
      className: 'ghp-m-backdrop', role: 'presentation',
      onMouseDown: event => { if (event.target === event.currentTarget) onClose() },
    }, h('div', { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('sidebar.visibleFields'), className: 'ghp-m-dialog' }, [
      h('div', { key: 'head', className: 'ghp-m-dialog-head' }, [
        h('strong', { key: 'title' }, t('sidebar.visibleFields')),
        h('button', { key: 'x', type: 'button', className: 'ghp-m-dialog-x', 'aria-label': t('sidebar.done'), onClick: onClose }, '×'),
      ]),
      h('div', { key: 'body', className: 'ghp-m-dialog-body' },
        allFields.filter(field => field.type !== 'TITLE').map(field => h('label', { key: field.id, className: 'ghp-m-check' }, [
          h('input', { key: 'i', type: 'checkbox', checked: chosen.has(field.id), onChange: () => toggle(field) }),
          h('span', { key: 'n' }, field.name),
        ]))),
      h('div', { key: 'foot', className: 'ghp-m-dialog-foot' },
        h(Button, { size: 'sm', onClick: onClose }, t('sidebar.done'))),
    ]))
  }

  function ViewOptions({ view, fields, allFields, change, onSave, canSave, pending }) {
    const [open, setOpen] = useState(false)
    const [dialog, setDialog] = useState(false)
    const [anchor, setAnchor] = useState({ top: 0, left: 0 })
    const trigger = useRef(null)
    const panel = useRef(null)
    const groupFields = allFields.filter(field => ['SINGLE_SELECT', 'ITERATION', 'ASSIGNEES', 'MILESTONE', 'REPOSITORY'].includes(field.type))
    const columnFields = groupFields.filter(field => ['SINGLE_SELECT', 'ITERATION'].includes(field.type))
    const sortFields = allFields.filter(field => writableField(field) || ['TITLE', 'ASSIGNEES', 'MILESTONE', 'REPOSITORY'].includes(field.type))
    const sort = view.sorts[0]

    useEffect(() => {
      if (!open) return undefined
      const box = trigger.current?.getBoundingClientRect()
      if (box) {
        const width = 300
        setAnchor({
          top: Math.min(box.bottom + 6, Math.max(8, window.innerHeight - 360)),
          left: Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8)),
        })
      }
      const onDown = event => {
        if (panel.current?.contains(event.target) || trigger.current?.contains(event.target)) return
        setOpen(false)
      }
      const onKey = event => { if (event.key === 'Escape') setOpen(false) }
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
      return () => {
        document.removeEventListener('mousedown', onDown)
        document.removeEventListener('keydown', onKey)
      }
    }, [open])

    return h(React.Fragment, null,
      h('button', {
        key: 'trigger', ref: trigger, type: 'button', className: `ghp-m-viewbtn${canSave ? ' is-dirty' : ''}`,
        'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: () => setOpen(previous => !previous),
      }, [h('span', { key: 'l' }, t('sidebar.view')), h('span', { key: 'c', className: 'ghp-m-chev', 'aria-hidden': 'true' }, '⌄')]),
      open ? h('div', { key: 'panel', ref: panel, role: 'dialog', 'aria-label': t('sidebar.view'), className: 'ghp-m-viewpanel', style: anchor }, [
        h('div', { key: 'layout', className: 'ghp-m-row-inline' }, [
          h('span', { key: 'l', className: 'ghp-m-pick-label' }, t('sidebar.layout')),
          h('div', { key: 's', className: 'ghp-m-seg', role: 'group', 'aria-label': t('sidebar.layout') }, [
            h('button', { key: 'board', type: 'button', 'aria-pressed': view.layout === 'BOARD_LAYOUT', onClick: () => change({ layout: 'BOARD_LAYOUT' }) }, t('sidebar.board')),
            h('button', { key: 'table', type: 'button', 'aria-pressed': view.layout === 'TABLE_LAYOUT', onClick: () => change({ layout: 'TABLE_LAYOUT' }) }, t('sidebar.table')),
          ]),
        ]),
        h(Pick, { key: 'groups', label: t('sidebar.groups'), value: view.groups[0] ?? '', options: groupFields, onChange: id => change({ groups: id ? [id] : [] }) }),
        view.layout === 'BOARD_LAYOUT'
          ? h(Pick, { key: 'columns', label: t('sidebar.columns'), value: view.columns[0] ?? '', options: columnFields, onChange: id => change({ columns: id ? [id] : [] }) })
          : null,
        h('div', { key: 'sort', className: 'ghp-m-row-inline' }, [
          h(Pick, { key: 'p', label: t('sidebar.sort'), value: sort?.fieldId ?? '', options: sortFields,
            onChange: id => change({ sorts: id ? [{ fieldId: id, direction: sort?.direction ?? 'ASC' }] : [] }) }),
          sort ? h('button', {
            key: 'd', type: 'button', className: 'ghp-m-sortdir',
            title: sort.direction === 'ASC' ? t('sidebar.ascending') : t('sidebar.descending'),
            'aria-label': sort.direction === 'ASC' ? t('sidebar.ascending') : t('sidebar.descending'),
            onClick: () => change({ sorts: [{ ...sort, direction: sort.direction === 'ASC' ? 'DESC' : 'ASC' }] }),
          }, sort.direction === 'ASC' ? '↑' : '↓') : null,
        ]),
        h('button', { key: 'fields', type: 'button', className: 'ghp-m-viewrow', onClick: () => { setOpen(false); setDialog(true) } },
          [h('span', { key: 'l' }, t('sidebar.visibleFields')),
            h('span', { key: 'n', className: 'ghp-m-muted' }, String(new Set(fields.map(field => field.id)).size)),
            h('span', { key: 'c', className: 'ghp-m-chev', 'aria-hidden': 'true' }, '›')]),
        h('small', { key: 'hint', className: 'ghp-m-muted' }, t('sidebar.localOptions')),
        canSave ? h('div', { key: 'save', className: 'ghp-m-viewfoot' },
          h(Button, { size: 'sm', disabled: pending, onClick: onSave }, t('sidebar.saveView'))) : null,
      ]) : null,
      dialog ? h(FieldsDialog, {
        key: 'dialog', allFields, fields,
        onChange: next => change({ fields: next.map(field => field.id) }),
        onClose: () => setDialog(false),
      }) : null,
    )
  }

  function FieldControl({ item, field, allowed, pending, onUpdate }) {
    const original = fieldValue(item, field)
    const name = `${item.title} · ${field.name}`
    if (!allowed || !writableField(field) || (item.valuesTruncated && !Object.hasOwn(item.values, field.id))) {
      return h('span', null, fieldText(item, field) || '—')
    }
    if (CHOICES.has(field.type)) {
      const multi = field.type === 'MULTI_SELECT'
      const value = multi ? original ?? [] : original ?? ''
      return h('select', {
        'aria-label': name, value, multiple: multi, 'aria-disabled': pending,
        onChange: (event) => {
          if (pending) return
          const next = multi ? [...event.target.selectedOptions].map(option => option.value) : event.target.value || null
          onUpdate(item, field, next)
        },
      }, [multi ? null : h('option', { key: 'none', value: '' }, '—'),
        ...field.options.map(({ id, name: option }) => h('option', { key: id, value: id }, option))])
    }
    return h(ScalarField, { key: `${item.id}:${field.id}`, name, item, field, original, pending, onUpdate })
  }

  function ScalarField({ name, item, field, original, pending, onUpdate }) {
    const [draft, setDraft] = useState(null)
    const value = draft?.value ?? String(original ?? '')
    const changed = draft !== null && value !== String(draft.original ?? '')
    return h('form', { className: 'ghp-m-inline', onSubmit: async (event) => {
      event.preventDefault()
      if (!changed || pending) return
      const next = value === '' ? null : field.type === 'NUMBER' ? Number(value) : value
      if (await onUpdate(item, field, next, draft.original)) setDraft(null)
    } }, [
      h('input', { key: 'value', 'aria-label': name, value, type: field.type === 'DATE' ? 'date' : field.type.toLowerCase(),
        step: field.type === 'NUMBER' ? 'any' : undefined, onChange: (event) => {
          const next = event.target.value
          setDraft(previous => ({ original: previous ? previous.original : original, value: next }))
        } }),
      changed ? h(Button, { key: 'save', type: 'submit', size: 'sm', disabled: pending }, t('sidebar.save')) : null,
    ])
  }

  function itemTitle(item, onOpen) {
    const title = item.title || t('sidebar.restricted')
    return h('button', { type: 'button', className: 'ghp-m-item-title', 'data-item-id': item.id, onClick: () => onOpen(item), disabled: item.inaccessible }, title)
  }

  function ItemMenu({ item, column, allowed, pending, onUpdate, onArchive, onBind, sessionIssue }) {
    if (item.inaccessible) return null
    const bound = item.type === 'issue' && item.repo === sessionIssue?.repo && item.number === sessionIssue?.number
    const bind = item.type === 'issue' && Boolean(onBind) && !bound
    if (!allowed && !bind && !bound) return null
    return h('details', { className: 'ghp-m-menu' }, [
      h('summary', { key: 'summary', 'aria-label': `${t('sidebar.itemActions')} ${item.title}` }, '⋯'),
      h('div', { key: 'actions', className: 'ghp-m-menu-actions' }, [
        allowed && column ? h('label', { key: 'move' }, [t('board.moveTo'), h(FieldControl, { item, field: column, allowed, pending, onUpdate })]) : null,
        bind ? h(Button, { key: 'bind', disabled: pending, size: 'sm', onClick: () => onBind(item) }, t('common.bind')) : null,
        bound ? h('span', { key: 'bound', className: 'ghp-m-muted' }, t('common.bound')) : null,
        allowed ? h(Button, { key: 'archive', disabled: pending, size: 'sm', onClick: () => onArchive(item) }, t('sidebar.archive')) : null,
      ]),
    ])
  }

  function groupRows(items, field) {
    if (!field) return [{ value: '', rows: items }]
    const groups = new Map()
    for (const item of items) {
      const value = fieldText(item, field) || t('sidebar.noValue')
      if (!groups.has(value)) groups.set(value, [])
      groups.get(value).push(item)
    }
    return [...groups].map(([value, rows]) => ({ value, rows }))
  }

  function AddEntry({ initial, onAdd, onQuickAdd, pending }) {
    const [open, setOpen] = useState(false)
    const [title, setTitle] = useState('')
    const [uncertain, setUncertain] = useState(false)
    const [error, setError] = useState(null)
    if (!open) return h(Button, { size: 'sm', disabled: pending, onClick: () => setOpen(true) }, t('sidebar.add'))
    return h('form', { className: 'ghp-m-form', onSubmit: async (event) => {
      event.preventDefault()
      if (!title.trim() || pending || uncertain) return
      const trigger = event.currentTarget.querySelector('input')
      setError(null)
      try {
        const result = await onQuickAdd(trigger, title.trim(), initial)
        if (result) { setOpen(false); setTitle('') }
      } catch (failure) {
        const unknown = ['timeout', 'network', 'internal'].includes(failure.code)
        setUncertain(unknown)
        setError(unknown ? t('sidebar.addUnknown') : failure.message)
      }
    } }, [
      h('input', { key: 'title', value: title, maxLength: 256, 'aria-label': t('sidebar.draftTitle'), autoFocus: true, onChange: event => setTitle(event.target.value) }),
      error ? h('p', { key: 'error', role: 'alert' }, error) : null,
      h('div', { key: 'actions', className: 'ghp-m-row' }, [
        h(Button, { key: 'draft', type: 'submit', size: 'sm', disabled: pending || uncertain || !title.trim() }, t('sidebar.create-draft')),
        h(Button, { key: 'issue', size: 'sm', disabled: pending, onClick: (event) => onAdd(event.currentTarget, initial, 'create-issue', title) }, t('sidebar.create-issue')),
        h(Button, { key: 'existing', size: 'sm', disabled: pending, onClick: (event) => onAdd(event.currentTarget, initial, 'add-item') }, t('sidebar.add-item')),
        h(Button, { key: 'cancel', size: 'sm', disabled: pending, onClick: () => { setOpen(false); setError(null); setUncertain(false) } }, t('sidebar.cancel')),
      ]),
    ])
  }

  function Board({ items, fields, column, group, onOpen, onAdd, onQuickAdd, onUpdate, ...menu }) {
    const dragging = useRef(null)
    const [over, setOver] = useState(null)
    const choices = column ? [...column.options, { id: null, name: t('sidebar.noValue') }] : [{ id: null, name: t('sidebar.allItems') }]
    return h('div', { className: 'ghp-m-board' }, groupRows(items, group).map(({ value, rows }) =>
      h('section', { key: value, className: 'ghp-m-board-group' }, [
        value ? h('h3', { key: 'heading' }, value) : null,
        h('div', { key: 'lanes', className: 'ghp-m-lanes' }, choices.map(choice => {
          const lane = `${value}:${choice.id ?? ''}`
          const entries = rows.filter(item => !column || fieldValue(item, column) === choice.id)
          const mayMove = menu.allowed && writableField(column)
          const handlers = mayMove ? {
            onDragOver(event) {
              if (!dragging.current || dragging.current.group !== value) return
              event.preventDefault()
              setOver(lane)
            },
            onDrop(event) {
              if (!dragging.current || dragging.current.group !== value) return
              event.preventDefault()
              onUpdate(dragging.current.item, column, choice.id)
              dragging.current = null
              setOver(null)
            },
          } : {}
          return h('section', { ...handlers, key: lane, className: 'ghp-m-lane', 'data-drop-target': over === lane ? '' : undefined }, [
            h('h3', { key: 'name' }, [choice.name, h('span', { key: 'count', className: 'ghp-m-muted' }, ` ${entries.length}`)]),
            ...entries.map(item => h('article', {
              key: item.id, className: 'ghp-m-card', draggable: mayMove && !item.inaccessible && !menu.pending,
              onDragStart(event) {
                if (!mayMove || item.inaccessible || menu.pending) return
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', item.id)
                dragging.current = { item, group: value }
              },
              onDragEnd() { setOver(null); dragging.current = null },
            }, [
              h('div', { key: 'meta', className: 'ghp-m-row ghp-m-spread' }, [
                h('small', { key: 'ref', className: 'ghp-m-muted' }, item.repo ? `${item.repo} #${item.number}` : t(`sidebar.kind.${item.type}`)),
                h(ItemMenu, { key: 'menu', ...menu, item, column, onUpdate }),
              ]),
              h('div', { key: 'title' }, itemTitle(item, onOpen)),
              h('div', { key: 'fields', className: 'ghp-m-row' }, fields.filter(field => field !== column && field.type !== 'TITLE').map(field => {
                const text = fieldText(item, field)
                return text ? h('span', { key: field.id, className: 'ghp-m-chip', title: field.name }, text) : null
              })),
            ])),
            menu.allowed ? h(AddEntry, { key: 'add', pending: menu.pending, onAdd, onQuickAdd,
              initial: column && choice.id !== null ? { fieldId: column.id, value: choice.id } : null }) : null,
          ])
        })),
      ])))
  }

  function Table({ items, fields, group, onOpen, onAdd, onQuickAdd, onUpdate, ...menu }) {
    const columns = fields.filter(field => field.type !== 'TITLE')
    return h('div', { className: 'ghp-m-table-scroll' }, [
      h('table', { key: 'table', className: 'ghp-m-table' }, [
        h('thead', { key: 'head' }, h('tr', null, [
          h('th', { key: 'title', scope: 'col' }, t('sidebar.title')),
          ...columns.map(field => h('th', { key: field.id, scope: 'col' }, field.name)),
          h('th', { key: 'actions', scope: 'col' }, t('sidebar.itemActions')),
        ])),
        ...groupRows(items, group).map(({ value, rows }) => h('tbody', { key: value }, [
          value ? h('tr', { key: 'group' }, h('th', { scope: 'rowgroup', colSpan: columns.length + 2 }, value)) : null,
          ...rows.map(item => h('tr', { key: item.id }, [
            h('td', { key: 'title' }, [itemTitle(item, onOpen), item.repo ? h('small', { key: 'ref', className: 'ghp-m-muted' }, ` ${item.repo} #${item.number}`) : null]),
            ...columns.map(field => h('td', { key: field.id }, h(FieldControl, { item, field, allowed: menu.allowed && !item.inaccessible, pending: menu.pending, onUpdate }))),
            h('td', { key: 'actions' }, h(ItemMenu, { ...menu, item, onUpdate })),
          ])),
        ])),
      ]),
      menu.allowed ? h(AddEntry, { key: 'add', pending: menu.pending, onAdd, onQuickAdd, initial: null }) : null,
    ])
  }

  function AddForm({ initial, mode, title, outcome, repositories, onBack, onWrite, pending }) {
    const [action, setAction] = useState(mode ?? 'create-draft')
    const [result, setResult] = useState(outcome ?? null)
    const [error, setError] = useState(null)
    const [uncertain, setUncertain] = useState(false)
    async function submit(operation) {
      setError(null)
      try {
        const outcome = await onWrite(operation)
        if (!outcome) return
        if (outcome.retry) setResult(outcome)
        else onBack(outcome)
      } catch (failure) {
        setError(failure.message)
        setUncertain(operation.action.startsWith('create-') && ['timeout', 'network', 'internal'].includes(failure.code))
      }
    }
    return h('section', { className: 'ghp-m-section' }, [
      h(Button, { key: 'back', size: 'sm', onClick: () => onBack(result), disabled: pending }, t('sidebar.back')),
      h('h2', { key: 'title' }, t('sidebar.add')),
      error ? h('p', { key: 'error', role: 'alert' }, error) : null,
      uncertain ? h('p', { key: 'uncertain' }, t('sidebar.addUnknown')) : null,
      result ? h('div', { key: 'result', role: 'status' }, [
        h('p', { key: 'message' }, `${result.issue ? `${result.issue.repo} #${result.issue.number} · ` : ''}${result.warning}`),
        h(Button, { key: 'retry', onClick: () => void submit(result.retry), disabled: pending }, t(result.retry.action === 'add-item' ? 'sidebar.retryAdd' : 'sidebar.retryField')),
      ]) : h('form', { key: 'form', className: 'ghp-m-form', onSubmit: (event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        void submit({ ...Object.fromEntries(data), action, initial })
      } }, [
        h('label', { key: 'mode' }, [t('sidebar.mode'), h('select', { value: action, onChange: event => setAction(event.target.value) },
          ['create-draft', 'create-issue', 'add-item'].map(value => h('option', { key: value, value }, t(`sidebar.${value}`))))]),
        action === 'add-item' ? h('label', { key: 'reference' }, [t('sidebar.reference'), h('input', { name: 'reference', required: true, maxLength: 300, placeholder: 'owner/repo#123' })]) : null,
        action === 'create-issue' ? h('label', { key: 'repo' }, [t('sidebar.repo'), h('input', { name: 'repo', list: 'ghp-m-repositories', required: true, defaultValue: repositories[0] ?? '' }),
          h('datalist', { id: 'ghp-m-repositories' }, repositories.map(repo => h('option', { key: repo, value: repo })))]) : null,
        action !== 'add-item' ? h('label', { key: 'title' }, [t('sidebar.title'), h('input', { name: 'title', maxLength: 256, required: true, defaultValue: title })]) : null,
        action !== 'add-item' ? h('label', { key: 'body' }, [t('sidebar.body'), h('textarea', { name: 'body', rows: 5, maxLength: 60_000 })]) : null,
        h(Button, { key: 'submit', type: 'submit', disabled: pending || uncertain }, t(`sidebar.${action}`)),
      ]),
    ])
  }

  return { Board, Table, FieldControl, AddForm, ViewOptions }
}
