# Problem P-002: Session 1c829023 cannot continue (context overflow + compaction deadlock)
- Status: root cause confirmed; recovery path identified; repair/recovery not yet applied (user confirmation pending)
- Created: 2026-10-29 04:21
- Updated: 2026-10-29 04:50
- Objective: Explain why DSH session session-1c829023-04f5-4ea6-ab9e-0095dc59825d stopped accepting turns and define a safe way to make it usable again.
- Symptoms:
  - 2026-10-29 00:53:28 turn 13 ended with `pi-ai detected context overflow for model "gpt-6.1-sol"` (code CONTEXT_WINDOW_EXCEEDED).
  - 04:20:07 user `/compact` failed after 79 s with the same message; UI reported "Compaction could not produce a useful summary".
  - 04:20:31 user switched the session model back to `opencode-go/deepseek-v4.1-flash` (declared 1M window); the queued "继续" turn 14 still started with a failing compaction and was aborted by the user at 04:21:29.
  - Every step of turns 12 and 13 wasted ~80-100 s in a compaction attempt that always failed with the same overflow message.
- Expected behavior:
  - A completed model response whose provider accepted the prompt must not be reported as a context overflow because of a stale declared window.
  - Context-overflow recovery compaction must be able to shrink a surface that is larger than the routed model's window (chunked summarization or a summarizer with enough capacity).
  - Switching to a model with a larger declared window must make the next turn usable.
- Actual behavior:
  - Declared window for `openai-codex/gpt-6.1-sol` is 272000 while the route demonstrably accepts ~401k-token prompts; DSH's "silent overflow" heuristic therefore misclassifies successful `stop` responses as CONTEXT_WINDOW_EXCEEDED.
  - Overflow recovery summarizes the whole surface in ONE call to the same 272k-declared routed model, whose successful summary response is then misclassified the same way, so compaction can never succeed.
  - Compaction resolves its target from the last routed request header, so a UI model switch does not change compaction behavior until a new request succeeds; the session is locked to the old model's window.
- Impact:
  - Session `session-1c829023` (plugin development history for this repo) is unusable; user cannot continue or compact it. Same deadlock will hit any session whose usage exceeds the declared window of the routed model (notably after switching to `gpt-6.1-sol`).
- Reproduction:
  - On a session with surface > 272000 tokens, select `openai-codex/gpt-6.1-sol`, then send any message; every step attempts a failing whole-surface compaction (~90 s) and a final `stop` response errors with the fallback overflow message.
- Environment:
  - macOS, DeepSeek Harness Desktop 2 (installed app.asar, dsh packages inside `Resources/app.asar`), profile `~/.dsh/profiles/desktop`.
  - Profile `llm-pi-ai` providers: `openai-codex: {}` (built-in pi-ai catalog), `opencode-go` with `deepseek-v4.1-flash` declared `contextWindow: 1000000`, `maxTokens: 384000`.
  - Session model selection at failure time: `openai-codex/gpt-6.1-sol` (medium), switched from `commandcode/deepseek-v4.1-flash` at 00:18:11.
- Known facts:
  - E-001..E-011 (see below).
- Ruled out:
  - Plugin reinstall/profile reload at 04:19-04:20 as the cause (H-004 refuted).
  - A provider-side hard context limit as the only cause (H-005 refuted: error text is the pi-ai fallback with no provider errorMessage, and 399k-401k-token prompts were accepted successfully).
- Fix criteria:
  - Session accepts a new turn (assistant/message recorded), a subsequent `/compact` completes with a `compaction/end` without `error`, and the surface shrinks to a checkpoint; no CONTEXT_WINDOW_EXCEEDED misclassification on `stop` responses under the declared window.
- Current conclusion: The session crossed the declared 272k window of `openai-codex/gpt-6.1-sol` while it already held ~361k tokens; from then on DSH (a) misclassifies successful final responses as overflow and (b) deadlocks its own recovery compaction because compaction summarizes the whole surface with that same under-declared model, and (c) cannot be rescued by switching models because compaction targets the last routed request header. Recovery requires one turn on a model whose declared window exceeds the surface (already selected: opencode-go/deepseek-v4.1-flash, 1M), accepting one harmless ~90 s failing pre-step compaction, then `/compact` on the new routed target.
- Related hypotheses:
  - H-001, H-002, H-003
- Resolution basis:
  - not satisfied
- Close reason:
  - not closed

## Hypothesis H-001: Declared 272k window misclassifies successful gpt-6.1-sol responses as overflow
- Status: confirmed
- Parent: P-002
- Claim: The installed pi-ai catalog declares `openai-codex/gpt-6.1-sol` as contextWindow 272000/maxTokens 128000; DSH classifies any successful `stop` response whose input+cacheRead exceeds that window as CONTEXT_WINDOW_EXCEEDED, discarding a response the provider actually produced.
- Layer: root-cause
- Factor relation: single
- Depends on:
  - none
- Rationale:
  - The session was already 361440 tokens before the model switch at 00:18:11; later successful responses used 385k-401k tokens; the final turn error carries the pi-ai fallback message, which only appears when no provider errorMessage exists.
- Falsifiable predictions:
  - If true: successful assistant messages with usage > 272000 appear while on gpt-6.1-sol; the failing turn error has no provider text; the pi-ai catalog entry says 272000; other providers' catalogs for the same model list 1050000.
  - If false: either the catalog would show a >=400k window, or failing responses would carry a provider error message, or no successful >272k responses would exist.
- Diagnostic evidence plan:
  - Prediction or clause under test: catalog value + overflow heuristic + successful >272k responses.
  - Signal: session log usage records, request/context events, pi-ai catalog JSON, pi-ai overflow.js.
  - Capture method: decompress session log and read asar-extracted pi-ai sources.
  - Event name or marker: `assistant/message` usage, `request/context`, `turn/end.reason.error.code`.
  - Correlation keys: session id, turn/step, timestamps.
  - Differentiates from: H-005 (provider hard limit).
  - Supports if: catalog 272000, request/context 272000, successful usage >272k, fallback error text.
  - Refutes if: catalog >=400k or provider error text present.
  - Instrumentation status: none
  - Instrumentation lifecycle: none
- Evidence gate: satisfied
- Related evidence:
  - E-001, E-002, E-003, E-004, E-010
- Conclusion: confirmed
- Repair design readiness: ready
- Next step: user decision on recovery/bug report
- Blocker:
  - none
- Close reason:
  - not closed

## Hypothesis H-002: Overflow-recovery compaction self-deadlocks
- Status: confirmed
- Parent: P-002
- Claim: On CONTEXT_WINDOW_EXCEEDED, `compaction-basic` prunes tool results, then selects the whole compactable surface (retainTokens=0 for the overflow trigger) and summarizes it in one direct LLM call to the routed model; when the surface exceeds that model's declared window the summary response is itself classified as overflow, so every compaction attempt fails and the surface never shrinks.
- Layer: root-cause
- Factor relation: single
- Depends on:
  - H-001
- Rationale:
  - All 18 automatic compaction attempts in turns 12-13 and the manual `/compact` at 04:20:07 failed with the identical fallback overflow message after ~80-100 s; the only summarizer target available was the routed 272k model.
- Falsifiable predictions:
  - If true: compaction/start+end pairs all carry the overflow error; no `compaction/summary` is committed after the switch; the summary request size tracks the whole surface.
  - If false: some compaction would succeed and shrink the surface, or the failure would name a different stage/error.
- Diagnostic evidence plan:
  - Prediction or clause under test: whole-surface summarization + routed summarizer target.
  - Signal: `compaction/*` events, compaction-basic source, token math.
  - Capture method: session log + asar-extracted source read.
  - Event name or marker: `compaction/start`, `compaction/end`, `command/done`.
  - Correlation keys: compactionId, turn, session id.
  - Differentiates from: H-003 (stale target only) — H-002 is the self-deadlock; both must hold.
  - Supports if: every attempt fails with the same overflow message and no shrink.
  - Refutes if: a compaction succeeds while the surface > window.
  - Instrumentation status: none
  - Instrumentation lifecycle: none
- Evidence gate: satisfied
- Related evidence:
  - E-005, E-006
- Conclusion: confirmed
- Repair design readiness: ready
- Next step: recovery on a larger-window routed model; DSH bug report optional
- Blocker:
  - none
- Close reason:
  - not closed

## Hypothesis H-003: Compaction target is the last routed request header, so a model switch cannot rescue the session
- Status: confirmed
- Parent: P-002
- Claim: `routedTarget(session)` returns `session.requestHeader()?.config` (last durable `request/header`), and `summarizeWithLlm` prefers that over the agent's current selection, so after switching to a 1M model the next pre-step compaction still uses gpt-6.1-sol (272k) and fails.
- Layer: root-cause
- Factor relation: single
- Depends on:
  - none
- Rationale:
  - `model/selection` to opencode-go/deepseek-v4.1-flash at 04:20:31/04:20:34, but the last `request/header` in the log is from 00:48:26 (gpt-6.1-sol); turn 14's pre-step compaction therefore still ran against the old target.
- Falsifiable predictions:
  - If true: no request/header event after the model selection; compaction-basic source resolves target from requestHeader; turn 14 pre-step compaction fails/stalls.
  - If false: a new request/header with deepseek would exist before the compaction, or compaction would use agent.options.
- Diagnostic evidence plan:
  - Prediction or clause under test: target resolution order.
  - Signal: `request/header` timeline + compaction-basic source.
  - Capture method: session log + source read.
  - Event name or marker: `model/selection`, `request/header`, `compaction/start`.
  - Correlation keys: session id, timestamps.
  - Differentiates from: H-002.
  - Supports if: stale header + source path confirmed.
  - Refutes if: compaction source prefers agent selection.
  - Instrumentation status: none
  - Instrumentation lifecycle: none
- Evidence gate: satisfied
- Related evidence:
  - E-007, E-009
- Conclusion: confirmed
- Repair design readiness: ready
- Next step: recovery accepts one failing pre-step compaction on the stale target, then a successful request updates the header
- Blocker:
  - none
- Close reason:
  - not closed

## Hypothesis H-004: The 04:19-04:20 plugin reload caused the failure
- Status: refuted
- Parent: P-002
- Claim: The local plugin reinstall/profile reload at 04:19-04:20 broke the session.
- Layer: environment
- Factor relation: unknown
- Depends on:
  - none
- Rationale:
  - Initial suspicion because the reload happened minutes before the user reported the session problem.
- Falsifiable predictions:
  - If true: the session would work before the reload and fail only after it.
  - If false: the failure predates the reload by hours.
- Diagnostic evidence plan:
  - Prediction or clause under test: failure start time.
  - Signal: session log timestamps.
  - Capture method: decompress log.
  - Event name or marker: `turn/end`, `compaction/end`, `workspace/changes`.
  - Correlation keys: session id, timestamps.
  - Differentiates from: H-001/H-002.
  - Supports if: first failure after 04:19.
  - Refutes if: first overflow failure at 00:20-00:53.
  - Instrumentation status: none
  - Instrumentation lifecycle: none
- Evidence gate: satisfied
- Related evidence:
  - E-006
- Conclusion: refuted
- Repair design readiness: not applicable
- Next step: none
- Blocker:
  - none
- Close reason:
  - superseded by H-001/H-002

## Hypothesis H-005: The provider's real context limit was reached
- Status: refuted
- Parent: P-002
- Claim: The turn-13 failure was a genuine provider context-limit error, not a harness misclassification.
- Layer: root-cause
- Factor relation: unknown
- Depends on:
  - none
- Rationale:
  - Alternative explanation for `CONTEXT_WINDOW_EXCEEDED`.
- Falsifiable predictions:
  - If true: the failing response would carry a provider error message matching an overflow pattern, and prompts near the limit would fail.
  - If false: the error is the pi-ai fallback (`errorMessage` undefined) and successful responses exist at ~401k.
- Diagnostic evidence plan:
  - Prediction or clause under test: presence of provider error text.
  - Signal: `turn/end` error message + successful usage records.
  - Capture method: session log.
  - Event name or marker: `turn/end.reason.error.message`.
  - Correlation keys: session id, timestamps.
  - Differentiates from: H-001.
  - Supports if: provider error text present.
  - Refutes if: fallback message only and successful >400k responses exist.
  - Instrumentation status: none
  - Instrumentation lifecycle: none
- Evidence gate: satisfied
- Related evidence:
  - E-001, E-006
- Conclusion: refuted
- Repair design readiness: not applicable
- Next step: none
- Blocker:
  - none
- Close reason:
  - superseded by H-001

## Evidence E-001: Token usage crossed the declared window before the model switch
- Related hypotheses:
  - H-001, H-005
- Direction: supports
- Type: observation
- Source: decompressed `~/.dsh/sessions/--Volumes-inwolf-4T-projects-other--/session-1c829023-04f5-4ea6-ab9e-0095dc59825d/session.v4.jsonl.zstd`
- Prediction or plan link:
  - H-001: successful assistant messages with usage > 272000 while on gpt-6.1-sol.
- Matched signal:
  - 00:06:22 turn 11 step 14 total 361440 (before switch); 00:18:53 turn 12 step 1 total 395789; 00:44:58 turn 13 step 8 total 400104 (input 2954 + cacheRead 396800); 00:50:19 turn 13 step 11 total 401564 (input 193 + cacheRead 400896); 00:53:28 turn/end 13 error.
- Correlation keys:
  - session-1c829023, turns 11-13
- Raw content:
  ```text
  00:06:22 turn 11 step 14 total 361440
  00:18:11 MODEL {"provider":"openai-codex","model":"gpt-6.1-sol"}
  00:18:53 turn 12 step 1 total 395789
  00:44:58 turn 13 step 8 total 400104 in 2954 cache 396800
  00:50:19 turn 13 step 11 total 401564 in 193 cache 400896
  00:53:28 turn/end 13 error pi-ai detected context overflow for model "gpt-6.1-sol"
  ```
- Interpretation: The session was already above 272k when the model was switched; the route kept accepting ~400k prompts, so the declared window is the trigger, not a hard provider limit.
- Time: 2026-10-29 04:45

## Evidence E-002: Resolved context window for gpt-6.1-sol is 272000
- Related hypotheses:
  - H-001
- Direction: supports
- Type: runtime state
- Source: `request/context` events in the same session log
- Prediction or plan link:
  - H-001: DSH resolves contextWindow=272000 for this route.
- Matched signal:
  - `{"provider":"openai-codex","model":"gpt-6.1-sol","contextWindow":272000,"systemPromptUpdate":"in-history"}`
- Correlation keys:
  - session-1c829023, 00:18:53 / 00:31:46
- Raw content:
  ```text
  {"provider":"openai-codex","model":"gpt-6.1-sol","contextWindow":272000,"systemPromptUpdate":"in-history"}
  ```
- Interpretation: The harness compares usage against 272000 for every gpt-6.1-sol request.
- Time: 2026-10-29 04:45

## Evidence E-003: Installed pi-ai catalog under-declares the codex route
- Related hypotheses:
  - H-001
- Direction: supports
- Type: config
- Source: asar-extracted `@earendil-works/pi-ai/dist/providers/data/openai-codex.json` vs other provider catalogs
- Prediction or plan link:
  - H-001: catalog value is 272000 for openai-codex, while sibling providers declare 1050000.
- Matched signal:
  - `openai-codex.json` -> `chat:gpt-6.1-sol` contextWindow 272000, maxTokens 128000; `openrouter.json`, `opencode.json`, `github-copilot.json`, `vercel-ai-gateway.json` -> same model contextWindow 1050000.
- Correlation keys:
  - provider=openai-codex, model=gpt-6.1-sol
- Raw content:
  ```text
  openai-codex.json  chat:gpt-6.1-sol  contextWindow=272000 maxTokens=128000 api=openai-codex-responses
  openrouter.json    chat:openai/gpt-6.1-sol  contextWindow=1050000
  opencode.json      chat:gpt-6.1-sol         contextWindow=1050000
  ```
- Interpretation: The 272k figure is provider-catalog data, not a limit the backend enforced in this session.
- Time: 2026-10-29 04:45

## Evidence E-004: pi-ai silent-overflow heuristic converts a successful stop into overflow
- Related hypotheses:
  - H-001
- Direction: supports
- Type: code-location
- Source: asar-extracted `@earendil-works/pi-ai/dist/utils/overflow.js` (Case 2)
- Prediction or plan link:
  - H-001: successful `stop` with input+cacheRead > contextWindow returns true.
- Matched signal:
  ```js
  if (contextWindow && message.stopReason === "stop") {
      const inputTokens = message.usage.input + message.usage.cacheRead;
      if (inputTokens > contextWindow) return true;
  }
  ```
- Correlation keys:
  - none
- Interpretation: Any final answer (stop) produced while on gpt-6.1-sol with usage > 272k is discarded and surfaced as CONTEXT_WINDOW_EXCEEDED; tool-use stops are unaffected, which explains why turns 12-13 limped step-by-step and only failed on final answers.
- Time: 2026-10-29 04:45

## Evidence E-005: Overflow compaction summarizes the whole surface with the routed target
- Related hypotheses:
  - H-002, H-003
- Direction: supports
- Type: code-location
- Source: asar-extracted `@deepseek-ai/dsh-compaction-basic/lib/index.js`
- Prediction or plan link:
  - H-002: overflow trigger selects the whole surface (retainTokens 0); H-003: summarizer target resolves from requestHeader.
- Matched signal:
  - `compactIfNeeded(..., "context-overflow")`: `prune.pruneSession`, `selectCompactableRange(agent.session, measurement, 0)`; `selectCompactableRange` keeps from first surface node to the last one when retainTokens=0; `summarizeWithLlm` uses `conversationTarget(agent)` which returns `routedTarget(agent.session)` = `session.requestHeader()?.config`.
- Correlation keys:
  - none
- Interpretation: The summarization request contains essentially the whole 400k-token surface and is sent to the 272k-declared model; its successful summary (a `stop`) is then classified as overflow by E-004, so compaction aborts.
- Time: 2026-10-29 04:45

## Evidence E-006: All automatic and manual compactions failed with the same fallback overflow message
- Related hypotheses:
  - H-002, H-004
- Direction: supports
- Type: reproduction
- Source: session log `compaction/start`, `compaction/end`, `command/done`
- Prediction or plan link:
  - H-002: no compaction succeeds; H-004: failure predates the 04:19-04:20 plugin reload.
- Matched signal:
  - 20 compaction attempts: 18 failed with `pi-ai detected context overflow for model "gpt-6.1-sol"` (first at 00:20:23, last manual `/compact` at 04:21:26); turn 14 attempt errored `[object Object]` when aborted. Each automatic attempt took ~80-100 s.
- Correlation keys:
  - session-1c829023, compactionIds 80aa6f02, ae9fa6c5, 7d52c091, c54738f9, e5f34fad, bb0a5145, 68d9a80f, 9775737e, 5e8545dc, 3d2a6bd8, a91cbc68, a0ff5944, 579eddc3, ae77ab3a, 7409bc3d, d8751ca9, 5a6f6167, 37fe882d, 2fc22053
- Raw content:
  ```text
  10-29 00:20:23 compaction/end turn 12 80aa6f02 err pi-ai detected context overflow for model "gpt-6.1-sol"
  ...
  10-29 04:21:26 compaction/end turn None 37fe882d err pi-ai detected context overflow for model "gpt-6.1-sol"
  10-29 04:21:29 compaction/end turn 14 2fc22053 err [object Object]
  ```
- Interpretation: The session cannot shrink itself; the failures started at 00:20, ~3.5 h before the plugin reload, so the reload is not the cause.
- Time: 2026-10-29 04:45

## Evidence E-007: Model switch did not change the routed header
- Related hypotheses:
  - H-003
- Direction: supports
- Type: observation
- Source: session log `model/selection` / `request/header` events
- Prediction or plan link:
  - H-003: no request/header after the switch.
- Matched signal:
  - `04:20:31 MODEL {"provider":"opencode-go","model":"deepseek-v4.1-flash"}` and `04:20:34 ... reasoningEffort max`; last `request/header` before that is at 00:48:26 with gpt-6.1-sol.
- Correlation keys:
  - session-1c829023
- Raw content:
  ```text
  00:48:26 request/header {provider: openai-codex, model: gpt-6.1-sol}
  04:20:31 model/selection {provider: opencode-go, model: deepseek-v4.1-flash}
  04:20:34 model/selection {provider: opencode-go, model: deepseek-v4.1-flash, reasoningEffort: max}
  ```
- Interpretation: Compaction on the next turn still targets gpt-6.1-sol (272k), so switching models cannot immediately rescue the session.
- Time: 2026-10-29 04:45

## Evidence E-008: Abort path renders "[object Object]"
- Related hypotheses:
  - H-002
- Direction: neutral
- Type: observation
- Source: session log compaction/end
- Prediction or plan link:
  - H-002: secondary error-rendering defect.
- Matched signal:
  - `{"compactionId":"2fc22053-...","turn":14,"error":"[object Object]"}` at the same millisecond as `turn/end {reason:{kind:"aborted",reason:{kind:"user"}}}`.
- Correlation keys:
  - session-1c829023, 04:21:29
- Raw content:
  ```text
  {"type":"compaction/end","seq":5799,"time":1793218889975,"data":{"compactionId":"2fc22053-2cb7-4c0c-b13d-a9cbc38fecda","turn":14,"error":"[object Object]"}}
  {"type":"turn/end","seq":5800,"time":1793218889975,"data":{"turn":14,"reason":{"kind":"aborted","reason":{"kind":"user"}}}}
  ```
- Interpretation: Cosmetic bug: a plain-object abort/failure value is stringified by `errorChain` into "[object Object]"; it is not the root cause.
- Time: 2026-10-29 04:45

## Evidence E-009: Recovery path — a 1M routed target passes the pre-step compaction and the request
- Related hypotheses:
  - H-002, H-003
- Direction: supports
- Type: code-location
- Source: asar-extracted `dsh-compaction-basic` (`agent/pre-step` catch) and `dsh-compaction-basic` `resolveCompactSpec` defaults
- Prediction or plan link:
  - Recovery: with routed target deepseek-v4.1-flash (1M, maxTokens 384000), threshold = min(800000, 1000000-384000-65536) = 550464 > 401k, so no pressure compaction; and pre-step compaction failures are swallowed (`logger.warn(...); return next()`), so a failing stale-target compaction does not abort the turn.
- Matched signal:
  - `ctx.on("agent/pre-step", ...)`: `catch { ... ctx.logger.warn(...); } return next();`
- Correlation keys:
  - none
- Interpretation: One message on the already-selected 1M model will survive one ~90 s stale-target compaction failure and then run the request; the successful response updates requestHeader to deepseek, after which `/compact` works.
- Time: 2026-10-29 04:50

## Evidence E-010: Profile declares 1M for the recovery model
- Related hypotheses:
  - H-001
- Direction: supports
- Type: config
- Source: `~/.dsh/profiles/desktop/cordis.patch.yml`
- Prediction or plan link:
  - H-001: the alternative routed model has a declared window above the surface.
- Matched signal:
  - `opencode-go.models[deepseek-v4.1-flash]: contextWindow: 1000000, maxTokens: 384000`; `agent-default-model: opencode-go/deepseek-v4.1-flash`.
- Correlation keys:
  - profile=desktop
- Raw content:
  ```yaml
  - id: agent-default-model
    config: { provider: opencode-go, model: deepseek-v4.1-flash, reasoningEffort: max }
  - id: llm-pi-ai
    config:
      providers:
        opencode-go:
          models:
            - id: deepseek-v4.1-flash
              contextWindow: 1000000
              maxTokens: 384000
        openai-codex: {}
  ```
- Interpretation: The recovery target's declared capacity is 1M, so the 401k surface is inside it; `openai-codex: {}` leaves the built-in 272k catalog in force.
- Time: 2026-10-29 04:45

## Evidence E-011: Session state unchanged after the failure
- Related hypotheses:
  - H-002
- Direction: neutral
- Type: observation
- Source: session file mtime/size and tail events
- Prediction or plan link:
  - Recovery precondition: no new turns were attempted.
- Matched signal:
  - `session.v4.jsonl.zstd` size 4697016, mtime 04:21; last events are turn 14 abort; no unmatched compaction start.
- Correlation keys:
  - session-1c829023
- Raw content:
  ```text
  -rw------- 1 zhangxu staff 4697016 Oct 29 04:21 session.v4.jsonl.zstd
  {"type":"compaction/end","seq":5799,...,"error":"[object Object]"}
  {"type":"turn/end","seq":5800,...,"reason":{"kind":"aborted","reason":{"kind":"user"}}}
  ```
- Interpretation: The session is idle and its last compaction is closed (matched start/end), so the recovery turn will not hit `assertNoActiveCompaction`.
- Time: 2026-10-29 04:50
