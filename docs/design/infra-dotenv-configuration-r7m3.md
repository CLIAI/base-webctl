---
id: r7m3
title: "Dotenv Configuration System & Precedence Chain"
category: infra
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [config, dotenv, environment-variables, precedence-chain, zero-dep-parser, isolation]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Dotenv Configuration System & Precedence Chain

## Motivation

Web-control CLI tools need runtime configuration for ports, browser profiles,
timeouts, and feature flags. Hard-coding values breaks multi-tool setups where
several tools run concurrently on the same machine. Relying solely on CLI flags
creates long, error-prone command lines for recurring settings.

A dotenv-based configuration layer solves this by:

* Letting operators persist per-tool settings in a single file.
* Keeping secrets out of shell history (unlike CLI flags).
* Supporting per-project overrides without touching global config.
* Requiring zero external dependencies for parsing.

## Naming Conventions

### Dotenv Files

Each tool stores its configuration in a dedicated file:

```
.env.{toolname}
```

This file is **gitignored**. It contains real credentials, ports, and
environment-specific values that must not be committed.

### Example Templates

A tracked template ships with the source:

```
dotenv.{toolname}.example
```

The `dotenv.` prefix (instead of `.env.`) is intentional -- it avoids being
caught by broad `.env*` gitignore globs, ensuring the template is always
version-controlled.

The template contains every supported variable with a comment explaining its
purpose, type, and default:

```bash
# Port for the browser bridge server.
# Type: integer  Default: 4327
# CLIAI_MYTOOL_PORT=4327

# Browser profile directory.
# Type: path  Default: ~/.config/org/mytool/profile
# CLIAI_MYTOOL_PROFILE_DIR=
```

### Environment Variable Prefix

All environment variables follow a three-segment prefix:

```
{ORG}_{TOOLNAME}_{SETTING}
```

* **ORG** -- organization-level namespace (uppercase).
* **TOOLNAME** -- the specific tool (uppercase, underscores for multi-word).
* **SETTING** -- the individual knob (uppercase).

Example: `CLIAI_WEBCTL_PORT`, `CLIAI_WEBCTL_HEADLESS`.

This prevents collisions across tools and makes `env | grep CLIAI_` a quick
debugging aid.

## Discovery Locations

The loader searches for dotenv files in a fixed sequence of locations. The
first file found wins; later locations are not merged.

```
Priority (highest first):

1. $CWD/.env.{tool}                     project-local override
2. ~/.config/{org}/{tool}/.env.{tool}    XDG-style global config
   OR  ~/.env.{tool}                    home-directory shorthand
3. (none found)                         fall through to defaults
```

### Ambiguity Detection

If **both** global locations (XDG-style and home shorthand) exist
simultaneously, the loader emits a **hard error** and refuses to start. This
prevents silent precedence surprises when an operator forgets which file is
active.

```
ERROR: Found .env.mytool in both ~/.config/org/mytool/ and ~/
       Remove one to resolve ambiguity.
```

### Missing Dotenv Behavior

When no `.env.{tool}` file is found at any location, the tool starts normally
using built-in defaults and any values supplied via environment variables or CLI
flags. At verbose log level, an INFO message notes the absence:

```
INFO: No .env.mytool found; using defaults. Copy dotenv.mytool.example to get started.
```

This is intentional -- the dotenv file is a convenience, not a requirement.

## Precedence Chain

The recommended resolution order, from lowest to highest priority:

```
1. Built-in defaults        (code constants)
2. Dotenv file               (.env.{tool})
3. Environment variables     (exported in shell)
4. CLI flags                 (--port=4999)
```

### Rationale

* **Defaults** anchor the baseline so the tool works with zero configuration.
* **Dotenv** overrides defaults for persistent, per-environment tuning.
* **Environment variables** override dotenv for CI/CD pipelines,
  containerized runs, and scripted invocations where dotenv files are
  impractical.
* **CLI flags** have the highest priority because they represent the
  operator's explicit, immediate intent and must always be respected.

### Alternative Orderings Considered

Some tools in the ecosystem historically placed dotenv above CLI flags,
treating the dotenv file as an "always-win" persistent config. This proved
confusing when operators tried to do one-off overrides via flags and saw them
silently ignored. The recommended order above avoids that pitfall.

Another variant inserted a "global config file" layer between defaults and
dotenv. While valid for tools with complex multi-file config, the added
indirection is unnecessary for most CLI tools and is deferred to a future
design document if needed.

## Zero-Dependency Parser

The dotenv parser is implemented directly in the tool's language with no
external library. This keeps the dependency tree minimal and avoids behavioral
differences across dotenv library versions.

### Parsing Rules

1. **Blank lines** -- skipped.
2. **Comment lines** -- lines where the first non-whitespace character is `#`
   are skipped.
3. **Key-value lines** -- split on the first `=` sign. Leading/trailing
   whitespace around key and value is trimmed.
4. **Quoted values** -- if the value is wrapped in matching single or double
   quotes, the outer quotes are stripped. No escape processing inside quotes.
5. **No variable expansion** -- `$VAR` or `${VAR}` in values is treated as
   literal text. This avoids a class of injection bugs and keeps the parser
   trivial.
6. **No multi-line values** -- each key-value pair occupies exactly one line.
7. **No export prefix** -- lines starting with `export ` are not special;
   `export` would be treated as part of the key name (and thus not match
   any expected variable).
8. **Duplicate keys** -- the last occurrence wins. A warning is logged at
   debug level.

### Pseudocode

```
function parse_dotenv(path):
    result = {}
    for line in read_lines(path):
        stripped = line.strip()
        if stripped == "" or stripped[0] == '#':
            continue
        idx = stripped.index_of('=')
        if idx < 0:
            warn("malformed line, skipping")
            continue
        key = stripped[0:idx].strip()
        val = stripped[idx+1:].strip()
        if (val starts with '"' and ends with '"') or
           (val starts with "'" and ends with "'"):
            val = val[1:-1]
        result[key] = val
    return result
```

## Per-Tool Isolation

### Port Allocation

Each tool in the framework uses a **distinct default port** to allow concurrent
operation without collisions. Ports are chosen from the dynamic/private range
(49152-65535) or from an organization-reserved block in the registered range.

The chosen port is always overridable via the `{ORG}_{TOOLNAME}_PORT`
environment variable or CLI flag.

### Browser Profile Isolation

Each tool maintains its own browser profile directory:

```
~/.config/{org}/{tool}/profile/
```

This ensures that cookies, local storage, and session state for one tool do not
leak into another. It also allows concurrent tools to run separate browser
instances without lock contention on a shared profile.

### Legacy Environment Variable Support

Some tools historically used unprefixed variable names (e.g., `BROWSER_PORT`).
These are supported at the **lowest priority** in the precedence chain -- below
even built-in defaults -- to avoid silently overriding the new namespaced
variables. A deprecation warning is emitted when a legacy variable is detected:

```
WARN: BROWSER_PORT is deprecated. Use CLIAI_MYTOOL_PORT instead.
```

## Error Handling

| Condition | Behavior |
|-----------|----------|
| Dotenv file not found | Continue with defaults; INFO at verbose level |
| Dotenv parse error (malformed line) | Skip line, WARN with line number |
| Ambiguous global locations | Hard error, refuse to start |
| Unknown variable in dotenv | Silently ignored (forward compatibility) |
| Invalid value type (e.g., non-integer port) | Hard error with message naming the variable and expected type |
| Duplicate key in dotenv | Last value wins, DEBUG warning |

## Operator Workflow

### Initial Setup

```bash
# Copy the example template
cp dotenv.mytool.example .env.mytool

# Edit to taste
$EDITOR .env.mytool

# Run the tool -- it picks up .env.mytool automatically
mytool serve
```

### Per-Project Override

```bash
# In a specific project directory
cp /path/to/dotenv.mytool.example .env.mytool
# Customize port to avoid collision with global instance
echo "CLIAI_MYTOOL_PORT=5100" >> .env.mytool
```

### One-Off Override

```bash
# CLI flag beats everything
mytool serve --port=9999

# Or via environment variable
CLIAI_MYTOOL_PORT=9999 mytool serve
```

## Implementation Checklist

* [ ] Define default port constant per tool.
* [ ] Implement zero-dep dotenv parser following the rules above.
* [ ] Implement multi-location discovery with ambiguity check.
* [ ] Wire precedence chain: defaults < dotenv < env vars < CLI flags.
* [ ] Ship `dotenv.{tool}.example` template with all supported variables.
* [ ] Add `.env.*` to `.gitignore`.
* [ ] Emit deprecation warnings for legacy unprefixed variables.
* [ ] Document supported variables in tool help output (`--help`).
* [ ] Add unit tests for parser edge cases (quotes, blanks, duplicates, malformed lines).
