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
# CTLAI_WEBCTL_PORT=4327

# Browser profile directory.
# Type: path  Default: ~/.config/ctlai/webctl/profile
# CTLAI_WEBCTL_PROFILE_DIR=
```

### Environment Variable Prefix

All environment variables follow a three-segment prefix:

```
{ORG}_{TOOLNAME}_{SETTING}
```

* **ORG** -- organization-level namespace (uppercase).
* **TOOLNAME** -- the specific tool (uppercase, underscores for multi-word).
* **SETTING** -- the individual knob (uppercase).

Example: `CTLAI_WEBCTL_PORT`, `CTLAI_WEBCTL_HEADLESS`.

This prevents collisions across tools and makes `env | grep CTLAI_` a quick
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
simultaneously, the loader prefers the XDG-style path and emits a **warning**:

```
WARN: Found .env.webctl in both ~/.config/ctlai/webctl/ and ~/
      Using ~/.config/ctlai/webctl/.env.webctl (XDG-style).
      Remove ~/.env.webctl to silence this warning.
```

XDG is preferred because it is the standard, and the home-directory shorthand
exists only as a convenience for quick setups.

### Missing Dotenv Behavior

When no `.env.{tool}` file is found at any location, the tool starts normally
using built-in defaults and any values supplied via environment variables or CLI
flags. At verbose log level, an INFO message notes the absence:

```
INFO: No .env.webctl found; using defaults. Copy dotenv.webctl.example to get started.
```

This is intentional -- the dotenv file is a convenience, not a requirement.

## Precedence Chain

The recommended resolution order, from lowest to highest priority:

```
1. Built-in defaults        (code constants)
2. Legacy environment vars   (WEBCTL_PORT, BROWSER_PORT -- deprecated)
3. Dotenv file               (.env.{tool})
4. Environment variables     (exported CTLAI_WEBCTL_* in shell)
5. CLI flags                 (--port=4999)
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
7. **Export prefix** -- if a line starts with `export `, the prefix is
   stripped before parsing. This allows operators to paste lines from their
   shell configuration without modification.
8. **Unmatched quotes** -- if a value starts with `'` or `"` but does not
   end with the matching quote, the value is kept as-is (including the
   opening quote) and a WARN is logged. No multi-line semantics.
9. **Duplicate keys** -- the last occurrence wins. A warning is logged at
   debug level.

### Pseudocode

```
function parse_dotenv(path):
    result = {}
    for line in read_lines(path):
        stripped = line.strip()
        if stripped == "" or stripped[0] == '#':
            continue
        if stripped starts with "export ":
            stripped = stripped[7:]
        idx = stripped.index_of('=')
        if idx < 0:
            warn("malformed line, skipping")
            continue
        key = stripped[0:idx].strip()
        val = stripped[idx+1:].strip()
        if (val starts with '"' and ends with '"') or
           (val starts with "'" and ends with "'"):
            val = val[1:-1]
        else if val starts with '"' or val starts with "'":
            warn("unmatched quote, treating as literal")
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

Some tools historically used shorter prefixes (e.g., `WEBCTL_PORT`) or
unprefixed names (e.g., `BROWSER_PORT`). These are supported **above built-in defaults but below the dotenv file** in the
precedence chain, allowing existing setups to keep working while encouraging
migration to the canonical names. A deprecation warning is
emitted when a legacy variable is detected:

```
WARN: WEBCTL_PORT is deprecated. Use CTLAI_WEBCTL_PORT instead.
WARN: BROWSER_PORT is deprecated. Use CTLAI_WEBCTL_PORT instead.
```

The migration path: `BROWSER_PORT` → `WEBCTL_PORT` → `CTLAI_WEBCTL_PORT`.
Only the fully-qualified form is considered canonical going forward.

## Error Handling

| Condition | Behavior |
|-----------|----------|
| Dotenv file not found | Continue with defaults; INFO at verbose level |
| Dotenv parse error (malformed line) | Skip line, WARN with line number |
| Ambiguous global locations | WARN, prefer XDG-style path |
| Unknown variable in dotenv | Silently ignored (forward compatibility) |
| Invalid value type (e.g., non-integer port) | Hard error with message naming the variable and expected type |
| Duplicate key in dotenv | Last value wins, DEBUG warning |
| Unmatched quote in value | Keep as literal, WARN with line number |
| `export ` prefix on line | Silently stripped before parsing |
| Legacy env var detected | Used (above defaults), WARN with canonical name |

## Operator Workflow

### Initial Setup

```bash
# Copy the example template
cp dotenv.webctl.example .env.webctl

# Edit to taste
$EDITOR .env.webctl

# Run the tool -- it picks up .env.webctl automatically
webctl serve
```

### Per-Project Override

```bash
# In a specific project directory
cp /path/to/dotenv.webctl.example .env.webctl
# Customize port to avoid collision with global instance
echo "CTLAI_WEBCTL_PORT=5100" >> .env.webctl
```

### One-Off Override

```bash
# CLI flag beats everything
webctl serve --port=9999

# Or via environment variable
CTLAI_WEBCTL_PORT=9999 webctl serve
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
