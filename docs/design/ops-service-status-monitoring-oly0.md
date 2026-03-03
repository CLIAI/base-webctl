---
id: oly0
title: "Service Status Monitoring: Health Checks & Error Context Enrichment"
category: ops
created: "2026-03-03"
updated: "2026-03-03"
status: draft
tags: [service-status, health-check, monitoring, atom-feed, error-context, automation-gating]
tech: []
relates_to: []
depends_on: []
expands: []
similar_to: []
---

# Service Status Monitoring: Health Checks & Error Context Enrichment

## Motivation

When a web automation task fails, the root cause is frequently not a bug in the
tool itself but a degraded or unavailable upstream service. Operators waste
significant time debugging local configuration, retrying blindly, or escalating
issues that resolve themselves once the service recovers.

A lightweight, built-in status-monitoring capability lets the CLI:

* **Surface service health before or during execution** so operators know whether
  a failure is local or upstream.
* **Enrich error messages** with live incident context, turning opaque timeouts
  into actionable diagnostics.
* **Gate CI/CD pipelines** on service availability, preventing wasted compute on
  runs that are doomed to fail.

All of this should work without authentication, without heavy dependencies, and
with minimal network overhead.

## Design Principles

1. **Zero-auth, zero-dep** -- status pages are public; parsing them must not
   pull in XML libraries beyond the standard library.
2. **Opt-in by default** -- status checks add latency; they fire automatically
   only at high verbosity or on error, unless the operator explicitly requests
   them.
3. **Cache-friendly** -- a single status fetch is reused across subcommands
   within the same invocation window.
4. **Service-agnostic** -- the design works with any service that publishes an
   Atom or RSS status feed. No hardcoded service names leak into the framework.

## Architecture Overview

```
┌──────────────┐       ┌────────────────┐       ┌──────────────────┐
│  CLI Command │──────▶│ Status Manager │──────▶│ Atom Feed Parser │
│  (any verb)  │       │  (cache layer) │       │  (zero-dep XML)  │
└──────────────┘       └────────────────┘       └──────────────────┘
       │                       │
       │ on error              │ cached result
       ▼                       ▼
┌──────────────┐       ┌────────────────┐
│ Error Context│◀──────│  Status Cache  │
│  Enrichment  │       │  (60s TTL)     │
└──────────────┘       └────────────────┘
```

### Component Responsibilities

* **Status Manager** -- entry point; decides whether to fetch, returns cached
  or fresh results; exposes `check()`, `assert_healthy()`, and `enrich_error()`.
* **Atom Feed Parser** -- minimal XML parser that extracts incident titles,
  timestamps, and severity from Atom/RSS feeds using only stdlib `xml.etree`
  or equivalent minimal parsing.
* **Status Cache** -- in-memory store with 60-second TTL, keyed by feed URL.
* **Error Context Enrichment** -- hooks into the global error handler to append
  recent incidents when a command fails.

## Standalone Status Command

The CLI exposes a dedicated `status` subcommand that requires no authentication
and no browser session:

```
webctl status [--feed-url <URL>] [--format json|text] [--assert]
```

### Behavior

1. Fetch the configured Atom/RSS status feed URL.
2. Parse the feed for recent entries (last 24 hours by default).
3. Display a summary:

```
Service Status: operational
Last checked: 2026-03-03T14:22:00Z (cached 12s ago)

Recent incidents (last 24h): none
```

Or when degraded:

```
Service Status: degraded
Last checked: 2026-03-03T14:22:00Z (live)

Recent incidents (last 24h):
  [2026-03-03T13:00:00Z] Elevated error rates on API endpoints
    Status: investigating
  [2026-03-03T11:30:00Z] Scheduled maintenance window
    Status: resolved
```

### Flags

| Flag              | Description                                        | Default               |
|-------------------|----------------------------------------------------|-----------------------|
| `--feed-url`      | Override the status feed URL                       | From config file      |
| `--format`        | Output format: `text` or `json`                    | `text`                |
| `--assert`        | Exit non-zero if service is not fully operational  | `false`               |
| `--window`        | Lookback window for recent incidents               | `24h`                 |
| `--cache-ttl`     | Override cache TTL in seconds                      | `60`                  |

## Auto-Check at High Verbosity

When the CLI runs with verbosity level 2 or higher (`-vv`), a status check fires
automatically at startup. This provides situational awareness without requiring
the operator to remember a separate command.

```
$ webctl -vv login
[status] Service: operational (cached 34s ago)
[status] No recent incidents.
Proceeding with login...
```

### Implementation Rules

* The auto-check is **non-blocking**: it runs in a background thread/task and
  joins with a 3-second timeout. If the fetch takes longer, the command
  proceeds without status information.
* The auto-check **never causes a command to fail**. Network errors during
  status fetch are silently swallowed (logged at debug level only).
* At verbosity level 1 (`-v`), status is fetched but only displayed if the
  service is degraded.
* At verbosity level 0 (default), no automatic status check occurs.

| Verbosity | Auto-fetch | Display condition            |
|-----------|------------|------------------------------|
| 0         | No         | --                           |
| 1 (`-v`)  | Yes        | Only if degraded/outage      |
| 2+ (`-vv`)| Yes        | Always                       |

## Error Context Enrichment Pattern

When any command fails with a network-related or timeout error, the error
handler consults the status cache (or performs a fresh fetch) and appends
relevant incident information to the error output.

### Flow

```
Command fails
  └──▶ Is error network-related or timeout?
         ├── No  ──▶ Standard error output
         └── Yes ──▶ Fetch/read status cache
                       ├── Service operational ──▶ Standard error + note:
                       │     "Service reports operational; issue may be local."
                       └── Service degraded ──▶ Enriched error:
                             "Service is experiencing issues:
                              [incident title] — [status]
                              Check: [status page URL]"
```

### Enriched Error Example

```
Error: Connection timed out after 30s

Service status (as of 2026-03-03T14:22:00Z):
  Active incident: "Elevated error rates on API endpoints"
  Severity: major
  Status: investigating
  Details: https://status.example.com/incidents/abc123

Suggestion: The service is experiencing known issues. Retry later or
monitor the status page for updates.
```

### Error Classification

The enrichment triggers on these error categories:

* Connection timeout
* Connection refused
* DNS resolution failure
* HTTP 5xx responses
* HTTP 429 (rate limit) responses
* WebSocket connection failures
* TLS handshake failures

Non-network errors (e.g., element-not-found, invalid selector, file I/O) do
not trigger status enrichment.

## Assert Mode for CI Gating

The `--assert` flag transforms the status command into a CI-friendly gate:

```bash
# In CI pipeline, before running the automation suite:
webctl status --assert || {
  echo "Service degraded, skipping automation run"
  exit 0
}
```

### Exit Codes

| Exit Code | Meaning                                |
|-----------|----------------------------------------|
| 0         | Service fully operational              |
| 1         | Service degraded or partial outage     |
| 2         | Service major outage                   |
| 3         | Unable to determine status (fetch fail)|

### JSON Output for CI Integration

```json
{
  "status": "degraded",
  "checked_at": "2026-03-03T14:22:00Z",
  "cached": false,
  "incidents": [
    {
      "title": "Elevated error rates on API endpoints",
      "severity": "major",
      "status": "investigating",
      "updated_at": "2026-03-03T13:00:00Z",
      "url": "https://status.example.com/incidents/abc123"
    }
  ],
  "feed_url": "https://status.example.com/feed.atom"
}
```

## Zero-Dependency Atom Feed Parsing

Most public status pages publish Atom or RSS feeds. The parser must handle
both formats without pulling in `feedparser` or similar third-party libraries.

### Parsing Strategy

Use stdlib XML parsing (`xml.etree.ElementTree` in Python, or equivalent in
the implementation language) with namespace-aware element access:

```
Atom namespace: http://www.w3.org/2005/Atom
RSS: no namespace (plain XML)
```

### Extracted Fields

From each feed entry:

| Feed Element         | Mapped Field   | Fallback               |
|----------------------|----------------|------------------------|
| `<title>`            | `title`        | `"(untitled)"`         |
| `<updated>`/`<pubDate>` | `updated_at` | `"(unknown)"`        |
| `<link>`             | `url`          | Feed URL itself        |
| `<content>`/`<description>` | `body`  | `""`                  |

### Severity Heuristic

Status feeds do not have a standardized severity field. The parser infers
severity from keywords in the entry title and body:

| Keywords detected                          | Inferred severity |
|--------------------------------------------|-------------------|
| `major`, `outage`, `unavailable`, `down`   | `major`           |
| `degraded`, `elevated`, `partial`, `slow`  | `minor`           |
| `maintenance`, `scheduled`, `planned`      | `maintenance`     |
| `resolved`, `completed`, `fixed`           | `resolved`        |
| (none matched)                             | `unknown`         |

### Robustness

* Malformed XML: catch parse errors, return empty incident list, log warning.
* Non-Atom/RSS content: detect via content-type or root element, return empty.
* Encoding: assume UTF-8, fall back to latin-1 if decode fails.
* Large feeds: parse only the first 20 entries to bound memory and time.

## Caching (60-Second TTL)

### Design

The status cache is a simple in-memory dictionary mapping feed URL to a
`CachedResult` struct:

```
CachedResult:
  fetched_at: datetime
  ttl: int (seconds, default 60)
  status: str
  incidents: list[Incident]
  raw_http_status: int
```

### Cache Behavior

* **Hit**: If `now - fetched_at < ttl`, return cached result immediately.
* **Miss**: Fetch feed, parse, store in cache, return result.
* **Stale on error**: If a fresh fetch fails but a stale cached result exists,
  return the stale result with a `stale: true` flag and log a warning.
* **No cache persistence**: The cache lives only for the duration of the
  process. No file-based caching -- each CLI invocation starts fresh.

### Why 60 Seconds

* Status pages update at most every few minutes during active incidents.
* 60 seconds prevents hammering the feed during retry loops or multi-step
  command sequences.
* The TTL is configurable via `--cache-ttl` for operators who need fresher
  data or want to reduce network calls further.

### Thread Safety

The cache must be safe for concurrent access since the auto-check runs in a
background thread while the main command executes. Use a simple mutex/lock
around cache reads and writes.

## Configuration

Status feed URLs are configured per-service in the tool's configuration file:

```yaml
status:
  feed_url: "https://status.example.com/feed.atom"
  cache_ttl: 60
  auto_check_verbosity: 2
```

The `feed_url` can also be set via environment variable:

```
WEBCTL_STATUS_FEED_URL=https://status.example.com/feed.atom
```

Environment variable takes precedence over config file, and `--feed-url` CLI
flag takes precedence over both.

## Integration Points

* **Global error handler**: Calls `enrich_error()` on network-class failures.
* **CLI startup hook**: At sufficient verbosity, calls `check()` in background.
* **CI pipelines**: Use `webctl status --assert --format json` as a gate step.
* **Logging subsystem**: Status check results logged at debug level for
  post-mortem analysis.

## Non-Goals

* **Replacing dedicated monitoring tools** -- this is lightweight situational
  awareness, not a full monitoring stack.
* **Status page scraping** -- only structured feeds (Atom/RSS) are supported.
  HTML status pages require a browser and are out of scope.
* **Push notifications** -- this is pull-based and on-demand only.
* **Historical trend analysis** -- the tool reports current state, not SLA
  metrics over time.
