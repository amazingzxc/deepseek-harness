---
name: dsh-plugin-development
description: Use when adding or extending a DeepSeek Harness or Cordis plugin, package, provider, consumer, model-facing tool, client contribution, bundle, or profile, especially when coordinating multiple coding agents from design through review and relevant validation.
---

# Develop a DeepSeek Harness plugin

Use this skill as a thin orchestration layer. The linked architecture, cookbook, package, testing, review, and validation documents remain authoritative; do not copy their checklists or detailed rules into this skill.

## Route the change

Before editing, classify the requested outcome and select its authoring path:

- For a plugin maintained outside this repository, follow the [external plugin tutorial](../../../docs/user/develop/basic/index.md), then load only the relevant framework or practice guide under `docs/user/develop/`.
- For a first-party workspace package, read the root [AGENTS.md](../../../AGENTS.md), [architecture](../../../docs/architecture.md), [package instructions](../../../packages/AGENTS.md), [extension shapes](../../../docs/cookbook/extension-cookbook.md), and [package checklist](../../../docs/cookbook/adding-a-package.md).
- Decide whether the work uses an existing extension point, adds one single-purpose plugin, or introduces a complete capability seam. Do not create one seam role in isolation.
- Load the specific cookbook for a tool, LLM adapter, Conversation Node, settings card, or other named surface. Read [defensive patterns](../../../docs/defensive-patterns.md) before lifecycle, concurrency, subprocess, or teardown work.

State the observable outcome, selected extension point, package topology, configuration owner, durable events, and product or model-visible output before distributing implementation work. Resolve a shared public interface or event definition before parallel consumers depend on it.

## Build the task graph

Keep one lead agent responsible for scope, integration, and the combined result. When multi-agent delegation is authorized and useful, split work by independently verifiable deliverable rather than fixed personas or a fixed agent count.

Start with a compact task graph containing each lane's deliverable, dependencies, allowed write paths, shared files, and required evidence. Good parallel lanes include read-only extension-point discovery, consumer tracing, test-harness analysis, documentation impact, or implementations whose interfaces and files no longer overlap. Keep dependent state-machine work serial.

Assign one writer to each file. The lead or one named lane owns shared integration files such as root TypeScript configuration, `package.json`, the lockfile, bundle patches, generated catalogs, snapshot expected output, Agent Notes, and translation pairing records. Agents do not commit, branch, push, open pull requests, or modify files outside their lane unless the user authorizes that operation and the lead assigns ownership.

Each lane hands back:

- facts established from repository sources;
- changed paths and the behavior they own;
- exact checks run and their results;
- remaining assumptions, risks, and blocked evidence.

The lead inspects the combined diff, resolves cross-lane assumptions, regenerates shared artifacts once, and validates the integrated tree. A passing lane is not evidence that the combined change passes.

## Plan evidence with the design

Read [testing.md](../../../docs/testing.md) before implementation and map each observable behavior to the narrowest evidence that can fail for its regression. Cover the required unit, real composition, snapshot, SDK, built-artifact, or real-provider surfaces without inventing substitutes. If the current harness cannot express a required scenario, extend the harness in the same change.

Non-trivial model- or product-user-visible behavior changes include the runnable example and keyless snapshot required by repository policy. Product-user-visible GUI changes also use [record-browser-gif](../record-browser-gif/SKILL.md). Non-trivial changes add an Agent Note under the [Agent Note policy](../../notes/README.md); use [dsh-archive-agent-notes](../dsh-archive-agent-notes/SKILL.md) for its supersession audit. Apply [dsh-prose-standard](../dsh-prose-standard/SKILL.md) to changed prose, and use [dsh-doc-standards](../dsh-doc-standards/SKILL.md) when adding, moving, or restructuring documentation.

## Review and finish

Give an independent reviewer the original request, final combined diff, and repository authorities, not only the implementers' summaries. Use [dsh-code-review](../dsh-code-review/SKILL.md) for pull-request review or an equivalent review of an uncommitted combined diff. The reviewer reports concrete defects; the lead verifies and resolves them.

Use [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md) to select the smallest sufficient checks for the complete outgoing diff. Do not default to the full suite. Use [dsh-merging-stacked-prs](../dsh-merging-stacked-prs/SKILL.md) only when the resulting pull requests form a dependency stack.

The final handoff names the implemented design, changed paths, exact checks run, evidence that remains unavailable, and material risks or follow-up work. Never claim that another agent, a green gate, or CI established facts that were not independently inspected.
