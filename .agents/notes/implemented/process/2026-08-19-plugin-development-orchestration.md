# Agent Note: Plugin development orchestration

Status: implemented

English | [中文](2026-08-19-plugin-development-orchestration.zh.md)

## Problem

Plugin development guidance is distributed across the architecture, extension cookbooks, package rules, testing policy, and finishing skills. Those sources define their individual subjects, but no repository workflow routes a plugin request through them or coordinates multiple coding agents around dependencies and file ownership.

Without that routing layer, a plugin extension can enter the wrong authoring path, parallel work can begin before a shared interface is settled, and several agents can modify integration files or generated artifacts independently. A collection of successful lane-level checks also does not establish that the combined tree satisfies the request.

## Decision

The repository provides the [`dsh-plugin-development`](../../../skills/dsh-plugin-development/SKILL.md) skill as a thin orchestration layer for first-party and external DeepSeek Harness plugin extensions. It classifies the requested plugin form, selects the existing authoritative guides, plans behavioral evidence with the design, and routes review and validation to the existing specialized skills.

One lead agent owns scope, integration, and the combined result. When delegation is authorized and useful, work is divided by independently verifiable deliverables with explicit dependencies, write paths, shared files, and evidence. Shared interfaces and durable event definitions are settled before dependent implementations proceed in parallel. Each file has one writer, and shared integration or generated files have one named owner.

The lead validates the integrated tree after lane handoffs. An independent reviewer receives the original request, final combined diff, and repository authorities rather than relying on implementer summaries. Every handoff records repository facts, changed paths, exact checks, and unresolved risks.

The orchestration skill links to architecture, authoring, testing, prose, review, and pre-push authorities instead of copying their requirements. It does not create a fixed set of agent roles, require delegation for small changes, grant Git or external-write authority, or replace semantic review with generated plans and green gates.

## Alternatives considered

**Add the workflow to root `AGENTS.md`.** Every repository task would pay the context cost even though most work is not plugin development, and detailed routing would obscure the root file's standing rules.

**Copy the package checklist, testing matrix, and review checklist into one skill.** Duplicated requirements would drift from their existing owners and make updates depend on synchronizing several prose copies.

**Always assign architecture, implementation, testing, and documentation personas.** Fixed roles create coordination for small changes and divide work by labels rather than independent deliverables. Some plugin changes need one agent; others need several implementation lanes after a shared interface is established.

**Allow every lane to update aggregate files and generated artifacts.** Concurrent writes to lockfiles, root configuration, bundle composition, snapshots, notes, and pairing records create conflicts and make ownership of the final output unclear.

**Treat lane-level validation as final evidence.** Independently passing pieces can still disagree at their interfaces or fail after generated and composition changes are combined.

## Consequences

Plugin extensions have one discoverable development entry point while architecture, authoring, testing, and review facts retain one authoritative home. Multi-agent work begins only where deliverables can be isolated, and the integrated result has an explicit owner and final evidence.

The workflow adds an up-front classification and ownership step. The lead must also reconcile handoffs and validate the combined tree, so delegation is useful only when the independent work exceeds its coordination cost.
