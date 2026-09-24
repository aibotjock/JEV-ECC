# Gauntlet Progress — JEV Capability Switchboard for ECC

**Loop**: builder → separate fresh-context critic → blind A/B vs the bar → iterate until the critic picks ours. Exit condition is winning the comparison, never a round count.

## Objective
Per routing event, Jev (TypeSafe AI System One model) estimates a relevance probability for every regulated ECC skill / MCP / tool; a deterministic threshold controller with separate activation/deactivation thresholds decides **ON / KEEP / OFF**; hard rules can **LOCK**. Default OFF. Host agent loop untouched. *ECC decides who works; JEV decides which capabilities are available to them.*

## Bar (user-selected)
**aurelio-labs/semantic-router decision layer** (cloned at `~/reference/semantic-router`) — thresholds, route matching semantics, test rigor, latency.

**Measurable half**
- [x] Zero test failures beyond the documented baseline (see Environment baseline — full-suite failure list byte-identical before vs after the switchboard work, verified by name-diff 2026-09-24)
- [x] Controller bit-for-bit deterministic (same inputs → same states; pinned by controller.test.js)
- [x] One batched Jev call covers the whole capability catalog per routing event (live: 297/297 probabilities in a single request)
- [x] p95 routing overhead < 1s (live full-catalog evaluator: 799 ms and 796 ms; hooks: 32 ms / 22 ms, no network)

## Verified environment facts
- Jev endpoint: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`, body `{model, state, questions}`; response `{model, answers:{<name>:{type:"noul", noul:<p>}}, usage}`. Question types: `noul` (yes/no→probability), `choice`, `score`.
- Model IDs: `jev-latest` (resolves `jev-1.13.0`), `jev-1.12`, `jev-preview`.
- Smoke test 2026-09-24: HTTP 200 in 0.50s, 2 questions, 320 in / 40 out tokens, calibrated-looking probabilities (git-skill 0.92 / web-search 0.30 on a git task).
- API key: in `~/ECC/.env` (gitignored) as `TYPESAFE_API_KEY`. Never commit.
- ECC: yarn 4.9.2, node >=18 (v22.23.2 local), deps installed, test = validator chain + `node tests/run-all.js`.

## Pieces & rounds
| # | Piece | Status | Round | Last critic verdict |
|---|-------|--------|-------|---------------------|
| 0 | Recon (ECC subsystems ×8 + Jev docs ×3 + gap-check) | **done** (12/12) | – | verdict: overlay-not-runtime; all integration seams verified |
| 1 | Design doc `docs/JEV-SWITCHBOARD.md` | **done** | – | – |
| 2 | Jev client + config + question render (`scripts/lib/jev-switchboard/`) | **WON r1** | 1 | "decisively better on every judged axis" — 43/43 tests |
| 3 | Capability registry + overlay + CLI build-registry | **WON r1** | 1 | "wins on every judged criterion" — 28/28 tests + validators clean |
| 4 | Threshold controller + hard rules (pure) | **WON r1** | 1 | "implements the full specified contract… bit-for-bit deterministic" — 30/30 tests |
| 5 | Hook wiring + appliers + state/telemetry + eval-runner | **WON r1** | 1 | "A implements the specified system end-to-end and pins it with tests"; bar's mcp-health-check runs HTTP probes in the sync hook path + non-atomic state writes — ours doesn't |
| 6 | Docs/README/.env.example + validator chain + full-suite diff | **done** | – | validators 30 matchers + schema-keys + unicode green; README Guides row + .env.example TYPESAFE_API_KEY; failure list identical to baseline |
| — | Critic-named gap fixes (client/registry/controller) | **done** | – | 17+23+21 tests; full 10-file regression green; eslint clean |
| — | Piece-5 critic gap fixes + live-E2E finds | **done** | – | payload unlink after consume; lock ownership tokens (stolen-lock release refused); bounded stdin in jev-reeval/jev-failure-reeval; absent-answer→KEEP pinned at eval-runner level; ECC_JEV_STATE_DIR/ECC_JEV_REGISTRY_PATH implemented in config.js (was CLI-help-documented but unimplemented on the hook path — found live) |

## Live end-to-end (real key, 2026-09-24)
- Two routing events through the real hook → detached evaluator → Jev `jev-1.13.0`:
  - git prompt: `skill:git-workflow` p=0.88 ON; python/testing prompt: `python-testing` p=0.89, `ai-regression-testing` p=0.83, `python-patterns` p=0.81 ON — task-sensitive, not keyword-stuffing.
  - `skill:gateguard` LOCKED by security policy both runs (alwaysLocked overlay works).
  - 297/297 capabilities scored per event, one batched call, 799/796 ms; hook budget 32/22 ms; 0 eval-errors; state + telemetry landed under the (now honored) `ECC_JEV_STATE_DIR`.
- Test artifacts cleaned from the operator's real `~/.claude/ecc/jev-switchboard/` after the first run (created before the env override existed).

## Environment baseline (measured)
- `yarn test` at HEAD: **exit 1**, 4905 tests, 26–27 failures in 7 files — plan-canvas-e2e,
  claude-scope-migration, codex-hooks, control-pane, install-apply, install-guided, setup
  (all environment-dependent: PTY/browser/venv; the PTY-flaky set wobbles ±1 between runs).
  Measurable half = zero failures beyond this set — verified 2026-09-24 by name-diffing the
  failing-test lists before vs after all switchboard changes (byte-identical).
- Deps installed (yarn 4.9.2). Node v22.23.2.

## Decision log
- 2026-09-24: Bar selected (semantic-router + CI/latency). Recon done. Key secured in `.env`.
  Bar repo cloned. Design written: detached-evaluator architecture (Jev HTTP never in hooks),
  per-call PreToolUse gates as appliers, per-session atomic state (gateguard pattern),
  fail-hold on eval error / pass-through when never evaluated, model pinned `jev-1.13.0`,
  thresholds 0.65/0.35 default, one compatibility fix (success-side skill telemetry wiring).
- Round-1 blind sides: client ours=A, registry ours=B, controller ours=A (critic uninformed).
- 2026-09-24 (piece 5 re-judged after the 429 kill): ours=A, bar=B; critic picked A — "fail-hold verified E2E against a refused port; B runs blocking probes inside the sync hook" — with 4 named gaps, all fixed same round (payload unlink, lock ownership tokens, bounded stdin in both reeval hooks, absent-answer→KEEP coverage).
- 2026-09-24: PUSHED to `git@github.com:aibotjock/JEV-ECC.git` (remote `jev-ecc`, user-directed destination; force-with-lease over the 1-commit scaffold stub 0449d827 with user approval). Remote main = ff461851. `origin` (aibotjock/ECC) untouched.
- Live E2E surfaced one real defect the critics missed: ECC_JEV_STATE_DIR/ECC_JEV_REGISTRY_PATH were documented in CLI help but unimplemented in config.js (hooks wrote to the default dir regardless). Implemented env>default in config.js with tilde expansion + tests; CLI flags remain the strongest override for CLI-owned operations.
