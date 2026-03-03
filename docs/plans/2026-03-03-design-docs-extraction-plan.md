---
title: "Design Docs Extraction Plan"
created: 2026-03-03
status: approved
---

# Design Docs Extraction Plan

## Goal

Extract universal web-control CLI design principles from three sibling
repositories into `docs/design/` as service-agnostic, reusable design documents.

## Constraints

* Final artifacts MUST NOT reference any specific service/platform names
* Source references live only in `tmp/` (gitignored)
* Each design doc uses YAML front matter with 4-char alphanumeric ID
* Categories are extensible; initial set: ux, safety, infra, data, arch, test, ops

## Phases

### Phase 1 — Preprocessing (tmp/)

* 3 repo-scanner agents extract patterns from design docs, AGENTS.md, source
* 3 repo-scanner agents extract patterns from tests, scripts, CLI structure
* 2 clusterer agents group by topic, identify cross-repo overlaps
* 1 indexer agent builds INDEX.md + TODO files
* 1 guidelines-writer agent writes DESIGN_DOCS_GUIDELINES.md + verify script

### Phase 2 — Processing (docs/design/)

* Process one TODO at a time
* Rewrite as universal principles (no service names)
* Assign IDs, categories, tags, cross-references

## Source Repos (generic mapping)

* repo-a = /mnt/ro/github/CLIAI/chatgpt-webctl
* repo-b = /mnt/ro/github/CLIAI/linkedin-webctl
* repo-c = /mnt/ro/github/CLIAI/telegram-webctl
