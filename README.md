# JEV-ECC

JEV-ECC is an experimental fork of [ECC](https://github.com/affaan-m/ECC) that adds a Jev-powered capability switchboard for ECC skills, MCP servers, and selected tools.

**Important:** JEV-ECC is not the upstream ECC project, and installing the official `ecc@ecc` plugin or `ecc-universal` package installs upstream ECC, not this fork.

## Relationship to ECC

JEV-ECC is built on top of the earlier open-source ECC project by affaan-m. ECC provides the agent harness, skills, hooks, memory, security controls, and multi-harness support. JEV-ECC preserves that foundation and adds a routing layer that decides which capabilities should be available for the current task.

Upstream project: https://github.com/affaan-m/ECC

This fork: https://github.com/aibotjock/JEV-ECC

JEV-ECC does not claim to replace or supersede upstream ECC. When this README refers to ECC features that were not added by this fork, they remain upstream ECC capabilities.

## What JEV-ECC Adds

The JEV capability switchboard uses TypeSafe AI's Jev model to estimate the relevance probability of regulated capabilities for the current task.

For each routing event:

1. ECC receives the user task normally.
2. A lightweight hook launches a detached evaluator.
3. The evaluator sends the current task state and capability catalog to Jev in one batched request.
4. Jev returns a relevance probability for each regulated capability.
5. A deterministic controller converts those probabilities into `ON`, `KEEP`, `OFF`, or `LOCKED` states.
6. Pre-tool-use gates allow or deny regulated skills, MCPs, and opted-in tools based on the cached state.

The host agent loop is intentionally left alone. JEV does not choose agents, control iteration, terminate agents, or route between language models.

**Design rule:** ECC decides who works; JEV decides which regulated capabilities are available to them.

See [docs/JEV-SWITCHBOARD.md](docs/JEV-SWITCHBOARD.md) for the full architecture.

## Current Status

The v1 switchboard is implemented and has dedicated tests for configuration, registry construction, Jev API handling, routing questions, task state, deterministic control, hard rules, state persistence, telemetry, hooks, CLI commands, and calibration.

Recorded live testing in this repository includes:

- real Jev API calls,
- full-catalog evaluation of roughly 297 capabilities in one request,
- task-sensitive capability activation,
- security capabilities remaining locked by policy,
- real Claude Code hook execution in an isolated harness,
- manual gate deny/pass testing,
- CLI `doctor`, `build-registry`, `eval`, `status`, and `calibrate` testing.

The project is still experimental. The following have **not yet been established at production scale**:

- measurable coding-quality improvement,
- measurable token reduction,
- measurable total cost reduction,
- measurable end-to-end speed improvement,
- lower task-failure rate,
- optimal routing thresholds,
- long-term unattended production reliability.

These are validation targets, not current claims.

## Installation for Testing

### Do not use the upstream ECC installer for this test

Commands such as:

```bash
npx ecc-universal@2.2.2 setup
```

install upstream ECC. They do **not** install the JEV-ECC fork in this repository.

For JEV-ECC testing, use this repository directly so the JEV switchboard code and hooks being evaluated are the code you actually run.

### Requirements

- Linux, macOS, or another environment supported by ECC
- Node.js 18 or newer
- Git
- Claude Code 2.1 or newer for the primary integration path
- a TypeSafe AI API key for Jev

Without `TYPESAFE_API_KEY`, the switchboard becomes inert and ECC behavior should pass through normally.

### Clone the fork

```bash
git clone https://github.com/aibotjock/JEV-ECC.git
cd JEV-ECC
```

### Install dependencies

This repository currently uses Yarn:

```bash
corepack enable
yarn install
```

### Configure Jev

Create a local environment file:

```bash
cp .env.example .env
nano .env
```

Set:

```text
TYPESAFE_API_KEY=your_real_key_here
```

Do not commit `.env`.

Optional defaults are already defined in the code. The important switchboard variables include:

```text
ECC_JEV_ENABLED=true
ECC_JEV_MODEL=jev-1.13.0
ECC_JEV_BASE_URL=https://api.typesafe.ai
ECC_JEV_ACTIVATION_THRESHOLD=0.65
ECC_JEV_DEACTIVATION_THRESHOLD=0.35
```

For controlled testing, use a separate data directory so JEV-ECC test state does not mix with an existing ECC installation:

```bash
export ECC_AGENT_DATA_HOME="$HOME/.jev-ecc-test"
export ECC_JEV_STATE_DIR="$HOME/.jev-ecc-test/ecc/jev-switchboard"
```

Export the API key into the shell before running CLI or Claude integration tests:

```bash
set -a
source .env
set +a
```

### Run health checks first

```bash
node scripts/jev-switchboard.js doctor
node scripts/jev-switchboard.js build-registry
node scripts/jev-switchboard.js status
```

Expected behavior:

- the API key is detected without being printed,
- the JEV switchboard is enabled,
- the state directory is writable,
- the registry is built successfully,
- unavailable optional capabilities are reported honestly rather than silently assumed present.

### Run a manual routing evaluation

Example:

```bash
node scripts/jev-switchboard.js eval \
  --session manual-test \
  --event user-prompt \
  --prompt "Create a Docker Compose stack with PostgreSQL and add tests" \
  --json
```

Then inspect status:

```bash
node scripts/jev-switchboard.js status --session manual-test
```

The exact capabilities and probabilities will vary. The important test is whether the activated capabilities are relevant to the task and irrelevant capabilities remain off.

### Run the dedicated JEV tests

Examples:

```bash
node tests/lib/jev-switchboard/controller.test.js
node tests/lib/jev-switchboard/jev-client.test.js
node tests/lib/jev-switchboard/eval-runner.test.js
node tests/hooks/jev-route.test.js
node tests/hooks/jev-gate.test.js
node tests/scripts/jev-switchboard-cli.test.js
```

Then run the repository test suite:

```bash
yarn test
```

The repository currently documents a small set of environment-dependent failures inherited from the ECC baseline. New JEV-ECC failures should be investigated rather than dismissed as baseline failures.

## Testing the Unproven Claims

Use [docs/JEV-VALIDATION-PLAN.md](docs/JEV-VALIDATION-PLAN.md) for a controlled JEV-OFF versus JEV-ON comparison covering:

- task success,
- token usage,
- provider cost,
- elapsed time,
- skill/MCP/tool calls,
- denied capability overrides,
- routing accuracy,
- failures and retries,
- subjective and automated quality checks.

The purpose of the test is to determine whether the switchboard creates measurable value. A technically functioning router is not enough by itself.

## CLI

```bash
node scripts/jev-switchboard.js doctor
node scripts/jev-switchboard.js build-registry
node scripts/jev-switchboard.js status
node scripts/jev-switchboard.js eval
node scripts/jev-switchboard.js calibrate
```

- `doctor` checks configuration and health.
- `build-registry` derives the regulated capability catalog.
- `status` inspects switchboard state.
- `eval` runs one routing evaluation.
- `calibrate` summarizes telemetry and suggests threshold tuning once enough events exist.

## Safety and Failure Behavior

JEV is an advisory probability model. The deterministic controller owns state transitions.

Important behavior:

- explicit hard rules can lock security-critical capabilities,
- an unavailable capability is forced off,
- a failed Jev evaluation keeps the current state,
- if no successful state exists yet, gates pass through rather than breaking the agent,
- core host tools are not regulated in v1 unless explicitly opted in,
- API keys are supplied through environment variables and must not be committed.

## v1 Scope

JEV-ECC v1 regulates capability availability. It does not:

- select or spawn agents,
- control delegation or iteration,
- terminate agents,
- route between language models,
- replace the host scheduler,
- dynamically rewrite every MCP configuration,
- physically materialize a different skill directory for every task.

Those distinctions are deliberate and should not be described as current functionality.

## Attribution and License

JEV-ECC is derived from the MIT-licensed [ECC project](https://github.com/affaan-m/ECC). The original ECC authors and contributors retain attribution for upstream work.

JEV-specific switchboard work in this fork is documented in [docs/JEV-SWITCHBOARD.md](docs/JEV-SWITCHBOARD.md) and [GAUNTLET-PROGRESS.md](GAUNTLET-PROGRESS.md).

See [LICENSE](LICENSE) for license terms.
