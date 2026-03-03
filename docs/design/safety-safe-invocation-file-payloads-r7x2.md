---
id: r7x2
title: "Safe Invocation: Array Arguments, File Payloads & Input Security"
category: safety
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [safe-invocation, injection-prevention, file-payloads, stdin, shell-escaping, security]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Safe Invocation: Array Arguments, File Payloads & Input Security

## Motivation

CLI tools that invoke subprocesses or accept file-based input face two related
threat surfaces:

* **Shell injection** — when arguments are passed through a shell interpreter,
  metacharacters (`; | & $ \``) can escape intended argument boundaries and
  execute arbitrary commands.
* **Path traversal / untrusted input** — when file paths or stdin content are
  accepted without validation, attackers can read or write outside intended
  directories, or inject control sequences into processing pipelines.

Both classes of vulnerability are preventable by construction. This document
describes the universal principles and patterns that eliminate them.

## Principle 1: Arguments as Arrays, Never via Shell

### The Rule

**Always pass subprocess arguments as an array of strings. Never construct a
command string and hand it to a shell.**

Direct process spawning bypasses all shell interpretation. There is no
metacharacter expansion, no glob expansion, no word splitting, and no injection
surface.

### Language Patterns

| Language | Unsafe (shell-mediated)               | Safe (array-based)                    |
|----------|---------------------------------------|---------------------------------------|
| Python   | `os.system("cmd " + arg)`            | `subprocess.run(["cmd", arg])`        |
| Python   | `subprocess.run(cmd, shell=True)`     | `subprocess.run(cmd_list)`            |
| Node.js  | `child_process.exec("cmd " + arg)`   | `child_process.spawn("cmd", [arg])`   |
| Go       | `exec.Command("sh", "-c", cmdStr)`   | `exec.Command("cmd", "arg1", "arg2")` |
| Rust     | `std::process::Command::new("sh").arg("-c").arg(s)` | `Command::new("cmd").arg(arg)` |

### Why `shell=True` / `sh -c` Is Always Wrong for Dynamic Input

Even when arguments are "escaped," edge cases remain:

* Locale-dependent quoting rules
* Nested quoting (arguments containing quotes)
* Null bytes, newlines, and control characters
* Platform-specific shell differences

Array-based invocation eliminates the entire class of problems. There is no
quoting to get wrong.

### Exception: Static Command Strings

Shell invocation is acceptable only when the entire command string is a
compile-time constant with zero dynamic components:

```python
# Acceptable — fully static, no user input
subprocess.run("sort | uniq", shell=True)

# Never acceptable — any dynamic component
subprocess.run(f"sort {filename} | uniq", shell=True)
```

Even in the static case, prefer array-based invocation when practical.

## Principle 2: File-Based Payload Resolution

### The Problem

CLI arguments have length limits (typically 128 KB-2 MB depending on OS) and
are visible in process listings (`ps`, `/proc`). For large or sensitive content,
file-based input is both more robust and more secure.

### Input Source Priority Chain

When a CLI tool accepts message or payload content, resolve the source using
this priority order:

| Priority | Flag / Mechanism       | Source | Use Case                          |
|----------|------------------------|--------|-----------------------------------|
| 1        | `--message-file <path>`| File   | Large content, saved drafts, automation |
| 2        | `--stdin` or `-`       | stdin  | Pipes, here-docs, programmatic input    |
| 3        | positional / `--message`| CLI   | Short messages, interactive use         |

**Only one source is active.** If `--message-file` is provided, ignore stdin
and CLI arguments for the message field. If `--stdin` is provided, ignore CLI
arguments.

### Implementation Pattern

```
resolve_message(args):
    if args.message_file:
        validate_path(args.message_file)
        return read_file(args.message_file)
    if args.stdin or stdin_is_piped():
        return read_stdin_with_timeout()
    if args.message:
        return args.message
    error("no message provided")
```

## Principle 3: Stdin Handling

### TTY Detection

Before reading stdin, detect whether it is connected to a terminal (TTY) or a
pipe:

* **Piped** — read until EOF, subject to timeout.
* **TTY (interactive)** — warn the user or refuse. Reading from an interactive
  terminal without explicit `--stdin` is almost always a mistake.

```
if is_tty(stdin) and not args.explicit_stdin:
    warn("stdin is a terminal; use --stdin to read interactively")
    exit(1)
```

### Timeout

Apply a read timeout (recommended: 5 seconds) when reading from stdin to
prevent indefinite hangs in automation pipelines where a pipe was expected but
not connected:

```
data = read_stdin(timeout=5s)
if timeout_expired and no_data:
    error("stdin read timed out — is input piped?")
```

### Auto-Detection of Format

When stdin content format is ambiguous, use lightweight heuristics:

* First line starts with `{` or `[` — treat as JSON/JSONL
* Otherwise — treat as plain text

Apply a short initial read (e.g., 200 ms or first 4 KB) to make the
determination, then continue reading the full stream in the detected mode.

## Principle 4: Path Validation

### Path Traversal Prevention

Any user-supplied file path must be validated before use:

1. **Resolve to absolute path** — use the language's canonical path resolution
   (e.g., `os.path.realpath`, `filepath.Abs`, `fs.realpathSync`).
2. **Verify containment** — the resolved path must be within the expected
   directory (output directory, working directory, or explicitly allowed root).
3. **Reject traversal** — if the resolved path escapes the allowed root,
   reject with a clear error.

```
def validate_path(user_path, allowed_root):
    resolved = realpath(user_path)
    if not resolved.startswith(allowed_root):
        error(f"path escapes allowed directory: {user_path}")
    return resolved
```

### Symlink Handling

Resolve symlinks before checking containment. A symlink inside the allowed
directory can point outside it. Always operate on the fully resolved path.

### Filename Sanitization

When a filename is derived from user input (e.g., saving output with a
user-suggested name):

* Strip or replace path separators (`/`, `\`)
* Strip null bytes
* Limit length (255 bytes is the common filesystem limit)
* Reject or replace characters problematic on target OS (`:`, `*`, `?`, `"`,
  `<`, `>`, `|` on some systems)

## Principle 5: Treating All External Input as Untrusted

### Stdin Content

* Never `eval()` or `exec()` stdin content
* Never pass stdin content to a shell
* Parse with a proper parser (JSON parser for JSON, etc.)
* Validate structure and types after parsing

### File Content

* Enforce expected encoding (UTF-8, reject or replace invalid sequences)
* Validate file size before full read (prevent memory exhaustion)
* Apply content-type-specific validation after reading

### Environment Variables

* Treat environment variable values the same as user input
* Validate and sanitize before use in subprocess arguments or file paths

## Principle 6: Avoiding Temporary Files

### Prefer Streaming

When transferring data between processes, prefer pipes and streams over
temporary files:

* Temporary files require cleanup, have permission concerns, and may leak
  sensitive data if the process crashes.
* Pipes provide automatic cleanup and in-memory transfer.

### When Temp Files Are Necessary

If temporary files cannot be avoided (e.g., a subprocess requires a file path):

* Use the OS-provided secure temp directory
* Generate unpredictable filenames (use `mkstemp` or equivalent)
* Set restrictive permissions (owner-only read/write)
* Delete immediately after use in a `finally` / `defer` block
* Never include user-controlled components in the temp filename

## Security Checklist

For any CLI tool that invokes subprocesses or accepts file input, verify:

* [ ] All subprocess invocations use array-based argument passing
* [ ] No `shell=True`, `sh -c`, or equivalent with dynamic input
* [ ] File paths are resolved and checked against an allowed root
* [ ] Symlinks are resolved before containment checks
* [ ] stdin is read with a timeout
* [ ] TTY detection prevents accidental interactive reads
* [ ] Input encoding is validated (UTF-8)
* [ ] No `eval()` or `exec()` on external input
* [ ] Temporary files (if any) use secure creation and are cleaned up
* [ ] Error messages do not leak internal paths or system information

## Summary

| Threat                   | Mitigation                                      |
|--------------------------|--------------------------------------------------|
| Shell injection          | Array-based subprocess invocation                |
| Argument length overflow | File-based payload with priority resolution      |
| Process listing exposure | File or stdin input instead of CLI arguments     |
| Stdin hang               | Timeout + TTY detection                          |
| Path traversal           | Resolve + containment check against allowed root |
| Symlink escape           | Resolve symlinks before containment check        |
| Encoding attack          | UTF-8 enforcement with invalid-sequence rejection|
| Temp file leak           | Prefer streaming; secure creation + cleanup      |
| Input code execution     | Never eval/exec external input                   |
