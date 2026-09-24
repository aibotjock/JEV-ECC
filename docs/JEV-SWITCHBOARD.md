# JEV Capability Switchboard

Per routing event, the Jev decision model (TypeSafe AI "System One") estimates a relevance
probability for every regulated ECC capability — skills, MCPs, and tools — and a deterministic
threshold controller decides **ON / KEEP / OFF** per capability. Hard rules can **LOCK** a
capability beyond Jev's reach. Default state is OFF for regulated capabilities. The host agent
loop is untouched: ECC decides who works; JEV decides which capabilities are available to them.

Optimization order: Quality → Reliability → Speed → Cost → Simplicity.

## Non-goals (v1)

- No agent selection/spawning/termination/delegation/iteration control. No model routing.
- No new scheduler. No changes to existing hook scripts' behavior.
- No install-time skill-dir materialization or MCP config rewriting (v2 candidates).
- No regulation of core host tools (Bash, Read, Edit…) unless an overlay entry opts a tool in.

## Architecture

```
routing event (hook, <200ms, no network)
  UserPromptSubmit ──┐
  Stop ──────────────┼─► spawn detached evaluator ──► Jev POST /v1/systemone (batched noul)
  PostToolUseFailure ┘        (one call, all capabilities, model pinned jev-1.13.0)
                                     │ probabilities
                                     ▼
                          deterministic controller (pure)
                          hysteresis + hard rules + deps/conflicts
                                     │ states ON/OFF/LOCKED
                                     ▼
                     per-session state file (atomic write)
                                     │ read per invocation
  PreToolUse gates (Skill / mcp__.* / opted-in tools) ── deny OFF capabilities
  telemetry.jsonl (append-only, separate from policy)
```

The Jev HTTP call never runs inside a hook process (repo rule: blocking hooks <200ms, no
network). Sync hooks spawn a detached evaluator (`spawn(..., {detached:true,
stdio:'ignore'}).unref()` — established ECC pattern) and exit immediately. Gates read the
cached decision file, mirroring the `ecc/setup.json` re-read-per-invocation channel.

## Components (scripts/lib/jev-switchboard/)

### config.js
`loadJevConfig(env)` → `{enabled, apiKey, baseUrl, model, activationThreshold,
deactivationThreshold, timeoutMs, maxRetries, registryPath, stateDir, telemetryPath}`.
Precedence: `ECC_JEV_*` env > managed `ecc/setup.json` `.jevSwitchboard` > defaults.
Defaults: `enabled=true`, `model='jev-1.13.0'` (never `jev-latest`; aliases drift silently),
`baseUrl='https://api.typesafe.ai'`, `activationThreshold=0.65`, `deactivationThreshold=0.35`,
`timeoutMs=8000`, `maxRetries=2`. Key from `TYPESAFE_API_KEY`. Missing key → `enabled=false`
(gates pass-through; never break the agent).

### registry.js
One common registry for all capability types; type-specific behavior only at apply time.
`buildRegistry({repoRoot, overlayPath})` derives from source of truth:
- skills: `skills/*/SKILL.md` frontmatter name+description (the entire relevance corpus today)
- MCPs: `scripts/lib/mcp-inventory` canonical output (installed servers across harnesses)
- tools: overlay-declared opt-ins only

Entry: `{id, type: 'skill'|'mcp'|'tool', name, description, positiveTriggers[],
negativeTriggers[], dependencies[], conflicts[], activationThreshold, deactivationThreshold,
lockable, available, source}`. Overlay `config/jev-switchboard-routing.json` supplies
triggers/deps/conflicts/thresholds per capability id + `alwaysLocked` list (security controls:
gateguard, config-protection, mcp-health-check). Capabilities without overlay entries use
defaults. Registry cache written to `<pluginRoot>/ecc/jev-registry.json`; `loadRegistry()`
falls back to live derivation. IDs: `skill:<dir>`, `mcp:<server>`, `tool:<name>`.
Question rendering keeps each capability ≤ ~60 words (292 skills ≈ 12k tokens, well inside
Jev's 64k/request budget).

### jev-client.js
`evaluateCapabilities({state, capabilities, config, fetchImpl})` → `{model, probabilities,
usage, latencyMs}`. One `POST /v1/systemone` with all capabilities as independent `noul`
questions: `{"model","state", questions: {<id>: {type:'noul', instructions}}}` — Bearer auth.
Retry per official policy: statuses 408/429/5xx/connection errors, exponential backoff
500ms→5s, honor `Retry-After`, `maxRetries` attempts. Logs `response.model` every call.
`fetchImpl` injectable; no network in unit tests. Raw `fetch` wrapper (zero new dependencies —
this repo's hooks are dependency-free by design; swap to `@typesafe-ai/sdk` later if wanted).

### question-render.js / task-state.js
`renderQuestion(capability)` → noul instructions from triggers+description (backtick state
refs). `buildTaskState({event, prompt, sessionKey, recentFailures})` → compact JSON:
`{objective, phase, repoContext, activeCapabilities, explicitRequests, failureSignals}` —
capped, no transcript dumps. The routing question is "which capabilities are needed now",
never "how should the task be solved".

### controller.js — PURE
`decide({registry, probabilities, currentStates, hardRules})` → `{states, changes}`.
Bit-for-bit deterministic: no clock, no randomness, iteration in sorted-id order.
LOCKED stays LOCKED. Otherwise: `p >= activationThreshold` → ON; `p <= deactivationThreshold`
→ OFF; between → KEEP. Missing answer → KEEP (never punish on partial response). Then:
dependencies closure (A ON ⇒ B ON with reason `dependency-of:A`), conflicts (both ON ⇒ higher
p wins, tie ⇒ lexicographically smaller id, loser OFF with reason), hard rules last and
overriding. The controller — not Jev — owns every state decision.

### hard-rules.js
`collectHardRules({registry, promptText, config})` → `{locked, forcedOff, passThrough}`:
- kill switch (`ECC_JEV_ENABLED=false` or managed disabled) → passThrough
- explicit user request (word-boundary match of capability name/id in prompt) → LOCKED ON
- `alwaysLocked` security controls → LOCKED ON (JEV cannot disable; only the pre-existing
  `ECC_DISABLED_HOOKS` chain governs those hooks, unchanged)
- unavailable capability → forced OFF

### state.js / telemetry.js
Per-session state file `<ECC_AGENT_DATA_HOME>/ecc/jev-switchboard/state-<sessionKey>.json`
(gateguard pattern; `atomic-write.js`; 0600): `{seq, event, states:{id:{state, lastProbability,
lastEvent, changedAtSeq}}}`. No hot-path history. Audit rows to the SQLite store are
best-effort, never blocking. Telemetry: append-only
`~/.claude/ecc/jev-switchboard/telemetry.jsonl` (event, probabilities, decisions, latency,
model, usage) — strictly separate from policy. `readRecentFailures()` feeds failure signals.

### eval-runner.js
`runEvaluation(taskState, {config, fetchImpl})`: client → controller → atomic state write →
telemetry append. Serializes via O_EXCL lockfile (newest prompt wins); exits 0 always —
nothing thrown across the hook boundary. **Failure policy:** eval error after retries → KEEP
current states (fail-hold); no state file ever written → gates pass-through (fail-open on
never-evaluated). Gates deny only what a successful evaluation or hard rule has turned OFF.

## Appliers (v1 — all existing ECC seams)

- `scripts/hooks/jev-gate.js` — PreToolUse, registered under matcher `Skill` and matcher
  `.*`; reads state file, denies OFF capabilities via the gateguard deny pattern. `.*` path
  inspects tool name: `mcp__<server>__*` → server capability; opted-in tool names only; else
  immediate exit 0. Core host tools never regulated in v1 (quality floor).
- Detached re-evaluation hooks: `jev-route.js` (UserPromptSubmit), `jev-reeval.js` (Stop),
  `jev-failure-reeval.js` (PostToolUseFailure with failure signal).
- Wiring through `run-with-flags.js` with hook ids
  `user-prompt:jev-route`, `pre:skill:jev-gate`, `pre:tool:jev-gate`, `stop:jev-reeval`,
  `post-failure:jev-reeval`; fingerprints refreshed via `validate-hooks.js
  --update-fingerprints`. `UserPromptSubmit` is schema-valid (`VALID_EVENTS`) though unused
  today.
- One strictly-necessary compatibility fix: register the existing `skill-run-tracker.js` on
  `PostToolUse` matcher `Skill` (today it is failure-only wiring, biasing the telemetry the
  router learns from; the script already classifies success payloads).

## CLI

`node scripts/jev-switchboard.js build-registry | eval | status | doctor`.

## Security

Never bypasses permissions, secrets protections, approvals, or availability restrictions.
API key only via env, never committed (`.env` is gitignored; `.env.example` gets a
placeholder). Lockfiles and state files 0600. No new dependencies. Kill switch mirrors the
`hook-flags.js` precedence chain.

## Testing

Zero-framework per repo convention: standalone `.test.js`, `node:assert`, hand-rolled
`test()` helper, ending `console.log('Results: Passed: N, Failed: M')` + exit code.
`fetchImpl` injected everywhere; no network, no real key. Controller determinism tested by
repeated-run equality. Full `npm test` must show zero failures beyond the documented
26-failure environment baseline.
