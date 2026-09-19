# Changelog

All notable changes to the Ferry CLI. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [semver](https://semver.org/spec/v2.0.0.html).

The repetition here is the point: a changelog is dozens of near-identical short list items with inline code and links, which is a different rendering load from prose.

## [Unreleased]

### Added
- `ferry sailings watch --json` streams newline-delimited JSON instead of redrawing.

### Fixed
- `--from tomorrow` resolved against UTC rather than the local zone.

---

## [2.4.0] — 2044-05-02

### Added
- `capacity.sold` on sailing responses ([#812](https://example.com/pr/812)).
- `ferry auth whoami` prints scopes and expiry.
- Shell completions for `zsh` and `fish` (`ferry completions <shell>`).

### Changed
- `sailings list` defaults to `--limit 50`, was `20`.
- Table output uses the terminal width instead of a fixed 80 columns.

### Fixed
- `429` responses now respect `Retry-After` instead of a flat 1 s backoff ([#804](https://example.com/pr/804)).
- Cancelled sailings were shown as `scheduled` in `watch`.

### Deprecated
- `--offset`. Use `--cursor`. Removal in 3.0.

## [2.3.1] — 2044-04-11

### Fixed
- Crash on empty `data` array when a route has no sailings in range.
- `auth login --token-stdin` left a trailing newline in the stored token.
- Windows: credentials file was created world-readable.

## [2.3.0] — 2044-03-28

### Added
- Cursor pagination across every list command.
- `--json` on all read commands.
- `FERRY_BASE_URL` for pointing at a staging environment.

### Changed
- Minimum Node version is now 20.
- Errors print `request_id` on the last line, always.

### Removed
- `ferry legacy-export`, deprecated since 2.0.

## [2.2.0] — 2044-02-19

### Added
- `booking.cancelled` webhook event.
- `ferry webhooks test` sends a signed sample payload to your endpoint.

### Fixed
- Signature verification rejected payloads containing a lone `\r`.
- `watch` flickered when the terminal did not report its size.

## [2.1.0] — 2044-01-22

### Added
- `ferry bookings create --dry-run` prices a booking without creating it.
- `--vessel-id` filter on `sailings list`.

### Changed
- Timestamps print in the local zone with an explicit offset; `--utc` restores the old behaviour.

### Fixed
- Idempotency keys were not sent on retry, so a retried create could double-book.

## [2.0.0] — 2043-12-05

### Added
- v2 API support.
- Structured error envelope with `code` and `request_id`.

### Changed
- **Breaking:** `ferry list` split into `ferry sailings list` and `ferry bookings list`.
- **Breaking:** config moved from `~/.ferryrc` to `~/.config/ferry/config.toml`. Run `ferry config migrate`.
- **Breaking:** exit code is `2` for usage errors, `1` for API errors, `0` for success.

### Removed
- **Breaking:** v1 API support.
- **Breaking:** `--format=csv`. Pipe `--json` through `jq -r '@csv'`.

## [1.9.4] — 2043-11-14

### Fixed
- Regression in 1.9.3 where `--route` was case-sensitive.

## [1.9.3] — 2043-11-02

### Fixed
- Double-booked vessels were not reported (see postmortem 2043-11-02).
- Memory growth in long-running `watch` sessions.

## [1.9.0] — 2043-10-10

### Added
- `ferry sailings watch`.
- `--interval` accepts humanised durations (`30s`, `5m`).

[Unreleased]: https://example.com/compare/v2.4.0...HEAD
[2.4.0]: https://example.com/compare/v2.3.1...v2.4.0
[2.3.1]: https://example.com/compare/v2.3.0...v2.3.1
[2.3.0]: https://example.com/compare/v2.2.0...v2.3.0
[2.2.0]: https://example.com/compare/v2.1.0...v2.2.0
[2.1.0]: https://example.com/compare/v2.0.0...v2.1.0
[2.0.0]: https://example.com/compare/v1.9.4...v2.0.0
