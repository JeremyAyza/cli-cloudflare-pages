# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-21

### Added

- Safe, agent-friendly CLI for Cloudflare Pages git-connected projects.
- Authentication with system keychain and user file storage (`login`, `logout`, `whoami`).
- Project diagnosis and pipeline state inspection (`projects list`, `projects show`).
- Deployment lifecycle management (`deployments list`, `show`, `logs`, `redeploy`, `retry`, `rollback`).
- Masked environment variable diffing and planning (`env list`, `get`, `set`, `unset`).
- Dashboard deep links (`dashboard`).
