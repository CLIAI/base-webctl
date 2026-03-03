---
id: "0000"
title: "Design Documents Guidelines"
category: meta
created: 2026-03-03
updated: 2026-03-03
status: stable
tags: [meta, guidelines, documentation, yaml, front-matter]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Design Documents Guidelines

## Purpose

This directory contains **universal, service-agnostic** design documents for
web-control CLI tools. Documents describe reusable principles, patterns, and
architectural decisions — never referencing any specific platform or service.

## File Naming Convention

```
{category}-{descriptive-slug}-{id}.md
```

* **category** — one of the registered prefixes below
* **descriptive-slug** — lowercase, hyphenated, concise (2-5 words)
* **id** — unique 4-character alphanumeric `[a-z0-9]` identifier

Example: `safety-toctou-conversation-state-a3k7.md`

## Category Prefixes

| Prefix    | Scope                                          |
|-----------|-------------------------------------------------|
| `ux-`     | User experience patterns, help, display, nav    |
| `safety-` | Operation safety, guards, TOCTOU, write-safety  |
| `infra-`  | Infrastructure, browser, env config, launch     |
| `data-`   | Data handling, extraction, provenance, payloads |
| `arch-`   | Architecture, CLI structure, subcommands        |
| `test-`   | Testing patterns, QA, visual QA                 |
| `ops-`    | Operational: monitoring, cleanup, dedup         |
| `meta-`   | About the docs themselves, guidelines           |

**Adding new categories:** When a document doesn't fit existing prefixes, add a
new row to this table, commit, and use it. Prefer short (2-6 char) prefixes that
clearly signal the domain. Update `scripts/verify_yaml_frontmatter.py` with the
new prefix.

## YAML Front Matter Schema

Every design document **must** begin with valid YAML front matter:

```yaml
---
id: a3k7                              # REQUIRED — 4-char [a-z0-9], matches filename postfix
title: "TOCTOU Guards for Conv State" # REQUIRED — human-readable title
category: safety                      # REQUIRED — must match filename prefix
created: 2026-03-03                   # REQUIRED — ISO date
updated: 2026-03-03                   # REQUIRED — ISO date, >= created
status: draft                         # REQUIRED — draft | review | stable | deprecated
tags: [concurrency, state-verify]     # REQUIRED — list of keyword strings (may be empty [])
tech: []                              # REQUIRED — list of {name, version} or empty []
relates_to: []                        # OPTIONAL — IDs of conceptually related docs
depends_on: []                        # OPTIONAL — IDs of prerequisite docs
expands: []                           # OPTIONAL — IDs this doc elaborates on
similar_to: []                        # OPTIONAL — IDs with overlapping scope
---
```

### Field Details

**`id`** — Unique 4-char `[a-z0-9]` string. Appears in filename postfix.
Survives renames. Use for all cross-references.

**`status`** lifecycle:
* `draft` — work in progress, may be incomplete
* `review` — ready for review, content believed complete
* `stable` — reviewed and accepted
* `deprecated` — superseded or no longer applicable

**`tags`** — Free-form keyword list for programmatic filtering. Use lowercase,
hyphenated multi-word tags. No limit on count. Examples: `state-verification`,
`browser-automation`, `cli-ux`, `file-upload`.

**`tech`** — Technology dependencies. Empty list `[]` if tech-independent:
```yaml
tech:
  - name: "Chrome DevTools Protocol"
    version: "1.3"
  - name: "Node.js"
    version: ">=18"
```

**`relates_to`**, **`depends_on`**, **`expands`**, **`similar_to`** — Lists of
document IDs (`[a-z0-9]{4}`) expressing relationships:

| Relationship  | Meaning                                      |
|---------------|----------------------------------------------|
| `relates_to`  | Conceptually connected, worth reading together |
| `depends_on`  | Must be read/implemented before this doc     |
| `expands`     | This doc elaborates on the referenced doc    |
| `similar_to`  | Overlapping scope, different angle/approach  |

## Validation

Run `scripts/verify_yaml_frontmatter.py` to check all docs:

```bash
python3 scripts/verify_yaml_frontmatter.py docs/design/
```

It verifies:
* YAML parses without error
* All required fields present with correct types
* `id` matches filename postfix
* `category` matches filename prefix
* Referenced IDs in relationship fields exist as actual documents
* No duplicate IDs across all documents
* Date fields are valid ISO dates
* `updated >= created`

## Writing Principles

1. **Service-agnostic** — Never reference specific platforms. Describe universal
   patterns. Say "messaging platform" not a brand name.
2. **Principle-first** — Lead with the *why*, then the *what*, then *how*.
3. **Concise** — Target 200-500 lines. Split larger topics into linked docs.
4. **Actionable** — Include concrete patterns, code snippets, parameter lists.
5. **Cross-referenced** — Use relationship fields liberally to build a
   navigable knowledge graph.

## Generating IDs

Generate random 4-char IDs:

```bash
python3 -c "import random, string; print(''.join(random.choices(string.ascii_lowercase + string.digits, k=4)))"
```

Before assigning, verify uniqueness:

```bash
grep -r '^id: ' docs/design/ | awk '{print $2}' | sort | uniq -d
```
