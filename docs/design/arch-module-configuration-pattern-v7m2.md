---
id: v7m2
title: "Module Patterns: Configuration Objects, Context Injection & Multi-Binary Architecture"
category: arch
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [module-pattern, context-injection, configuration, dependency-injection, dual-mode, cli-architecture]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Module Patterns: Configuration Objects, Context Injection & Multi-Binary Architecture

## Motivation

As CLI tooling grows from a single script into a suite of cooperating modules,
three recurring problems arise:

1. **Module initialization** -- how does a module learn its runtime settings
   (verbosity, timeouts, feature flags) without hard-coding them or importing a
   god-object?
2. **Action wiring** -- how do action handlers receive the clients, helpers, and
   parsed arguments they need without deep coupling?
3. **Binary distribution** -- how can each subcommand be both a standalone
   executable *and* an importable library, discovered automatically by a router?

This document describes three complementary patterns that solve these problems
while keeping each module independently testable and free of circular
dependencies.

## Pattern 1: Module-Level Configuration Object

### Concept

Each module owns a private, mutable configuration object (`CFG`) initialized
with safe defaults. A single public `configure*()` function accepts a partial
options object and merges it into `CFG`. All exported functions read from `CFG`
at call time, never at import time.

### Structure

```
+--------------------+
|  Caller / main()   |
+---------+----------+
          |
          | configureXxx({ verbose: true, timeout: 5000 })
          v
+--------------------+        +---------------------+
|  Module xxx        |        |  Module yyy         |
|  let CFG = {...}   |        |  let CFG = {...}    |
|  configureXxx()    |        |  configureYyy()     |
|  doWork() -> CFG   |        |  process() -> CFG   |
+--------------------+        +---------------------+
```

### Reference Implementation

```js
// lib/xxx.js
let CFG = {
  verbose: false,
  timeout: 30000,
  retries: 3,
};

function configureXxx(opts) {
  Object.assign(CFG, opts);
}

function doWork(input) {
  if (CFG.verbose) console.error('[xxx] processing', input);
  // ... uses CFG.timeout, CFG.retries internally
}

module.exports = { configureXxx, doWork };
```

### Rules

* **One `configure*()` per module.** The function name includes the module name
  to avoid ambiguity when the caller configures several modules in sequence.

* **Call before use.** Configuration is a one-time, synchronous, startup-phase
  operation. Calling `configure*()` after work has started is undefined.

* **CLI args override config.** When a module is driven by a CLI entry point,
  parsed command-line flags always take priority over values set via
  `configure*()`.

* **Defaults must be safe.** A module that is imported but never configured must
  behave conservatively -- no destructive operations, reasonable timeouts, no
  output unless requested.

### Benefits

* No singletons, no service locator, no DI container.
* Each module is a plain file with zero framework dependencies.
* Unit tests call `configure*()` with test-specific values before each case.
* Configuration is explicit and auditable in the startup path.

### Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Forgotten `configure*()` call | Safe defaults ensure correctness, not just silence |
| Late mutation of CFG | Document the call-before-use contract; optionally freeze CFG after first function call in debug mode |
| Thread-safety (if applicable) | Irrelevant in single-threaded runtimes; for multi-threaded environments, use immutable snapshots |

## Pattern 2: Context Injection (CTX Object)

### Concept

Action handlers -- the functions that implement CLI subcommands -- receive a
single context object (`ctx`) as their sole parameter. The context bundles
everything the action needs: parsed arguments, protocol clients, output
helpers, delay functions, and logging.

### Structure

```
+--------------------------+
|  Router / dispatcher     |
|  builds ctx = {          |
|    args,                 |
|    protocolClient,       |
|    opDelay,              |
|    emitOutput,           |
|    logWarn, logInfo,     |
|    config,               |
|  }                       |
+-----------+--------------+
            |
            | ctx
            v
+---------------------------+
|  actionXxx(ctx)           |
|  destructures what it     |
|  needs from ctx           |
+---------------------------+
```

### Reference Implementation

```js
// actions/xxx.js
async function actionXxx(ctx) {
  const { args, protocolClient, opDelay, emitOutput, logWarn } = ctx;

  const result = await protocolClient.evaluate(args.expression);
  await opDelay(200);
  emitOutput({ type: 'result', value: result });
}

module.exports = { actionXxx };
```

### Rules

* **Actions never import shared state.** Everything arrives via `ctx`.

* **Destructure at the top.** Each action declares exactly which context
  members it uses, serving as living documentation of its dependencies.

* **The router builds the context.** A single location assembles `ctx` from
  parsed args, initialized clients, and configured helpers. This is the only
  place that knows how everything fits together.

* **Context is read-mostly.** Actions read from `ctx`; they do not mutate it.
  If an action must communicate state changes, it returns values or calls
  output helpers.

### Benefits

* **Zero circular dependencies.** Actions depend on nothing except their own
  logic and the shape of `ctx`.

* **Trivial to test.** Supply a mock `ctx` with stubs for each member; no file
  system, no browser, no network required.

* **Self-documenting.** The destructuring line at the top of each action is a
  manifest of its requirements.

* **Adding new actions is frictionless.** Write a function that accepts `ctx`,
  export it, register it with the router. No wiring changes elsewhere.

### Relationship to Pattern 1

Pattern 1 (module-level CFG) and Pattern 2 (CTX injection) are complementary:

* **CFG** configures *library* modules -- utilities that may be used by many
  actions (e.g., retry logic, output formatting, delay strategies).

* **CTX** supplies *action* modules -- the handlers that implement each CLI
  subcommand -- with their runtime dependencies.

A typical startup sequence:

1. Parse CLI arguments.
2. Call `configureXxx()` for each library module.
3. Build `ctx` from parsed args, configured libraries, and initialized clients.
4. Dispatch to the matching action, passing `ctx`.

## Pattern 3: Dual-Mode Files & Multi-Binary Discovery

### Concept

Each subcommand lives in a file that works in two modes:

* **Standalone binary** -- executed directly from the command line.
* **Importable module** -- `require()`-d by the router or by other tools.

A router discovers available subcommands at runtime by scanning a known
directory and optionally searching `PATH`.

### Dual-Mode File Structure

```js
// bin/tool-xxx.js
async function main(argv) {
  // parse argv, build ctx, run action
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { main };
```

### Help Integration Protocol

Every subcommand supports a `--help-oneliner` flag that prints a single line of
text describing the command. The router uses this to build aggregated help
output:

```
tool xxx  -- Perform xxx operation on the current page
tool yyy  -- Extract structured data from tables
tool zzz  -- Navigate to a URL and wait for idle
```

### Discovery Mechanism

```
+------------------+
|  Router          |
|  1. List bin/    |  -> tool-xxx.js, tool-yyy.js, ...
|  2. Search PATH  |  -> tool-zzz (external)
|  3. Match argv[0]|  -> dispatch
+------------------+
```

The router:

1. Lists all files matching `bin/tool-*.js` in the project directory.
2. Optionally searches `PATH` for executables matching the `tool-*` prefix.
3. Matches the user's subcommand argument against discovered names.
4. If the subcommand is local, `require()`-s the file and calls `main()`.
5. If external, spawns the process.

### Rules

* **Prefix consistency.** All subcommand files share a common prefix
  (`tool-` or similar) so the router's glob is unambiguous.

* **`--help-oneliner` is mandatory.** Any file that omits it is excluded from
  aggregated help.

* **Standalone mode is self-contained.** When run directly, the file must parse
  its own arguments, configure its own libraries, and build its own `ctx`. It
  must not assume the router has done any setup.

* **Module mode is minimal.** When imported, the file exports `main()` and
  optionally other functions. It must not produce side effects at import time.

### Benefits

* **Incremental migration.** A monolithic CLI can be split into subcommands one
  at a time. Each new subcommand is immediately usable both standalone and via
  the router.

* **External extensibility.** Third-party tools can participate in the router's
  discovery by placing appropriately named executables on `PATH`.

* **Development ergonomics.** During development, running a single subcommand
  directly avoids the router's overhead and simplifies debugging.

## Migration Strategy: Monolith to Modular

For codebases that start as a single large file and need to adopt these
patterns incrementally:

1. **Extract library modules first.** Identify repeated logic (retry, delay,
   output formatting) and move it to `lib/` files with `configure*()` setters.
   The main file calls `configure*()` during startup and continues to work.

2. **Introduce CTX in the main file.** Before dispatching to action logic,
   build a `ctx` object from parsed args and initialized helpers. Pass it to
   action functions even if they still live in the same file.

3. **Extract actions to separate files.** Move each action function to its own
   file under `actions/` or `bin/`. Each file accepts `ctx` and exports its
   handler.

4. **Add dual-mode wrappers.** Wrap each extracted action in the
   `if (require.main === module)` pattern so it can run standalone.

5. **Build the router.** Create a dispatcher that discovers subcommands,
   parses the top-level argument, and delegates.

Each step produces a working system. No big-bang rewrite is required.

## Summary

| Pattern | Solves | Scope | Key Artifact |
|---------|--------|-------|-------------|
| Module-level CFG | Module initialization without globals | Library modules in `lib/` | `configure*()` function |
| Context injection | Action wiring without coupling | Action handlers in `actions/` or `bin/` | `ctx` parameter |
| Dual-mode + discovery | Binary distribution and extensibility | Subcommand files in `bin/` | `require.main === module` guard |

These three patterns compose naturally: library modules use CFG, actions use
CTX (which may reference configured libraries), and the router discovers
dual-mode files that implement actions. The result is a CLI architecture where
each piece is independently testable, incrementally adoptable, and free of
circular dependencies.
