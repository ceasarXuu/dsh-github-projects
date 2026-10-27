// DSH web UI helpers for the e2e harness.
//
// Selectors are intentionally text/label based (contract labels, aria labels,
// button text) so the harness keeps working while the plugin's markup evolves.
// All helpers operate through CDP `Runtime.evaluate` / `Input.*` commands.

import { setTimeout as sleep } from 'node:timers/promises'

/** CDP selector snippet: only elements that are actually visible. */
const VIS = `(el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }`

/** Evaluate an expression returning a JSON value. */
const evalJson = (cdp, expression) => cdp.evaluate(expression)

/** One snapshot of the visible UI, used for assertions and failure diagnostics. */
export async function collectUi(cdp) {
  return evalJson(cdp, `(() => {
    const vis = ${VIS}
    const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ')
    const attr = (el, name) => el.getAttribute(name)
    const buttons = [...document.querySelectorAll('button,[role=button],a')].filter(vis)
    const tabs = [...document.querySelectorAll('[data-conversation-tabs] button[role=tab], button[role=tab]')].filter(vis)
    const ghpNodes = [...document.querySelectorAll('[class*="ghp-"]')]
    const bodyText = document.body.innerText
    return {
      href: location.href,
      title: document.title,
      bodyText,
      buttons: buttons.map(el => ({
        text: text(el), aria: attr(el, 'aria-label'), disabled: el.disabled === true || attr(el, 'aria-disabled') === 'true',
        cls: String(el.className || '').slice(0, 160),
      })),
      tabs: tabs.map(el => ({
        label: text(el).trim(),
        selected: attr(el, 'aria-selected') === 'true',
        cls: String(el.className || '').slice(0, 160),
      })),
      activeTab: (() => { const el = [...document.querySelectorAll('[data-conversation-tabs] button[role=tab][aria-selected="true"], button[role=tab][aria-selected="true"]')].find(vis); return el === undefined ? null : text(el).trim() })(),
      editables: [...document.querySelectorAll('[contenteditable="true"],[role="textbox"],textarea,input')].filter(vis).map(el => ({
        tag: el.tagName.toLowerCase(), role: attr(el, 'role'), placeholder: el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || null,
        value: el.value ?? null, text: (el.innerText || '').slice(0, 120), cls: String(el.className || '').slice(0, 120),
      })),
      ghp: ghpNodes.map(el => ({ cls: String(el.className || '').slice(0, 160), text: text(el).slice(0, 200) })),
      dialogs: [...document.querySelectorAll('[role="dialog"]')].filter(vis).map(el => ({ text: text(el).slice(0, 400) })),
    }
  })()`)
}

/** Wait until the browser app shell (sidebar + composer) is rendered. */
export async function waitForAppShell(cdp, { timeoutMs = 90_000 } = {}) {
  await cdp.waitFor(`(() => {
    const btns = [...document.querySelectorAll('button')]
    return btns.some(b => b.getAttribute('aria-label') === '新建会话') && document.body.innerText.length > 40
  })()`, { timeoutMs, label: 'app shell' })
}

/**
 * Bring the conversation UI to an interactive state: dismiss the first-use
 * dialogs (preview notice, credentials notice) that can appear a moment after
 * the app shell renders, then wait until the composer is focusable.
 * @returns {Promise<string[]>} descriptions of dismissed dialogs
 */
export async function prepareConversationUi(cdp, { timeoutMs = 45_000 } = {}) {
  const dismissed = []
  const deadline = Date.now() + timeoutMs
  let quietTicks = 0
  while (Date.now() < deadline) {
    const state = await evalJson(cdp, `(() => {
      const vis = ${VIS}
      const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ')
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(vis)
      const dialog = dialogs[dialogs.length - 1]
      if (dialog !== undefined) {
        const buttons = [...dialog.querySelectorAll('button,[role="button"]')].filter(vis)
        const wanted = buttons.find(b => {
          const label = text(b)
          const aria = b.getAttribute('aria-label') || ''
          return ['继续', '关闭', '跳过', '稍后', 'Continue', 'Close', 'Skip', 'Later'].includes(label)
            || ['关闭', 'Close'].includes(aria)
        })
        if (wanted !== undefined) {
          wanted.click()
          return { dialog: text(dialog).slice(0, 120), clicked: text(wanted) || wanted.getAttribute('aria-label') }
        }
        return { dialog: text(dialog).slice(0, 120), clicked: null }
      }
      const composer = [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].find(vis)
      return { dialog: null, composer: composer !== undefined }
    })()`).catch(() => ({ dialog: null, composer: false }))
    if (state.dialog !== null) {
      if (state.clicked === null) throw new Error(`blocking dialog the harness cannot dismiss: ${state.dialog}`)
      dismissed.push(`${state.clicked} (${state.dialog})`)
      quietTicks = 0
      await sleep(450)
      continue
    }
    if (state.composer === true) {
      quietTicks += 1
      if (quietTicks >= 2) return dismissed
    } else {
      quietTicks = 0
    }
    await sleep(200)
  }
  throw new Error(`conversation UI not ready within ${timeoutMs}ms (composer/dialogs did not settle)`)
}

/** Labels of the session header view tabs, in order. */
export async function tabLabels(cdp) {
  return evalJson(cdp, `(() => {
    const vis = ${VIS}
    const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ')
    const scoped = [...document.querySelectorAll('[data-conversation-tabs] button[role="tab"]')].filter(vis)
    const tabs = scoped.length > 0 ? scoped : [...document.querySelectorAll('button[role="tab"]')].filter(vis)
    return tabs.map(el => text(el))
  })()`)
}

/**
 * Click a session header tab by its exact label.
 * @returns {Promise<boolean>} whether a matching tab was found and clicked
 */
export async function clickTab(cdp, label) {
  const clicked = await evalJson(cdp, `(() => {
    const vis = ${VIS}
    const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ')
    const scoped = [...document.querySelectorAll('[data-conversation-tabs] button[role="tab"]')].filter(vis)
    const tabs = scoped.length > 0 ? scoped : [...document.querySelectorAll('button[role="tab"]')].filter(vis)
    const target = tabs.find(el => text(el) === ${JSON.stringify(label)})
    if (target === undefined) return false
    target.click()
    return true
  })()`)
  if (!clicked) return false
  // wait until the tab is marked selected (React state applied)
  await cdp.waitFor(`(() => {
    const el = [...document.querySelectorAll('button[role="tab"][aria-selected="true"]')].find(${VIS})
    return el !== undefined && (el.innerText || '').trim() === ${JSON.stringify(label)}
  })()`, { timeoutMs: 10_000, label: `tab ${label} selected` }).catch(() => {})
  return true
}

/** Click the first visible button matching `text` (exact) or `aria` label. */
export async function clickButton(cdp, { text, aria, contains } = {}) {
  return evalJson(cdp, `(() => {
    const vis = ${VIS}
    const norm = (el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ')
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(vis)
    const target = buttons.find(el => {
      const label = norm(el)
      const ariaLabel = el.getAttribute('aria-label') || ''
      ${text === undefined ? '' : `if (label === ${JSON.stringify(text)}) return true`}
      ${aria === undefined ? '' : `if (ariaLabel === ${JSON.stringify(aria)}) return true`}
      ${contains === undefined ? '' : `if (label.includes(${JSON.stringify(contains)})) return true`}
      return false
    })
    if (target === undefined) return false
    target.click()
    return true
  })()`)
}

/** Clickable element labels, for diagnostics. */
export async function visibleButtonLabels(cdp) {
  return evalJson(cdp, `(() => {
    const vis = ${VIS}
    const norm = (el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ')
    return [...document.querySelectorAll('button,[role="button"]')].filter(vis)
      .map(el => ({ text: norm(el), aria: el.getAttribute('aria-label'), disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' }))
  })()`)
}

/** Wait for an exact text snippet to appear in the page body. */
export async function waitForText(cdp, needle, { timeoutMs = 30_000, label } = {}) {
  await cdp.waitFor(`document.body.innerText.includes(${JSON.stringify(needle)})`, {
    timeoutMs,
    label: label ?? `text ${JSON.stringify(needle)}`,
  })
}

/** Wait for a `ghp-` class name fragment (e.g. 'ghp-empty') to appear. */
export async function waitForGhpClass(cdp, fragment, { timeoutMs = 30_000 } = {}) {
  await cdp.waitFor(`document.querySelector('[class*=${JSON.stringify(fragment)}]') !== null`, {
    timeoutMs,
    label: `class ${fragment}`,
  })
}

/** Focus a contenteditable / input and set its value through the DOM. */
export async function setEditableValue(cdp, { placeholder, selector }, value) {
  return evalJson(cdp, `(() => {
    const vis = ${VIS}
    const els = [...document.querySelectorAll('input,textarea,[contenteditable="true"],[role="textbox"]')].filter(vis)
    const target = ${selector === undefined
      ? `els.find(el => (el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '') === ${JSON.stringify(placeholder ?? '')})`
      : `document.querySelector(${JSON.stringify(selector)})`}
    if (target === undefined || target === null) return false
    target.focus()
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(target, ${JSON.stringify(value)})
      target.dispatchEvent(new Event('input', { bubbles: true }))
      target.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }
    // contenteditable: select all + insertText keeps framework editors happy
    const range = document.createRange()
    range.selectNodeContents(target)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    const ok = document.execCommand('insertText', false, ${JSON.stringify(value)})
    return { ok, text: target.innerText }
  })()`)
}

/**
 * Send one message from the session composer, starting the conversation.
 * A mock LLM (when configured) answers instantly, which turns the blank
 * session into a normal one so the header view tabs render.
 */
export async function sendComposerMessage(cdp, text, { timeoutMs = 30_000 } = {}) {
  const focused = await evalJson(cdp, `(() => {
    const ed = document.querySelector('[contenteditable="true"][role="textbox"]')
    if (ed === null) return false
    ed.focus()
    return document.activeElement === ed
  })()`)
  if (!focused) throw new Error('composer contenteditable is not present/focusable')
  await cdp.send('Input.insertText', { text })
  await sleep(300)
  const typed = await evalJson(cdp, `(() => {
    const ed = document.querySelector('[contenteditable="true"][role="textbox"]')
    return ed === null ? '' : ed.innerText
  })()`)
  if (typed.trim().length === 0) throw new Error(`composer did not accept typed text (insertText)`)

  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })

  // The session header renders its view tabs once the conversation starts.
  await cdp.waitFor(`document.querySelectorAll('[data-conversation-tabs] button[role="tab"], button[role="tab"]').length >= 2`, {
    timeoutMs,
    label: 'conversation view tabs',
  })
}

/** Open the session view for the given session id from the sidebar (fallback path). */
export async function clickSidebarSession(cdp, title) {
  return evalJson(cdp, `(() => {
    const vis = ${VIS}
    const norm = (el) => (el.innerText || el.textContent || '').trim()
    const rows = [...document.querySelectorAll('button,[role="button"],[role="treeitem"]')].filter(vis)
    const target = rows.find(el => norm(el).includes(${JSON.stringify(title)}))
    if (target === undefined) return false
    target.click()
    return true
  })()`)
}

/** Give the UI a moment to finish transitions (React effects, view load, fetch). */
export const settle = (ms = 400) => sleep(ms)
