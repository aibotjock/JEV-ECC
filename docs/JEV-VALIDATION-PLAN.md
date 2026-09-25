# JEV-ECC Validation Plan

This document defines a controlled test of JEV-ECC. The goal is not to prove that JEV-ECC works; the goal is to find out whether it creates measurable value.

## Questions to Answer

Test whether JEV-ECC changes any of the following compared with the same ECC environment with JEV routing disabled:

1. task success rate,
2. output quality,
3. input/output token usage,
4. provider cost,
5. wall-clock completion time,
6. number of skill calls,
7. number of MCP calls,
8. number of other regulated tool calls,
9. unnecessary or irrelevant capability use,
10. retries and failed tool calls,
11. routing mistakes,
12. manual overrides,
13. reliability over repeated sessions.

Do not claim improvement in any category unless the measurements support it.

## Experimental Design

Use the same machine, repository, Claude Code version, ECC/JEV-ECC commit, model, provider, tool configuration, MCP configuration, prompt set, and network conditions as closely as practical.

The independent variable is only the JEV capability switchboard.

### Condition A — JEV OFF

```bash
export ECC_JEV_ENABLED=false
```

Run the benchmark task normally.

### Condition B — JEV ON

```bash
export ECC_JEV_ENABLED=true
```

Use the same task, same codebase starting state, same model, and same available capability catalog.

For clean comparisons, reset the target repository to the same starting commit before every run.

## Recommended First Benchmark Set

Use at least 20 tasks before drawing conclusions. Fifty or more is preferable once the workflow is stable.

Include different workload types so the router is tested against both obvious and ambiguous tasks.

### Coding

- add a small API endpoint,
- repair a failing unit test,
- refactor duplicated code,
- diagnose a TypeScript type error,
- add input validation,
- implement a small database migration.

### Infrastructure

- create or repair Docker Compose configuration,
- diagnose a CI failure,
- add a GitHub Actions step,
- troubleshoot a dependency/install problem.

### Security

- review a small authentication flow,
- identify dangerous command execution,
- review secret handling,
- analyze dependency risk.

### Documentation and research

- write API usage documentation from the repository,
- explain an unfamiliar subsystem,
- compare two implementation approaches using repository evidence.

### Ambiguous/mixed tasks

- fix a bug that may involve frontend, backend, or database code,
- investigate a performance regression without giving the likely subsystem,
- repair a failing integration test with minimal context.

Ambiguous tasks are important because they are more likely to expose routing mistakes.

## Number of Runs

For an initial smoke comparison:

- 10 tasks,
- one JEV-OFF run and one JEV-ON run per task.

For a more credible internal result:

- 20–30 tasks,
- at least two runs per condition where cost permits.

For claims intended for publication:

- use a larger preregistered task set,
- randomize condition order,
- use repeated trials,
- report confidence intervals and raw data.

## Randomization

Do not always run JEV OFF first.

For approximately half of tasks, use:

`OFF → ON`

For the other half:

`ON → OFF`

This reduces bias from cache state, operator learning, repository familiarity, or transient provider behavior.

## What to Record for Every Run

Create one row per run with:

- task ID,
- condition (`JEV_OFF` or `JEV_ON`),
- timestamp,
- JEV-ECC commit SHA,
- target repository starting SHA,
- Claude Code version,
- model/provider,
- prompt text or prompt hash,
- total elapsed seconds,
- input tokens,
- output tokens,
- cache-read/cache-write tokens if available,
- provider-reported cost if available,
- Jev request input/output usage if available,
- Jev routing latency,
- number of capabilities evaluated,
- capabilities ON,
- capabilities OFF,
- capabilities LOCKED,
- skills invoked,
- MCP servers invoked,
- regulated tools invoked,
- failed tool calls,
- retries,
- JEV denials,
- manual overrides,
- final test-suite result,
- task success/failure,
- quality score,
- notes.

Preserve raw telemetry rather than recording only summaries.

## Success Definition

Define task success before reviewing the JEV result whenever possible.

Examples:

- target tests pass,
- requested endpoint behaves correctly,
- build succeeds,
- regression is fixed without breaking existing tests,
- requested documentation accurately reflects repository behavior.

Do not use "the answer looked good" as the only success criterion for coding tasks.

## Quality Evaluation

Use objective checks first:

- unit/integration tests,
- compiler/type checker,
- linter,
- benchmark target,
- security test,
- acceptance criteria.

For tasks that require qualitative review, use a blinded rubric when practical. The reviewer should not know whether JEV was enabled.

Possible rubric dimensions:

- correctness,
- completeness,
- maintainability,
- unnecessary changes,
- security,
- adherence to task constraints.

Keep the rubric identical for both conditions.

## Routing Accuracy

For every JEV-ON run, classify routing outcomes after the task:

### True positive

A capability was ON and was relevant/useful.

### False positive

A capability was ON but clearly irrelevant.

### True negative

A capability was OFF and was not needed.

### False negative

A capability was OFF but became necessary or its absence caused friction/failure.

False negatives are especially important because an aggressive router can appear efficient while harming task quality.

Track:

- false-negative count,
- denial followed by override,
- denial followed by task failure,
- capability activation after failure re-evaluation.

## Cost Test

Measure total cost, not just Jev cost.

For each condition calculate:

```text
Total cost = primary model cost + Jev cost + other metered tool/API cost
```

Compare:

- mean cost per successful task,
- median cost per successful task,
- cost distribution,
- failures/retries that increase cost.

A lower model-token count is not automatically a savings if retries or failures increase.

## Token Test

Record provider-reported tokens where possible.

Compare separately:

- input tokens,
- output tokens,
- cached tokens,
- total primary-model tokens,
- Jev routing input.

Do not assume capability gating reduces context tokens. Measure it.

## Speed Test

Use wall-clock time from task submission to accepted completion.

Also record JEV routing latency separately.

Because the evaluator is detached, Jev latency may not translate directly into user-visible delay. Measure both rather than inferring one from the other.

## Capability-Use Test

Compare JEV OFF vs ON for:

- total skill invocations,
- unique skills invoked,
- total MCP calls,
- unique MCP servers used,
- irrelevant calls,
- failed capability calls,
- repeated capability exploration.

This is one of the most direct tests of the switchboard's intended benefit.

## Failure-Rate Test

Count:

- failed tasks,
- failed tool calls,
- retries,
- routing evaluation failures,
- denied-needed-capability events,
- manual overrides,
- state/lock errors.

Compare failures per task and failures per successful task.

## Threshold Calibration

Do not tune thresholds during the first comparison batch. Use the defaults for the initial benchmark so the test has a fixed configuration.

After enough telemetry exists, run:

```bash
node scripts/jev-switchboard.js calibrate
```

Treat its output as a recommendation, not proof.

If thresholds are changed, start a new benchmark phase and record the exact values.

Suggested naming:

- Phase 1: default thresholds `0.65 / 0.35`
- Phase 2: calibrated thresholds

Do not mix phases in one aggregate result without labeling them.

## Reliability Test

After controlled A/B testing, run JEV ON for normal development sessions and monitor:

- evaluator errors,
- stale/missing state,
- lock contention,
- malformed responses,
- API rate limits,
- latency spikes,
- unexpected denials,
- security controls remaining locked.

A system that performs well on short benchmark tasks may still fail operationally over long sessions.

## Minimum Evidence Before Making Claims

### "JEV-ECC reduces capability noise"

Require fewer irrelevant capability invocations without a meaningful increase in false negatives.

### "JEV-ECC reduces token usage"

Require measured primary-model token reduction across the task set.

### "JEV-ECC saves money"

Require lower total cost per successful task after including Jev and retry costs.

### "JEV-ECC improves speed"

Require lower end-to-end completion time, not merely fast Jev inference.

### "JEV-ECC improves quality"

Require better objective acceptance results or blinded quality scoring.

### "JEV-ECC improves reliability"

Require a lower failure/retry rate across repeated runs.

## Suggested Initial Exit Criteria

The first validation phase is complete when:

1. at least 20 paired tasks have been run,
2. both conditions used the same starting states,
3. raw metrics are saved,
4. routing false negatives are reviewed,
5. total cost per successful task is calculated,
6. task success rate is compared,
7. token usage is compared,
8. elapsed time is compared,
9. capability calls are compared,
10. no claims exceed the evidence.

The result may show that JEV-ECC helps, hurts, or has negligible effect. All three outcomes are valid findings.
