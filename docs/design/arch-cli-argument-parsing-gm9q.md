---
id: gm9q
title: "CLI Argument Parsing & Command Routing"
category: arch
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [cli, argument-parsing, flag-expansion, command-routing, zero-dep, boolean-negation]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# CLI Argument Parsing & Command Routing

## Motivation

Web-control CLI tools accumulate flags, subcommands, and convenience shorthands
over time. Without a principled parsing pipeline the argument handling code
devolves into ad-hoc string splitting scattered across entry points. This
document defines a **multi-stage, zero-dependency parsing pipeline** that
transforms raw `process.argv` into a fully resolved options object before any
business logic executes.

Goals:

* Deterministic, testable parsing with no hidden state
* Composable stages that can be unit-tested in isolation
* Support for ergonomic shorthands without ambiguous semantics
* Clear separation between *parsing*, *routing*, and *execution*

## Architecture Overview

```
process.argv
    |
    v
┌──────────────────────┐
│ Stage 1: Normalize   │  --flag=value  -->  --flag value
│                      │  -vvv          -->  --verbose --verbose --verbose
│                      │  --no-headless -->  --headless false
└─────────┬────────────┘
          v
┌──────────────────────┐
│ Stage 2: Tokenize    │  Classify tokens into flags, values, positionals
│                      │  Build raw key-value map
└─────────┬────────────┘
          v
┌──────────────────────┐
│ Stage 3: Coerce      │  Type coercion, delay-spec parsing,
│                      │  --requirements expansion, defaults
└─────────┬────────────┘
          v
┌──────────────────────┐
│ Stage 4: Route       │  Two-tier: view + subcommand resolution
│                      │  Legacy alias mapping with deprecation
└─────────┬────────────┘
          v
┌──────────────────────┐
│ Stage 5: Validate    │  Required flags, mutex groups,
│                      │  pure-function classification
└─────────┬────────────┘
          v
      Resolved Options Object  -->  handler(opts)
```

## Stage 1: Normalize

The normalizer rewrites shorthand forms into canonical long-form tokens so that
downstream stages only deal with one representation.

### `--flag=value` Expansion

```js
// Input:  ["--delay=0.5~1.5", "--profile=stealth"]
// Output: ["--delay", "0.5~1.5", "--profile", "stealth"]

function expandEquals(args) {
  const out = [];
  for (const arg of args) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const idx = arg.indexOf("=");
      out.push(arg.slice(0, idx), arg.slice(idx + 1));
    } else {
      out.push(arg);
    }
  }
  return out;
}
```

### `--no-flag` Boolean Negation

Any flag prefixed with `--no-` is rewritten to the positive form with an
explicit `false` value. This lets users override defaults without needing to
know the flag's type ahead of time.

```js
// Input:  ["--no-headless", "--no-sandbox"]
// Output: ["--headless", "false", "--sandbox", "false"]

function expandNegation(args) {
  const out = [];
  for (const arg of args) {
    if (arg.startsWith("--no-")) {
      out.push("--" + arg.slice(5), "false");
    } else {
      out.push(arg);
    }
  }
  return out;
}
```

### Verbosity Shorthand

`-v` through `-vvvvv` expand to repeated `--verbose` tokens. The count is
resolved during coercion.

```js
// Input:  ["-vvv"]
// Output: ["--verbose", "--verbose", "--verbose"]

function expandVerbosity(args) {
  const out = [];
  for (const arg of args) {
    const match = /^-v(v*)$/.exec(arg);
    if (match) {
      const count = 1 + match[1].length;
      for (let i = 0; i < count; i++) out.push("--verbose");
    } else {
      out.push(arg);
    }
  }
  return out;
}
```

### Composed Normalizer

All normalizer passes run in a fixed order and compose via simple function
application:

```js
function normalize(argv) {
  let args = argv.slice(2); // skip node + script
  args = expandEquals(args);
  args = expandVerbosity(args);
  args = expandNegation(args);
  return args;
}
```

Order matters: `expandEquals` must run before `expandNegation` so that
`--no-headless=true` becomes `--no-headless true` then `--headless false`
rather than being mis-split.

## Stage 2: Tokenize

The tokenizer walks the normalized token list and classifies each token as a
flag, a value, or a positional argument. It produces a raw map suitable for
type coercion.

```js
// Known flags and their arity (number of expected value tokens)
const FLAG_ARITY = {
  "--delay":        1,
  "--profile":      1,
  "--headless":     0,  // boolean; value comes from --no- expansion
  "--verbose":      0,
  "--requirements": 1,
  "--output":       1,
  "--selector":     1,
  "--timeout":      1,
  "--lock":         0,
  // ... extensible
};

function tokenize(args) {
  const flags = {};
  const positionals = [];
  let i = 0;

  while (i < args.length) {
    const tok = args[i];

    if (tok.startsWith("--")) {
      const arity = FLAG_ARITY[tok];

      if (arity === undefined) {
        throw new ParseError(`Unknown flag: ${tok}`);
      }

      if (arity === 0) {
        // Accumulate for counting (verbosity) or take last value
        flags[tok] = flags[tok] || [];
        // Check if next token is an explicit boolean value
        if (i + 1 < args.length && /^(true|false)$/i.test(args[i + 1])) {
          flags[tok].push(args[i + 1]);
          i += 2;
        } else {
          flags[tok].push("true");
          i += 1;
        }
      } else {
        if (i + arity >= args.length) {
          throw new ParseError(`${tok} expects ${arity} argument(s)`);
        }
        flags[tok] = flags[tok] || [];
        flags[tok].push(args[i + 1]);
        i += 2;
      }
    } else {
      positionals.push(tok);
      i += 1;
    }
  }

  return { flags, positionals };
}
```

## Stage 3: Coerce

The coercion stage transforms raw string values into typed representations.

### Boolean Coercion

```js
function coerceBool(values) {
  // Last value wins (allows override via later flags)
  const last = values[values.length - 1];
  return last.toLowerCase() !== "false";
}
```

### Verbosity Level

Verbosity is the count of `--verbose` occurrences, capped at a maximum:

```js
function coerceVerbosity(values) {
  // Count only "true" entries (--no-verbose would push "false")
  const level = values.filter(v => v.toLowerCase() !== "false").length;
  return Math.min(level, 5); // cap at 5
}
```

Mapping:

| Input           | Verbosity Level | Effect                          |
|-----------------|-----------------|---------------------------------|
| (none)          | 0               | Errors only                     |
| `-v`            | 1               | Warnings + key actions          |
| `-vv`           | 2               | Info-level step narration       |
| `-vvv`          | 3               | Debug: selectors, timings       |
| `-vvvv`         | 4               | Trace: raw protocol messages    |
| `-vvvvv`        | 5               | Full dump: screenshots, DOM     |

### Delay Spec Parsing

The delay spec supports three forms:

* Fixed: `"1.5"` -- always 1.5 seconds
* Range: `"0.5~1.5"` -- uniform random between 0.5 and 1.5
* Default: omitted -- use profile-defined default

```js
function parseDelaySpec(raw) {
  if (!raw) return null;

  if (raw.includes("~")) {
    const [lo, hi] = raw.split("~").map(Number);
    if (isNaN(lo) || isNaN(hi) || lo < 0 || hi < lo) {
      throw new ParseError(
        `Invalid delay range: "${raw}" (expected "min~max", 0 <= min <= max)`
      );
    }
    return { type: "range", min: lo, max: hi };
  }

  const fixed = Number(raw);
  if (isNaN(fixed) || fixed < 0) {
    throw new ParseError(`Invalid delay: "${raw}" (expected non-negative number)`);
  }
  return { type: "fixed", value: fixed };
}
```

Usage at runtime:

```js
function resolveDelay(spec) {
  if (!spec) return 0;
  if (spec.type === "fixed") return spec.value;
  return spec.min + Math.random() * (spec.max - spec.min);
}
```

### `--requirements` Consolidated Preconditions

The `--requirements` flag accepts either inline JSON or an `@file` reference
pointing to a JSON file. It bundles preconditions that must hold before a
command executes.

```js
function parseRequirements(raw) {
  if (!raw) return {};

  let jsonStr;
  if (raw.startsWith("@")) {
    const filePath = raw.slice(1);
    jsonStr = fs.readFileSync(filePath, "utf-8");
  } else {
    jsonStr = raw;
  }

  try {
    const obj = JSON.parse(jsonStr);
    validateRequirementsShape(obj);
    return obj;
  } catch (err) {
    throw new ParseError(`Invalid --requirements: ${err.message}`);
  }
}
```

Requirements schema (example):

```json
{
  "logged_in": true,
  "page_url_pattern": "^https://.*\\.example\\.com/dashboard",
  "element_exists": "#main-content",
  "min_viewport_width": 1024
}
```

Each key maps to a checker function registered in a precondition registry. This
keeps the parser decoupled from any service-specific logic.

## Stage 4: Route -- Two-Tier Command Resolution

### Structure: `tool <view> <subcommand> [flags]`

Commands follow a two-tier hierarchy:

```
webctl  feed     scroll    --delay=0.5~1.5
        ^^^^     ^^^^^^
        view     subcommand
```

The **view** represents a page context or functional area (e.g., `feed`,
`profile`, `settings`, `compose`). The **subcommand** is the action within
that view (e.g., `scroll`, `extract`, `submit`, `list`).

```js
const COMMAND_REGISTRY = {
  feed: {
    scroll:  { handler: feedScroll,  needsLock: true  },
    extract: { handler: feedExtract, needsLock: false },
  },
  profile: {
    view:    { handler: profileView,    needsLock: false },
    update:  { handler: profileUpdate,  needsLock: true  },
  },
  compose: {
    draft:   { handler: composeDraft,  needsLock: true  },
    send:    { handler: composeSend,   needsLock: true  },
    discard: { handler: composeDiscard, needsLock: true  },
  },
  // ...
};

function resolveCommand(positionals) {
  const [view, subcommand, ...rest] = positionals;

  if (!view) {
    throw new UsageError("Missing view. Run with --help for usage.");
  }

  const viewEntry = COMMAND_REGISTRY[view];
  if (!viewEntry) {
    const suggestion = didYouMean(view, Object.keys(COMMAND_REGISTRY));
    throw new UsageError(`Unknown view: "${view}".${suggestion}`);
  }

  if (!subcommand) {
    throw new UsageError(
      `Missing subcommand for "${view}". ` +
      `Available: ${Object.keys(viewEntry).join(", ")}`
    );
  }

  const cmdEntry = viewEntry[subcommand];
  if (!cmdEntry) {
    const suggestion = didYouMean(subcommand, Object.keys(viewEntry));
    throw new UsageError(
      `Unknown subcommand: "${view} ${subcommand}".${suggestion}`
    );
  }

  return { view, subcommand, entry: cmdEntry, extraPositionals: rest };
}
```

### Legacy Command Aliases with Deprecation

Old single-tier commands map to new two-tier equivalents. The alias table
emits a deprecation warning on `stderr` and rewrites positionals before
routing continues.

```js
const LEGACY_ALIASES = {
  "scroll-feed":     { view: "feed",    sub: "scroll",  deprecated: "0.8.0" },
  "view-profile":    { view: "profile", sub: "view",    deprecated: "0.8.0" },
  "send-message":    { view: "compose", sub: "send",    deprecated: "0.9.0" },
};

function expandLegacyAlias(positionals) {
  if (positionals.length === 0) return positionals;

  const first = positionals[0];
  const alias = LEGACY_ALIASES[first];
  if (!alias) return positionals;

  process.stderr.write(
    `WARNING: "${first}" is deprecated since v${alias.deprecated}. ` +
    `Use "${alias.view} ${alias.sub}" instead.\n`
  );

  return [alias.view, alias.sub, ...positionals.slice(1)];
}
```

## Stage 5: Validate & Classify

### Pure Function Classification

Certain metadata about commands is needed before the handler runs -- for
example, whether a command requires an exclusive lock on the browser session.
These are expressed as pure classifier functions over the resolved command
entry:

```js
function commandNeedsLock(entry) {
  return entry.needsLock === true;
}

function commandIsReadOnly(entry) {
  return !entry.needsLock;
}

function commandRequiresBrowser(entry) {
  return entry.requiresBrowser !== false; // default true
}
```

These functions are pure (no side effects, no I/O) and can be freely composed
for pre-flight checks:

```js
async function preflight(cmdEntry, opts) {
  if (commandRequiresBrowser(cmdEntry) && !opts.headless && !await isBrowserRunning()) {
    throw new PreflightError("No browser session detected. Launch one first.");
  }

  if (commandNeedsLock(cmdEntry)) {
    const acquired = await tryAcquireLock(opts.lockFile);
    if (!acquired) {
      throw new PreflightError("Another instance holds the session lock.");
    }
  }
}
```

### Mutex Flag Groups

Some flags are mutually exclusive. This is validated after coercion:

```js
const MUTEX_GROUPS = [
  ["--output", "--stdout"],      // can't write to file AND stdout
  ["--headless", "--attach"],    // can't be headless AND attach to existing
];

function validateMutex(flags) {
  for (const group of MUTEX_GROUPS) {
    const present = group.filter(f => flags[f] !== undefined);
    if (present.length > 1) {
      throw new ValidationError(
        `Flags ${present.join(" and ")} are mutually exclusive.`
      );
    }
  }
}
```

## Full Pipeline Assembly

```js
function parseAndRoute(argv) {
  // Stage 1: Normalize
  const normalized = normalize(argv);

  // Stage 2: Tokenize
  const { flags, positionals } = tokenize(normalized);

  // Stage 3: Coerce
  const opts = {
    delay:        parseDelaySpec(lastValue(flags["--delay"])),
    headless:     coerceBool(flags["--headless"] || ["true"]),
    verbose:      coerceVerbosity(flags["--verbose"] || []),
    requirements: parseRequirements(lastValue(flags["--requirements"])),
    output:       lastValue(flags["--output"]),
    selector:     lastValue(flags["--selector"]),
    timeout:      Number(lastValue(flags["--timeout"]) || "30000"),
  };

  // Stage 4: Route (with legacy alias expansion)
  const expanded = expandLegacyAlias(positionals);
  const { view, subcommand, entry, extraPositionals } = resolveCommand(expanded);

  // Stage 5: Validate
  validateMutex(flags);

  return {
    view,
    subcommand,
    handler: entry.handler,
    entry,
    opts,
    extraPositionals,
  };
}
```

## Testing Strategy

Each stage is a pure function (or nearly pure, excepting `@file` reads in
requirements parsing). Unit tests should cover:

* **Normalizer**: edge cases like `--no-no-flag`, empty args, `=` in values
* **Tokenizer**: unknown flags, missing arity, repeated flags
* **Coercion**: delay spec boundaries (`"0~0"`, `"999.9"`), verbosity cap
* **Router**: unknown view/subcommand, legacy alias emission, did-you-mean
* **Validator**: all mutex group combinations, required flag omission

Integration tests run the full `parseAndRoute` pipeline:

```js
// Example: full pipeline test
const result = parseAndRoute([
  "node", "webctl",
  "feed", "scroll",
  "--delay=0.5~1.5",
  "--no-headless",
  "-vv",
  "--requirements", "@preconditions.json",
]);

assert.equal(result.view, "feed");
assert.equal(result.subcommand, "scroll");
assert.equal(result.opts.headless, false);
assert.equal(result.opts.verbose, 2);
assert.deepEqual(result.opts.delay, { type: "range", min: 0.5, max: 1.5 });
```

## Design Decisions

**Zero dependencies.** The parser uses no external libraries. `process.argv`
is a string array; parsing it is straightforward. External option-parsing
libraries add transitive dependencies, bundle size, and API surface that must
be tracked for breaking changes.

**Last-value-wins semantics.** When a flag appears multiple times, the last
occurrence takes precedence. This allows wrapper scripts to prepend defaults
that user-supplied flags override.

**Strict unknown-flag rejection.** Unknown flags are errors, not silently
ignored. This prevents typos (`--heedless` instead of `--headless`) from
causing hard-to-diagnose misbehavior.

**Deprecation via stderr.** Legacy alias warnings go to stderr so they do not
corrupt piped stdout output. The exit code is unaffected; the command still
runs.

**Delay ranges use `~` separator.** The tilde was chosen over `-` (conflicts
with negative numbers) and `..` (ambiguous with file paths). The `~` character
is unambiguous and shell-safe without quoting.
