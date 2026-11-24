// @ts-check
/* The view-options panel for the right-sidebar Project surface.
 *
 * Kept apart from sidebar-client.js so neither file has to carry both the board
 * plumbing and this popover; the styles live in sidebar-style.js.
 */

import { writableField } from './sidebar-view.js'

export function createViewOptions({ React, Button }) {
  const h = React.createElement
  const { useEffect, useRef, useState } = React

  // --- view options -----------------------------------------------------
  // The first cut was a <details> with four native <select>s and a nested checkbox
  // list, which read as a settings form bolted onto the board. This follows the
  // pattern GitHub itself uses: one trigger in the toolbar opens a floating panel,
  // layout is a segmented control, field pickers expand in place, and the visible
  // fields are a reorderable list. Sections that only affect this session are
  // separated from the ones that write back to the view.

  const svgProps = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' }

  function IconChevron({ down }) {
    return h('svg', { ...svgProps, style: { transform: down ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' } },
      h('path', { d: 'M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z' }))
  }

  function IconSliders() {
    return h('svg', svgProps,
      h('path', { d: 'M1 2.75A.75.75 0 0 1 1.75 2h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 2.75Zm0 5A.75.75 0 0 1 1.75 7h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 7.75Zm0 5a.75.75 0 0 1 .75-.75h12.5a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1-.75-.75Z' }))
  }

  function IconBoard() {
    return h('svg', svgProps, h('path', { d: 'M1.75 2h3.5A.75.75 0 0 1 6 2.75v10.5a.75.75 0 0 1-.75.75h-3.5A.75.75 0 0 1 1 13.25V2.75A.75.75 0 0 1 1.75 2Zm4.5 0h3.5a.75.75 0 0 1 .75.75v6.5a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1-.75-.75v-6.5A.75.75 0 0 1 6.25 2Zm4.5 0h3.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1-.75-.75v-3.5A.75.75 0 0 1 10.75 2Z' }))
  }

  function IconTable() {
    return h('svg', svgProps, h('path', { d: 'M1 3.75A.75.75 0 0 1 1.75 3h12.5a.75.75 0 0 1 .75.75v8.5a.75.75 0 0 1-.75.75H1.75a.75.75 0 0 1-.75-.75v-8.5ZM2.5 6v1.5h3V6h-3Zm0 3v1.5h3V9h-3Zm4.5-3v1.5h6.5V6H7Zm0 3v1.5h6.5V9H7Z' }))
  }

  function IconGrip() {
    return h('svg', { ...svgProps, width: 10, height: 10 }, h('path', { d: 'M6 3a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm0 3a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm0 3a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm0 3a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm0 3a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z' }))
  }

  /** A coloured dot carries the field's type at a glance, the way a Project does. */
  function FieldGlyph({ field }) {
    const tone = field?.type === 'SINGLE_SELECT' ? 'select'
      : field?.type === 'ITERATION' ? 'iteration'
        : field?.type === 'ASSIGNEES' ? 'people'
          : field?.type === 'LABELS' ? 'label' : 'plain'
    return h('span', { className: `ghp-m-glyph ghp-m-glyph-${tone}`, 'aria-hidden': 'true' },
      tone === 'plain' ? String(field?.name ?? '?').slice(0, 1).toUpperCase() : null)
  }

  function ViewSelect({ label, value, options, noneLabel, onChange }) {
    const [open, setOpen] = useState(false)
    const current = options.find(option => option.id === value)
    return h('div', { className: 'ghp-m-vs' }, [
      h('span', { key: 'l', className: 'ghp-m-vs-label' }, label),
      h('button', {
        key: 't', type: 'button', className: 'ghp-m-vs-trigger', 'aria-expanded': open, 'aria-haspopup': 'listbox',
        onClick: () => setOpen(previous => !previous),
      }, [
        h('span', { key: 'n', className: 'ghp-m-vs-value' }, current ? current.name : noneLabel),
        h('span', { key: 'c', className: 'ghp-m-ic' }, IconChevron({ down: open })),
      ]),
      open ? h('div', { key: 'o', className: 'ghp-m-vs-list', role: 'listbox', 'aria-label': label },
        [h('button', {
          key: '__none', type: 'button', role: 'option', 'aria-selected': !current, className: 'ghp-m-vs-option',
          onClick: () => { setOpen(false); onChange('') },
        }, noneLabel),
        ...options.map(option => h('button', {
          key: option.id, type: 'button', role: 'option', 'aria-selected': option.id === value, className: 'ghp-m-vs-option',
          onClick: () => { setOpen(false); onChange(option.id) },
        }, [h('span', { key: 'g', className: 'ghp-m-ic' }, FieldGlyph({ field: option })), h('span', { key: 'n' }, option.name)]))]) : null,
    ])
  }

  function VisibleFields({ t, allFields, fields, onChange }) {
    const chosen = fields.map(field => field.id)
    const byId = new Map(allFields.map(field => [field.id, field]))
    const order = [...fields.map(field => field.id), ...allFields.filter(field => field.type !== 'TITLE' && !chosen.includes(field.id)).map(field => field.id)]
    const [drag, setDrag] = useState(null)
    function move(id, before) {
      if (id === before) return
      const next = order.filter(candidate => candidate !== id)
      const at = next.indexOf(before)
      next.splice(at < 0 ? next.length : at, 0, id)
      // only the visible prefix is persisted; hidden fields keep their place after it
      onChange(next.slice(0, Math.max(chosen.length, 0)).map(candidate => byId.get(candidate)).filter(Boolean))
    }
    function toggle(id) {
      const field = byId.get(id)
      if (!field) return
      onChange(chosen.includes(id)
        ? fields.filter(candidate => candidate.id !== id)
        : [...fields, field])
    }
    return h('div', { className: 'ghp-m-fields' },
      order.map(id => {
        const field = byId.get(id)
        if (!field) return null
        const on = chosen.includes(id)
        return h('div', {
          key: id, className: `ghp-m-field-row${on ? '' : ' is-off'}${drag === id ? ' is-drag' : ''}`,
          draggable: on,
          onDragStart: () => setDrag(id),
          onDragEnd: () => setDrag(null),
          onDragOver: event => { if (drag) event.preventDefault() },
          onDrop: event => { if (drag) { event.preventDefault(); move(drag, id); setDrag(null) } },
        }, [
          h('span', { key: 'g', className: 'ghp-m-grip', 'aria-hidden': 'true' }, on ? IconGrip() : null),
          h('label', { key: 'l', className: 'ghp-m-field-label' }, [
            h('input', { key: 'c', type: 'checkbox', checked: on, onChange: () => toggle(id) }),
            h('span', { key: 'f', className: 'ghp-m-ic' }, FieldGlyph({ field })),
            h('span', { key: 'n', className: 'ghp-m-field-name' }, field.name),
          ]),
        ])
      }),
      h('small', { key: 'hint', className: 'ghp-m-vs-hint' }, t('sidebar.fieldsHint')))
  }

  function ViewOptions({ t, view, fields, allFields, change, onSave, canSave, pending }) {
    const [open, setOpen] = useState(false)
    const [anchor, setAnchor] = useState({ top: 0, left: 0 })
    const trigger = useRef(null)
    const panel = useRef(null)
    const groupFields = allFields.filter(field => ['SINGLE_SELECT', 'ITERATION', 'ASSIGNEES', 'MILESTONE', 'REPOSITORY'].includes(field.type))
    const columnFields = groupFields.filter(field => ['SINGLE_SELECT', 'ITERATION'].includes(field.type))
    const sortFields = allFields.filter(field => writableField(field) || ['TITLE', 'ASSIGNEES', 'MILESTONE', 'REPOSITORY'].includes(field.type))
    const chosen = new Set(fields.map(field => field.id))

    function place() {
      const box = trigger.current?.getBoundingClientRect()
      if (!box) return
      const width = 352
      const left = Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8))
      const top = Math.min(box.bottom + 6, Math.max(8, window.innerHeight - 420))
      setAnchor({ top, left })
    }
    useEffect(() => {
      if (!open) return
      place()
      const onDown = event => {
        if (panel.current?.contains(event.target) || trigger.current?.contains(event.target)) return
        setOpen(false)
      }
      const onKey = event => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
      const onMove = () => place()
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
      window.addEventListener('resize', onMove)
      window.addEventListener('scroll', onMove, true)
      return () => {
        document.removeEventListener('mousedown', onDown)
        document.removeEventListener('keydown', onKey)
        window.removeEventListener('resize', onMove)
        window.removeEventListener('scroll', onMove, true)
      }
    }, [open])

    const layouts = [
      { id: 'BOARD_LAYOUT', label: t('sidebar.board'), icon: IconBoard },
      { id: 'TABLE_LAYOUT', label: t('sidebar.table'), icon: IconTable },
    ]
    const sort = view.sorts[0]
    return h(React.Fragment, null,
      h('button', {
        key: 'trigger', ref: trigger, type: 'button', className: `ghp-m-viewtrigger${canSave ? ' is-dirty' : ''}`,
        'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: () => setOpen(previous => !previous),
      }, [h('span', { key: 'i', className: 'ghp-m-ic' }, IconSliders()),
        h('span', { key: 't' }, t('sidebar.view')),
        h('span', { key: 'c', className: 'ghp-m-ic' }, IconChevron({ down: open }))]),
      open ? h('div', {
        key: 'panel', ref: panel, role: 'dialog', 'aria-label': t('sidebar.view'), className: 'ghp-m-viewpanel',
        style: { top: anchor.top, left: anchor.left },
      }, [
        h('div', { key: 'layout', className: 'ghp-m-vpgroup' }, [
          h('span', { key: 'l', className: 'ghp-m-vpgroup-label' }, t('sidebar.layout')),
          h('div', { key: 'seg', className: 'ghp-m-seg', role: 'group', 'aria-label': t('sidebar.layout') },
            layouts.map(option => h('button', {
              key: option.id, type: 'button', 'aria-pressed': view.layout === option.id, className: 'ghp-m-segbtn',
              onClick: () => change({ layout: option.id }),
            }, [h('span', { key: 'i', className: 'ghp-m-ic' }, option.icon()), h('span', { key: 't' }, option.label)]))),
        ]),
        h('div', { key: 'display', className: 'ghp-m-vpgroup' }, [
          h('span', { key: 'l', className: 'ghp-m-vpgroup-label' }, t('sidebar.display')),
          h(ViewSelect, {
            key: 'groups', label: t('sidebar.groups'), value: view.groups[0] ?? '', noneLabel: t('sidebar.none'),
            options: groupFields, onChange: id => change({ groups: id ? [id] : [] }),
          }),
          view.layout === 'BOARD_LAYOUT' ? h(ViewSelect, {
            key: 'columns', label: t('sidebar.columns'), value: view.columns[0] ?? '', noneLabel: t('sidebar.none'),
            options: columnFields, onChange: id => change({ columns: id ? [id] : [] }),
          }) : null,
          h('div', { key: 'sort', className: 'ghp-m-vs ghp-m-vs-inline' }, [
            h('span', { key: 'l', className: 'ghp-m-vs-label' }, t('sidebar.sort')),
            h(ViewSelect, {
              key: 'f', label: '', value: sort?.fieldId ?? '', noneLabel: t('sidebar.none'),
              options: sortFields, onChange: id => change({ sorts: id ? [{ fieldId: id, direction: sort?.direction ?? 'ASC' }] : [] }),
            }),
            sort ? h('button', {
              key: 'd', type: 'button', className: 'ghp-m-sortdir', title: sort.direction === 'ASC' ? t('sidebar.ascending') : t('sidebar.descending'),
              'aria-label': sort.direction === 'ASC' ? t('sidebar.ascending') : t('sidebar.descending'),
              onClick: () => change({ sorts: [{ ...sort, direction: sort.direction === 'ASC' ? 'DESC' : 'ASC' }] }),
            }, sort.direction === 'ASC' ? '↑' : '↓') : null,
          ]),
          h('small', { key: 'hint', className: 'ghp-m-vs-hint' }, t('sidebar.localOptions')),
        ]),
        h('div', { key: 'fields', className: 'ghp-m-vpgroup' }, [
          h('span', { key: 'l', className: 'ghp-m-vpgroup-label' }, `${t('sidebar.visibleFields')} · ${chosen.size}`),
          h(VisibleFields, {
            key: 'list', t, allFields, fields,
            onChange: next => change({ fields: next.map(field => field.id) }),
          }),
        ]),
        canSave ? h('div', { key: 'save', className: 'ghp-m-vpfoot' },
          h(Button, { size: 'sm', disabled: pending, onClick: onSave }, t('sidebar.saveView'))) : null,
      ]) : null,
    )
  }

  return ViewOptions
}
