// Minimal local Anthropic-Messages-compatible model endpoint for the e2e harness.
//
// The plugin views only render inside a non-blank conversation, and a fresh
// isolated DSH profile has no DeepSeek credentials. Pointing the official
// provider route at this loopback server (DEEPSEEK_API_KEY + DEEPSEEK_BASE_URL)
// lets the harness start a real turn offline: one user message in, one short
// assistant reply out, no network call and no credentials.

import { createServer } from 'node:http'

const REPLY_TEXT = 'e2e: mock assistant reply.'

/**
 * Start the mock endpoint on a free loopback port.
 * @param {{text?: string}} [options]
 * @returns {Promise<{port: number, baseUrl: string, close: () => Promise<void>}>}
 */
export async function startMockLlm({ text = REPLY_TEXT } = {}) {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.method !== 'POST' || !String(req.url ?? '').endsWith('/messages')) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { type: 'not_found', message: `mock llm: unknown route ${req.method} ${req.url}` } }))
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      send('message_start', {
        message: {
          id: 'msg_e2e_mock', type: 'message', role: 'assistant', model: 'deepseek-flash',
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      })
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
      send('content_block_stop', { index: 0 })
      send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
      send('message_stop', {})
      res.end()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/anthropic`,
    close: () => new Promise((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error)))),
  }
}
