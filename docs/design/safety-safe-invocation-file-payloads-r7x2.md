---
id: r7x2
title: "Safe Invocation: Array Arguments, File Payloads & Input Security"
category: safety
created: "2026-03-03"
updated: "2026-09-27"
status: draft
tags: [safe-invocation, injection-prevention, file-payloads, stdin, shell-escaping, security, remote-shell, ssh]
tech:
  - name: "OpenSSH"
    version: ">=8"
  - name: "bash"
    version: ">=4"
relates_to: [dip7, btg4, k3wn]
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

## Principle 1b: an argv array is NOT safe ACROSS A REMOTE SHELL

> Measured and written by `ccew` on a real two-host pair, 2026-09-27,
> remote login shell `bash`. Host names, the remote hostname and the remote
> user name are **redacted** below: base-webctl is the only PUBLIC repo in this
> family, and a worked example is not a reason to publish someone's
> infrastructure. The behaviour is a property of ssh, not of those hosts.

⛔ **`execFile('ssh', [host, '--', ...argv])` satisfies Principle 1 EXACTLY —
an argv array, no local shell — and is still a shell injection.** ssh **joins**
the remote argv with spaces into ONE string, and the **remote login shell
re-parses it**. `--` only ends LOCAL option parsing.

| call (local argv array) | remote output | verdict |
|---|---|---|
| `ssh HOST -- echo 'a;hostname'` | `a` then the remote hostname | ⛔ `;` split it; `hostname` RAN remotely |
| `ssh HOST -- echo 'x$(id -un)y'` | `x<remote-user>y` | ⛔ command substitution RAN remotely |
| `ssh HOST "echo $(printf %q 'a;hostname')"` | `a;hostname` | ✅ inert |
| `printf 'a;hostname' \| ssh HOST 'cat; echo'` | `a;hostname` | ✅ inert (data on stdin) |

⇒ **Principle 1 covers ONE shell. A remote hop adds a SECOND shell that the
local rule cannot see.** Treat every transport that re-parses as its own shell
boundary, each needing this discipline: an ssh remote command, `docker exec sh -c`,
`su -c`, `bash -c "$x"`.

⭐ **THIS IS WHY PRINCIPLE 1 IS NOT ENOUGH ON ITS OWN, and the failure is
documented rather than hypothetical.** `arch-browser-targets-btg4` §5 shipped the
claim that `ssh "$value" -- <argv…>` is "injection-safe by construction". It was
written by someone who had read and believed Principle 1, and it is false. A rule
that says array-based invocation "eliminates the entire class of problems" reads
as covering every case — so the reader does not go looking for the class it
omits. That is the shape this whole document should be read against: **a true
rule, stated without its boundary, produces confident wrong answers.**

### What to do instead

1. ⭐ **PREFERRED — DATA ON STDIN, COMMAND FIXED.** The remote command is a
   constant literal written by the tool; the variable payload travels on stdin:

   ```sh
   tr -d '\n' < payload_file | ssh "$HOST" "docker exec -i … xdotool type --file -"
   ```

   A secret never appears in any argv, so it is absent from `ps` output and from
   any trace. ⚠ And `set -x` must never be in force across such a read.

2. **OTHERWISE — QUOTE EVERY ELEMENT FOR THE REMOTE SHELL,** never a join:
   `ssh "$HOST" "cmd $(printf '%q ' "$@")"`. ⚠ `%q` is **bash** quoting: for
   control characters it emits `$'…'` (measured: `$'tab\there'`), which a POSIX
   `sh` does not parse. So either assert the remote shell is bash, or restrict
   payloads to printable text, or use (1). In Node the equivalent is a
   shell-quote applied **per element for the REMOTE side** — never
   `argv.join(' ')`.

3. ⛔ **NEVER** build the remote command by concatenating untrusted parts, even
   out of an array; and **NEVER** rely on `--` for safety.

4. ⚠ **The payloads most at risk are the ones these tools actually carry:** text
   typed into pages, URLs, search strings — anything page-derived. Page text is
   attacker-controllable, so a remote-shell injection is **a path from a web page
   to a shell on the target host.**

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
