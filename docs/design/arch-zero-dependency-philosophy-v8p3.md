---
id: v8p3
title: "Zero-Dependency Design Philosophy"
category: arch
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [zero-dep, supply-chain, stdlib, portability, minimal-dependencies]
tech:
  - name: "Node.js"
    version: ">=18"
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Zero-Dependency Design Philosophy

## Problem Statement

Modern JavaScript tooling relies on deep dependency trees. A single `npm install`
can pull hundreds of transitive packages, each one a potential vector for supply
chain attacks, license conflicts, version drift, and build breakage. For a CLI
tool that operates on sensitive data (browser sessions, credentials, page
content), every external dependency widens the attack surface and adds
operational friction.

The zero-dependency philosophy eliminates this entire class of risk by building
exclusively on the Node.js standard library.

## Core Principle

**Use only Node.js built-in modules. No npm packages, no build step, no
transpilation.** Every utility the tool needs is implemented from scratch using
`node:http`, `node:https`, `node:crypto`, `node:fs`, `node:path`, `node:test`,
and other standard library modules.

The result is a tool that is immediately runnable on any machine with Node.js
installed. There is no `package-lock.json`, no `node_modules/`, no install step.

## Rationale

### Supply Chain Security

Each external dependency introduces trust assumptions:

* The package author maintains secure practices.
* The npm registry serves unmodified code.
* Transitive dependencies (dependencies of dependencies) are equally
  trustworthy.
* No dependency has been compromised between audits.

A zero-dependency tool eliminates all of these assumptions. The only trust
boundary is the Node.js runtime itself, which is maintained by a well-resourced
open-source foundation with established security practices.

### Portability

A zero-dependency tool runs anywhere Node.js is installed:

* No network access needed at setup time (no `npm install`).
* No platform-specific native modules that fail to compile.
* No version conflicts with other projects on the same machine.
* Works in air-gapped environments, containers with no registry access, and
  CI runners without package caches.

### Operational Simplicity

* **No lockfile management** — No merge conflicts in `package-lock.json`, no
  lockfile drift between environments.
* **No audit noise** — `npm audit` reports on the dependency tree do not apply.
* **No build pipeline** — The source code is the runtime code. No transpilation,
  bundling, or minification step.
* **Instant startup** — No module resolution through `node_modules` trees.

### Auditability

The entire codebase is self-contained. A security reviewer can audit every line
of code that executes, without tracing into external packages. The attack
surface is bounded by the repository itself.

## Inventory of Hand-Implemented Utilities

Rather than pulling in npm packages, the following utilities are implemented
directly using standard library primitives.

| Utility               | Replaces (typical npm package) | Implementation Approach                     |
|-----------------------|-------------------------------|---------------------------------------------|
| WebSocket CDP client  | `ws`                          | Hand-coded RFC 6455 framing over `node:net` / `node:crypto` for masking |
| HTTP client           | `axios`, `node-fetch`         | Built-in `node:http` / `node:https` modules with redirect following |
| Dotenv parser         | `dotenv`                      | Line-by-line parser handling quotes, escapes, comments, and export prefixes |
| XML/Atom parser       | `fast-xml-parser`             | Regex-based extraction for predictable feed structures |
| YAML serializer       | `js-yaml`                     | Lightweight custom serializer for configuration output |
| JSONC parser          | `jsonc-parser`                | Comment stripper (line and block comments) followed by `JSON.parse()` |
| HTML-to-Markdown      | `turndown`                    | Browser-side recursive DOM walker producing Markdown output |
| Test runner           | `jest`, `mocha`               | Built-in `node:test` module (available since Node.js 18) |

### WebSocket CDP Client

The Chrome DevTools Protocol communicates over WebSocket. Instead of depending
on the `ws` package, the implementation handles RFC 6455 directly:

* TCP connection via `node:net` (or TLS via `node:tls`).
* HTTP upgrade handshake with `Sec-WebSocket-Key` generation using
  `node:crypto`.
* Frame encoding/decoding: opcode parsing, payload length handling (7-bit,
  16-bit, 64-bit), masking for client-to-server frames.
* Ping/pong keepalive.
* Clean close handshake.

This is the most substantial hand-implemented utility, but WebSocket framing is
a well-specified protocol with straightforward implementation requirements.

### Dotenv Parser

Environment variable loading from `.env` files follows the common format:

```
# Comment lines
KEY=value
KEY="quoted value with spaces"
KEY='single quoted'
export KEY=value
```

The parser handles:

* Comment lines (lines starting with `#`).
* Unquoted, single-quoted, and double-quoted values.
* `export` prefix stripping.
* Inline comments after unquoted values.
* Empty values and missing `=` signs.

### JSONC Parser

Configuration files use JSON with Comments (JSONC), which standard
`JSON.parse()` rejects. The comment stripper removes:

* Line comments (`// ...`).
* Block comments (`/* ... */`).
* Preserves strings containing comment-like sequences (e.g.,
  `"url": "https://example.com"`).

After stripping, standard `JSON.parse()` handles the rest.

### XML/Atom Parser

For parsing structured feeds with predictable schemas, regex-based extraction
is sufficient. The parser targets known element names and does not attempt to
handle arbitrary XML. This deliberate scope limitation means:

* No need for a full XML parser with namespace support.
* Predictable performance characteristics.
* Simple error handling when expected elements are missing.

### HTML-to-Markdown Converter

Runs in the browser context (injected via CDP) and recursively walks the DOM
tree, converting elements to their Markdown equivalents:

* Headings, paragraphs, lists (ordered and unordered).
* Links, images, code blocks, inline code.
* Tables (pipe-delimited Markdown tables).
* Whitespace normalization.

Because it operates on the live DOM rather than raw HTML, it benefits from the
browser's own HTML parsing and error correction.

## Trade-offs

### More Code to Maintain

Hand-implementing utilities means maintaining more application code. Each
utility must be:

* Tested for correctness.
* Updated if the underlying spec or use case evolves.
* Documented for future contributors who may expect an npm package.

This is a conscious trade-off: the maintenance burden of a few hundred lines of
well-scoped utility code is judged to be lower than the operational burden of
managing a dependency tree.

### Feature Subset

Hand-implemented utilities cover only the features actually needed. For example:

* The WebSocket client handles text frames and the CDP message pattern, not
  binary frames or extensions.
* The XML parser handles specific feed structures, not arbitrary XML.
* The YAML serializer writes configuration output, not arbitrary YAML documents.

This is a feature, not a bug: each utility is precisely scoped to its use case,
with no dead code from unused features of a general-purpose library.

### No Community Bug Fixes

When a bug is found in a hand-implemented utility, it must be fixed in-house.
There is no upstream maintainer to report to and no community of users finding
edge cases. Mitigation strategies:

* Thorough test coverage for each utility.
* Conservative implementations that handle known use cases rather than
  attempting full spec compliance.
* Clear documentation of known limitations.

## When Exceptions Are Acceptable

The zero-dependency principle is a strong default, not an absolute rule.
Exceptions may be justified when:

* **Cryptographic operations** — If the tool needs cryptographic functionality
  beyond what `node:crypto` provides, a well-audited external library may be
  preferable to a hand-rolled implementation. Cryptography is a domain where
  subtle implementation errors have severe consequences.
* **Binary protocol parsing** — Protocols with complex binary formats (e.g.,
  image codecs, compression algorithms) may justify a dependency if the
  alternative is hundreds of lines of error-prone bit manipulation.
* **Platform-specific native bindings** — If the tool must interact with OS
  APIs not exposed by Node.js (e.g., keychain access, system notifications),
  a native addon may be the only option.

Any exception must be explicitly documented with:

* The specific need that cannot be met by standard library.
* The chosen package and its dependency footprint.
* A plan for auditing updates to the package.

## Testing Without External Frameworks

The built-in `node:test` module (Node.js 18+) provides:

* `describe()` / `it()` / `test()` for test organization.
* `assert` for assertions.
* `mock` for function mocking.
* Built-in test runner with TAP output.
* `--test` flag for running test files.

This eliminates the need for Jest, Mocha, Vitest, or any other test framework.
Tests are plain JavaScript files that import from `node:test` and `node:assert`.

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('dotenv parser', () => {
  it('parses unquoted values', () => {
    const result = parseDotenv('KEY=value');
    assert.deepStrictEqual(result, { KEY: 'value' });
  });

  it('strips export prefix', () => {
    const result = parseDotenv('export KEY=value');
    assert.deepStrictEqual(result, { KEY: 'value' });
  });

  it('handles quoted values with spaces', () => {
    const result = parseDotenv('KEY="hello world"');
    assert.deepStrictEqual(result, { KEY: 'hello world' });
  });
});
```

## Decision Checklist

When considering whether to add a dependency or implement from scratch, apply
these questions in order:

1. **Can the standard library do this?** If yes, use it directly.
2. **Is the required functionality a small, well-defined subset?** If yes,
   implement the subset.
3. **Is this a security-critical domain (crypto, TLS)?** If yes, prefer
   audited libraries over hand-rolled implementations.
4. **What is the dependency's transitive footprint?** A single package that
   pulls 50 transitive dependencies is a higher risk than one with zero.
5. **How frequently is the dependency updated?** Frequent updates mean frequent
   audit obligations.
6. **Can the tool function if this dependency disappears from npm?** If not,
   the dependency is a single point of failure.

## Implementation Guidance

### File Organization

Hand-implemented utilities should be organized in a dedicated utilities
directory, with each utility in its own file:

```
lib/
  ws-client.js        # WebSocket CDP client
  dotenv.js           # .env file parser
  http-client.js      # HTTP request wrapper
  xml-parser.js       # Feed XML extraction
  yaml-serializer.js  # YAML output writer
  jsonc.js            # JSONC comment stripper
```

Each utility file should:

* Export a focused public API.
* Include inline documentation of scope and limitations.
* Have a corresponding test file.

### Error Handling

Hand-implemented utilities must provide clear error messages that help diagnose
issues without the stack traces of third-party code:

* Parse errors should include the line number and character position.
* Network errors should include the URL, method, and status code.
* Protocol errors (WebSocket) should include the frame details.

### Performance Considerations

Hand-implemented utilities do not need to match the performance of optimized
native-addon npm packages. The relevant performance bar is "fast enough for CLI
use" — typically processing kilobytes to low megabytes of data in interactive
response times. If a utility becomes a bottleneck, profiling and optimization
of the specific hot path is preferable to replacing it with a dependency.
