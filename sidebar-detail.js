import { writableField } from './sidebar-view.js'

export function createSidebarDetail({ React, Button, Markdown, FieldControl, t }) {
  const h = React.createElement
  const { useEffect, useState } = React

  function TextEditor({ original, field, onSave, onCancel, pending }) {
    const [value, setValue] = useState(original)
    const input = { value, required: field === 'title', maxLength: field === 'title' ? 256 : 60_000,
      onChange: event => setValue(event.target.value), 'aria-label': t(`sidebar.${field}`), autoFocus: true }
    return h('form', { className: 'ghp-m-form', onKeyDown: (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
        event.preventDefault()
        event.currentTarget.requestSubmit()
      }
    }, onSubmit: (event) => {
      event.preventDefault()
      if (!pending && value !== original) onSave(field, value, original)
    } }, [
      field === 'title' ? h('input', { key: 'input', ...input }) : h('textarea', { key: 'input', ...input, rows: 8 }),
      h('div', { key: 'actions', className: 'ghp-m-row' }, [
        h(Button, { key: 'save', type: 'submit', disabled: pending || value === original }, t('sidebar.save')),
        h(Button, { key: 'cancel', onClick: onCancel, disabled: pending }, t('sidebar.cancel')),
      ]),
    ])
  }

  function ChoiceEditor({ field, original, loadChoices, onSave, onCancel, pending }) {
    const [options, setOptions] = useState([])
    const [error, setError] = useState(null)
    const [input, setInput] = useState('')
    const [query, setQuery] = useState('')
    const [selection, setSelection] = useState(original)
    useEffect(() => {
      const controller = new AbortController()
      setError(null)
      loadChoices(query, controller.signal).then(result => {
        if (!controller.signal.aborted) setOptions(result[field === 'milestone' ? 'milestones' : field])
      }, failure => {
        if (!controller.signal.aborted) setError(failure.message)
      })
      return () => controller.abort()
    }, [field, loadChoices, query])
    const toggle = (value) => setSelection(previous => previous.includes(value) ? previous.filter(item => item !== value) : [...previous, value])
    const changed = JSON.stringify(selection) !== JSON.stringify(original)
    const list = field === 'milestone' ? options : [...new Set([...selection, ...options])]
    return h('div', { className: 'ghp-m-form' }, [
      h('form', { key: 'filter', className: 'ghp-m-inline', onSubmit: event => { event.preventDefault(); setQuery(input) } }, [
        h('input', { key: 'input', value: input, 'aria-label': t('sidebar.search'), maxLength: 150, onChange: event => setInput(event.target.value), autoFocus: true }),
        h(Button, { key: 'search', size: 'sm', type: 'submit' }, t('sidebar.search')),
      ]),
      error ? h('p', { key: 'error', role: 'alert' }, error) : null,
      field === 'milestone' ? h('select', { key: 'options', 'aria-label': t('sidebar.milestone'), value: selection ?? '',
        onChange: event => setSelection(event.target.value ? Number(event.target.value) : null) }, [
        h('option', { key: 'none', value: '' }, '—'),
        selection && !list.some(option => option.number === selection) ? h('option', { key: 'current', value: selection }, `#${selection}`) : null,
        ...list.map(({ number, title }) => h('option', { key: number, value: number }, title)),
      ]) : h('div', { key: 'options', className: 'ghp-m-choice-list' }, list.map(value => h('label', { key: value, className: 'ghp-m-row' }, [
        h('input', { key: 'input', type: 'checkbox', checked: selection.includes(value), onChange: () => toggle(value) }), value,
      ]))),
      h('div', { key: 'actions', className: 'ghp-m-row' }, [
        h(Button, { key: 'save', onClick: () => onSave(field, selection, original), disabled: pending || !changed }, t('sidebar.save')),
        h(Button, { key: 'cancel', onClick: onCancel, disabled: pending }, t('sidebar.cancel')),
      ]),
    ])
  }

  function Detail({ selected, item, loading, error, onRetry, onBack, onWrite, onUpdate, loadChoices, fields, writesAllowed, projectWritable, pending }) {
    const [editor, setEditor] = useState(null)
    const [comment, setComment] = useState('')
    const [commentUnknown, setCommentUnknown] = useState(false)
    const [feedback, setFeedback] = useState(null)
    const [confirm, setConfirm] = useState(null)
    const current = item ?? selected
    const canEdit = writesAllowed && !current.inaccessible && (current.type === 'draft' ? projectWritable : item?.canEdit)
    const canComment = writesAllowed && item?.type === 'issue' && !item.inaccessible
    const bodyTooLong = (item?.body?.length ?? 0) > 60_000

    function back() {
      if (!pending && (editor !== null || comment.trim())) setConfirm('leave')
      else if (!pending) onBack()
    }

    function begin(field) {
      if (pending || editor !== null) return
      const original = field === 'milestone' ? item.milestoneNumber : item[field]
      setFeedback(null)
      setEditor({ field, original })
    }

    async function save(field, value, original) {
      setFeedback(null)
      try {
        await onWrite({ action: item.type === 'draft' ? 'edit-draft' : 'edit-issue', itemId: item.id, patch: { [field]: value }, expected: { [field]: original } })
        setEditor(null)
        setConfirm(null)
      } catch (failure) {
        setFeedback(failure.message)
      }
    }

    async function publish(event) {
      event.preventDefault()
      if (!comment.trim() || commentUnknown) return
      setFeedback(null)
      try {
        await onWrite({ action: 'comment', itemId: item.id, text: comment })
        setComment('')
      } catch (failure) {
        const unknown = ['timeout', 'network', 'internal'].includes(failure.code)
        setCommentUnknown(unknown)
        setFeedback(unknown ? t('sidebar.commentUnknown') : failure.message)
      }
    }

    function editButton(field) {
      return h(Button, { key: 'edit', size: 'sm', disabled: pending || editor !== null, onClick: () => begin(field) }, t('sidebar.edit'))
    }

    function metadata(field, value) {
      return h('section', { key: field, className: 'ghp-m-metadata' }, [
        h('div', { key: 'label', className: 'ghp-m-row ghp-m-spread' }, [
          h('strong', { key: 'title' }, t(`sidebar.${field}`)), canEdit && current.type === 'issue' && !item[`${field}Truncated`] ? editButton(field) : null,
        ]),
        editor?.field === field ? h(ChoiceEditor, { key: 'editor', field, original: editor.original, loadChoices, onSave: save,
          onCancel: () => setEditor(null), pending }) : h('p', { key: 'value' }, value || '—'),
      ])
    }

    return h('section', {
      className: 'ghp-m-section ghp-m-detail', 'aria-label': t('sidebar.details'),
      onKeyDown: (event) => {
        if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
        event.preventDefault()
        event.stopPropagation()
        if (confirm) setConfirm(null)
        else back()
      },
    }, [
      h('div', { key: 'back', className: 'ghp-m-row ghp-m-spread' }, [
        h(Button, { key: 'button', type: 'button', size: 'sm', 'data-sidebar-back': '', onClick: back, disabled: pending }, t('sidebar.back')),
        h('span', { key: 'ref', className: 'ghp-m-muted' }, current.repo ? `${current.repo} #${current.number}` : t(`sidebar.kind.${current.type}`)),
      ]),
      error ? h('div', { key: 'error', role: 'alert' }, [error, h(Button, { key: 'retry', size: 'sm', onClick: onRetry }, t('common.refresh'))]) : null,
      feedback ? h('p', { key: 'feedback', role: 'alert' }, feedback) : null,
      confirm === 'leave' ? h('div', { key: 'leave', className: 'ghp-m-notice' }, [
        h('p', { key: 'message' }, t('sidebar.unsaved')),
        h(Button, { key: 'cancel', size: 'sm', onClick: () => setConfirm(null) }, t('sidebar.continue')),
        h(Button, { key: 'confirm', size: 'sm', onClick: onBack }, t('sidebar.discard')),
      ]) : null,
      h('header', { key: 'heading', className: 'ghp-m-row ghp-m-spread' }, [
        editor?.field === 'title' ? h(TextEditor, { key: 'editor', field: 'title', original: editor.original, pending, onSave: save, onCancel: () => setEditor(null) })
          : h('h2', { key: 'title' }, current.title),
        canEdit && editor?.field !== 'title' ? editButton('title') : null,
      ]),
      h('span', { key: 'state', className: 'ghp-m-chip' }, current.state ? t(`sidebar.state.${current.state.toLowerCase()}`) : t(`sidebar.kind.${current.type}`)),
      loading && !item ? h('p', { key: 'loading', role: 'status' }, t('sidebar.loading')) : null,
      item?.inaccessible ? h('p', { key: 'private' }, t('sidebar.restricted')) : null,
      item && !item.inaccessible ? h('div', { key: 'body', className: 'ghp-m-detail-columns' }, [
        h('div', { key: 'timeline', className: 'ghp-m-thread' }, [
          h('article', { key: 'description', className: 'ghp-m-card' }, [
            h('div', { key: 'label', className: 'ghp-m-row ghp-m-spread' }, [
              h('strong', { key: 'name' }, t('sidebar.body')), canEdit && !bodyTooLong && editor?.field !== 'body' ? editButton('body') : null,
            ]),
            bodyTooLong && canEdit ? h('p', { key: 'limit', className: 'ghp-m-muted' }, t('sidebar.bodyTooLong')) : null,
            editor?.field === 'body' ? h(TextEditor, { key: 'editor', field: 'body', original: editor.original, pending, onSave: save, onCancel: () => setEditor(null) })
              : h(Markdown, { key: 'markdown', text: item.body || t('issue.noBody') }),
          ]),
          item.commentCount > item.comments.length ? h('p', { key: 'commentsLimit', className: 'ghp-m-muted' }, t('sidebar.latestComments')) : null,
          ...(item.comments ?? []).map(comment => h('article', { key: comment.id, className: 'ghp-m-card' }, [
            h('strong', { key: 'author' }, comment.author ?? t('issue.ghost')),
            h(Markdown, { key: 'body', text: comment.body }),
          ])),
          canComment ? h('form', { key: 'comment', className: 'ghp-m-form', onSubmit: publish }, [
            h('textarea', { key: 'input', value: comment, maxLength: 60_000, rows: 3, placeholder: t('sidebar.comment'),
              'aria-label': t('sidebar.comment'), onChange: event => setComment(event.target.value) }),
            h(Button, { key: 'publish', type: 'submit', disabled: pending || !comment.trim() || commentUnknown }, t('sidebar.publish')),
            commentUnknown ? h(Button, { key: 'check', onClick: onRetry }, t('common.refresh')) : null,
            commentUnknown && !loading ? h(Button, { key: 'unlock', onClick: () => setCommentUnknown(false) }, t('sidebar.commentReviewed')) : null,
          ]) : null,
          writesAllowed && item.canChangeState && confirm !== 'state' ? h(Button, { key: 'state', disabled: pending, size: 'sm', onClick: () => setConfirm('state') }, t(item.state === 'CLOSED' ? 'sidebar.reopen' : 'sidebar.closeIssue')) : null,
          confirm === 'state' ? h('div', { key: 'request', className: 'ghp-m-row' }, [
            h(Button, { key: 'confirm', disabled: pending, onClick: () => {
              const before = item.state.toLowerCase()
              void save('state', before === 'closed' ? 'open' : 'closed', before)
            } }, t(item.state === 'CLOSED' ? 'sidebar.reopen' : 'sidebar.closeIssue')),
            h(Button, { key: 'cancel', disabled: pending, onClick: () => setConfirm(null) }, t('sidebar.cancel')),
          ]) : null,
        ]),
        h('aside', { key: 'fields', className: 'ghp-m-fields' }, [
          metadata('assignees', item.assignees.join(', ')),
          item.type !== 'draft' ? metadata('labels', item.labels.join(', ')) : null,
          item.type !== 'draft' ? metadata('milestone', item.milestone) : null,
          ...fields.filter(writableField).map(field => h('label', { key: field.id, className: 'ghp-m-metadata' }, [
            h('strong', { key: 'name' }, field.name),
            h(FieldControl, { key: 'control', item, field, allowed: projectWritable, pending, onUpdate }),
          ])),
        ]),
      ]) : null,
    ])
  }

  return Detail
}
