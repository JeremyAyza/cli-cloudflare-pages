# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Agent Skill (`skills/cf-pages/`) with a command reference and diagnosis recipes, shipped in the npm package.

### Fixed

- `--json` now always prints one document: `env get --reveal`, `env set` with nothing to change, and `deployments logs --output` printed raw text or nothing.
- `projects show` no longer reports active watch paths for the dashboard default (include `*`, no excludes).

## [0.1.0] - 2026-10-21

### Added

- Safe, agent-friendly CLI for Cloudflare Pages git-connected projects.
- Authentication with system keychain and user file storage (`login`, `logout`, `whoami`).
- Project diagnosis and pipeline state inspection (`projects list`, `projects show`).
- Deployment lifecycle management (`deployments list`, `show`, `logs`, `redeploy`, `retry`, `rollback`).
- Masked environment variable diffing and planning (`env list`, `get`, `set`, `unset`).
- Dashboard deep links (`dashboard`).
