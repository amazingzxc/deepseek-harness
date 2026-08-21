# Agent Note: Web batch CLI over Web Sessions

Status: implemented

English | [中文](2026-08-20-web-batch-cli.zh.md)

## Problem

Automation needs to run independent tasks concurrently while retaining the Web product's visible Sessions, permission prompts, questions, persistence, and recovery. The one-shot headless entry cannot provide browser interaction, while a second Agent loop or batch-specific RPC would duplicate authorities already owned by the Web Host.

The batch process can fail after sending a create or prompt request but before receiving its response. Recovery must not create a second Session or submit the task prompt twice, and a second runner must not concurrently advance the same persisted batch.

## Decision

The `@deepseek-ai/dsh` package installs a second independently bundled executable, `dsh-web-batch`. It is an application-level ApiProxy client of an already-running `dsh web` Host, following the existing [application and transport layering](../architecture/2026-07-19-gui-layering-and-rpc-protocol.md). It does not mount plugins, start a Host, alter Agent Loop, add Web RPC methods, or reuse the [direct headless entry](../architecture/2026-08-09-headless-direct-core-entry-point.md).

Each strict JSONL manifest task has its own canonical absolute cwd and receives a fresh preallocated Session ID. The runner persists that identity before network access, calls idempotent `session.create`, reconciles `session.history` and the live queue, and submits the task prompt only when neither contains it. The first ordinary prompt owns one root turn; a later ordinary human prompt is treated as a local ownership conflict without mutating the Session.

Batch state is a private SQLite database under `$DSH_HOME/web-batches/<batch-id>`. Its application ID and monotonic schema version reject incompatible files. A durable runner lock prevents concurrent execution; explicit `--take-over` preserves the abandoned owner as audit history.

The Node carrier subclasses `AbstractApiClient`: unary calls use HTTP, while mux and Host downlinks use the Web product's WebSocket routes and public schemas. Both streams reconnect as one generation; every generation repeats Session creation and history reconciliation before task progress continues.

Questions and approvals remain browser-owned. Requested frames move a task to `waiting-human`, resolved frames return it to `running`, and the non-terminal task retains its concurrency slot. The runner never sends an interaction response. A completed turn succeeds, a user abort cancels, and every other terminal reason fails; the last non-empty assistant message in the owned turn becomes the task text.

stdout is a versioned NDJSON protocol emitted only after SQLite commits. SIGINT and SIGTERM quiesce the local streams and scheduler, release the runner lock, and leave Web Sessions running for later `resume`.

## Alternatives considered

**Extend the headless runner with batch and interaction support.** Rejected because headless deliberately mounts no Host, HTTP server, ApiProxy, or browser. Adding those responsibilities would erase the direct-core distinction and create another Web composition.

**Add batch RPC methods and Host-side batch persistence.** Rejected because the existing Session API and event streams already provide creation, prompt durability, interaction observation, and recovery. Batch scheduling is caller-owned automation state and does not belong in the Session log or model-visible request.

**Automatically answer questions or approvals from the CLI.** Rejected because policy and human intent belong to the existing Web interaction UI. An unattended answer would bypass the product's permission and question ownership.

**Free a concurrency slot while waiting for a person.** Rejected because concurrency limits live task ownership, not CPU use. Starting another task would exceed the operator's bound on Sessions that may require supervision.

## Consequences

Operators gain resumable parallel automation whose tasks remain ordinary inspectable Web Sessions, and no new model-visible input or session event exists. Recovery relies on public ApiProxy behavior and durable Session history instead of a second execution engine.

The Web Host must already be reachable, and the caller must provide isolated working directories. Pending interactions need a live browser, `waiting-human` can hold all slots indefinitely, and a Host restart terminates unfinished turns under existing Session recovery rather than reconstructing forms. Batch databases intentionally have no compatibility promise before release.

## Verification

Focused tests pin strict argv and manifest validation, SQLite identity and permissions, runner locks and takeover, prompt/create response loss, concurrency, interaction replay, reconnect, conflict handling, signals, and plain-Node built output. A keyless real Web composition starts the built batch executable, opens its Session in Chromium, answers a replayed question through the shipped page, and compares normalized version-0 NDJSON with a checked-in expected file. A key-gated smoke starts the built `dsh web` and completes one batch task through the real DeepSeek provider.
