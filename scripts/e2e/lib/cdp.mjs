// Minimal Chrome DevTools Protocol client for the e2e harness.
//
// Node 24 ships a global `WebSocket`, so no dependencies are needed. The client
// follows one page target for its whole lifetime and additionally records
// console errors / uncaught exceptions / failed network requests, which the
// harness uses to fail a run on browser-side regressions.

import { setTimeout as sleep } from 'node:timers/promises'

/** Error raised for a CDP command that Chrome answered with an error. */
export class CdpCommandError extends Error {
  constructor(method, params, error) {
    super(`CDP ${method} failed: ${error?.message ?? JSON.stringify(error)}`)
    this.name = 'CdpCommandError'
    this.method = method
    this.params = params
    this.details = error
  }
}

/** Error raised when an in-page expression throws. */
export class PageEvalError extends Error {
  constructor(expression, exceptionDetails) {
    const description = exceptionDetails?.exception?.description
      ?? exceptionDetails?.text
      ?? JSON.stringify(exceptionDetails)
    super(`evaluate failed: ${description}\n  expression: ${String(expression).slice(0, 500)}`)
    this.name = 'PageEvalError'
    this.exceptionDetails = exceptionDetails
  }
}

export class CdpClient {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    /** @type {{type: string, text: string, url: string|null, line: number|null}[]} */
    this.consoleMessages = []
    /** @type {{text: string, url: string|null, line: number|null}[]} */
    this.exceptions = []
    /** @type {{url: string, errorText: string, method: string|null}[]} */
    this.networkFailures = []
    /** @type {{url: string, status: number, method: string|null}[]} */
    this.httpErrors = []
    /** Plugin API request timings (requestWillBeSent → responseReceived). */
    this.pluginRequests = []
    this.pendingPluginRequests = new Map()
    this.closed = false
    this.pendingPluginRequests = new Map()

    ws.addEventListener('message', event => this.#onMessage(event))
    ws.addEventListener('close', () => {
      this.closed = true
      for (const { reject } of this.pending.values()) {
        reject(new Error('CDP websocket closed'))
      }
      this.pending.clear()
    })
  }

  /**
   * Connect to a page target's debugger websocket URL.
   * @param {string} wsUrl
   * @returns {Promise<CdpClient>}
   */
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout: ${wsUrl}`)), 20_000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener('error', (event) => { clearTimeout(timer); reject(new Error(`CDP connect error: ${event?.message ?? wsUrl}`)) }, { once: true })
    })
    return new CdpClient(ws)
  }

  #onMessage(event) {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new CdpCommandError(pending.method, pending.params, message.error))
      else pending.resolve(message.result)
      return
    }
    this.#onEvent(message)
  }

  #onEvent(message) {
    const { method, params } = message
    if (method === 'Runtime.consoleAPICalled') {
      const type = params.type
      if (type !== 'error' && type !== 'warning' && type !== 'assert') return
      this.consoleMessages.push({
        type,
        text: (params.args ?? []).map(arg => formatRemoteObject(arg)).join(' '),
        url: params.stackTrace?.callFrames?.[0]?.url ?? null,
        line: params.stackTrace?.callFrames?.[0]?.lineNumber ?? null,
      })
      return
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails
      this.exceptions.push({
        text: details?.exception?.description ?? details?.text ?? 'unknown exception',
        url: details?.url ?? details?.stackTrace?.callFrames?.[0]?.url ?? null,
        line: details?.lineNumber ?? null,
      })
      return
    }
    if (method === 'Log.entryAdded') {
      const entry = params.entry
      // Chrome logs failed subresource loads both as Log.entryAdded and as
      // Network.loadingFailed; keep only console-visible JS errors here.
      if (entry?.level === 'error' && entry?.source !== 'network') {
        this.consoleMessages.push({
          type: 'error',
          text: entry.text ?? '',
          url: entry.url ?? null,
          line: entry.lineNumber ?? null,
        })
      }
      return
    }
    if (method === 'Network.requestWillBeSent') {
      const url = params.request?.url ?? ''
      if (url.includes('/plugin/github-projects')) {
        this.pendingPluginRequests.set(params.requestId, { url, method: params.request.method, startedAt: Date.now() })
      }
      return
    }
    if (method === 'Network.loadingFailed') {
      if (params.type === 'Image' || params.type === 'Font' || params.type === 'Stylesheet') return
      this.networkFailures.push({
        url: params.requestId ?? null,
        errorText: params.errorText ?? '',
        method: null,
      })
      return
    }
    if (method === 'Network.responseReceived') {
      const response = params.response
      const tracked = this.pendingPluginRequests.get(params.requestId)
      if (tracked !== undefined) {
        this.pendingPluginRequests.delete(params.requestId)
        this.pluginRequests.push({ url: tracked.url, method: tracked.method, status: response.status, ms: Date.now() - tracked.startedAt })
      }
      if (response.status >= 400) {
        this.httpErrors.push({ url: response.url, status: response.status, method: params.type ?? null, requestId: params.requestId })
      }
    }
  }

  /**
   * Send one CDP command and await its result.
   * @param {string} method
   * @param {object} [params]
   */
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error(`CDP closed before ${method}`))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, params })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** Turn on the domains the harness needs and install the 1280×800 viewport. */
  async enable({ width = 1280, height = 800 } = {}) {
    await Promise.all([
      this.send('Page.enable'),
      this.send('Runtime.enable'),
      this.send('Network.enable'),
      this.send('Log.enable'),
    ])
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true })
  }

  /**
   * Navigate the page and wait for its load event (bounded).
   * @param {string} url
   * @param {{timeoutMs?: number}} [options]
   */
  async navigate(url, { timeoutMs = 60_000 } = {}) {
    const loaded = new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const timer = setInterval(() => {
        if (Date.now() > deadline) {
          clearInterval(timer)
          reject(new Error(`navigation did not finish within ${timeoutMs}ms: ${url}`))
        }
      }, 200)
      const onMessage = (event) => {
        let message
        try { message = JSON.parse(event.data) } catch { return }
        if (message.method === 'Page.loadEventFired') {
          clearInterval(timer)
          this.ws.removeEventListener('message', onMessage)
          resolve()
        }
      }
      this.ws.addEventListener('message', onMessage)
    })
    const result = await this.send('Page.navigate', { url })
    if (result?.errorText !== undefined) {
      throw new Error(`navigation failed (${result.errorText}): ${url}`)
    }
    await loaded
  }

  /**
   * Evaluate an expression in the page's main world and return the value.
   * A rejected promise or a thrown exception becomes a PageEvalError.
   * @param {string} expression
   * @param {{awaitPromise?: boolean, timeoutMs?: number}} [options]
   */
  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    })
    if (result?.exceptionDetails !== undefined) throw new PageEvalError(expression, result.exceptionDetails)
    return result?.result?.value
  }

  /**
   * Poll an in-page boolean until it is truthy.
   * Exceptions thrown while polling are treated as "not ready yet" and retried.
   * @param {string} expression
   * @param {{timeoutMs?: number, intervalMs?: number, label?: string}} [options]
   * @returns {Promise<unknown>} the first truthy value
   */
  async waitFor(expression, { timeoutMs = 30_000, intervalMs = 150, label } = {}) {
    const deadline = Date.now() + timeoutMs
    let lastError = null
    for (;;) {
      try {
        const value = await this.evaluate(`(() => { return (${expression}) })()`)
        if (value) return value
        lastError = null
      } catch (error) {
        lastError = error
      }
      if (Date.now() > deadline) {
        const hint = lastError === null ? `value stayed falsy` : `last error: ${lastError.message.split('\n')[1] ?? lastError.message}`
        throw new Error(`waitFor timed out after ${timeoutMs}ms${label === undefined ? '' : ` (${label})`}: ${hint}`)
      }
      await sleep(intervalMs)
    }
  }

  /** @param {string} file absolute PNG path */
  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }

  /** Console errors and uncaught exceptions observed so far. */
  errors() {
    return {
      consoleErrors: this.consoleMessages.filter(message => message.type === 'error' || message.type === 'assert'),
      consoleWarnings: this.consoleMessages.filter(message => message.type === 'warning'),
      exceptions: this.exceptions,
    }
  }

  close() {
    try { this.ws.close() } catch { /* already closed */ }
  }
}

function formatRemoteObject(arg) {
  if (arg === null || arg === undefined) return String(arg)
  if (arg.type === 'string') return arg.value
  if ('value' in arg) return String(arg.value)
  if (arg.description !== undefined) return arg.description
  return arg.type
}
