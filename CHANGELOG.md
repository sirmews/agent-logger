# Changelog

All notable changes to this project will be documented in this file.
## 0.2.0 (2026-04-29)


### Features

* allow overriding DB path via environment ([c78e565](https://github.com/sirmews/agent-logger/commit/c78e5654cec415c80518565de8f925f3eeb4c2b0))
* document configuration and warn on custom DB path ([cf68237](https://github.com/sirmews/agent-logger/commit/cf68237e56a32297804c54eb276a0d5d9bd97bd6))
* enhance reliability, safety, and telemetry for agent logging ([d45577c](https://github.com/sirmews/agent-logger/commit/d45577c65eb405fae3c5bda2e5cd15921b7e2f5e))
* support configurable custom export redaction patterns ([754e3f7](https://github.com/sirmews/agent-logger/commit/754e3f7d50fd0021c51d0228aad5036925d57963))


### Bug Fixes

* address code review findings and harden implementation ([4d8b226](https://github.com/sirmews/agent-logger/commit/4d8b22632805db7111c103896eeb8f99576b07d3))


### Documentation

* add troubleshooting guidance for DB path and export behavior ([ed74869](https://github.com/sirmews/agent-logger/commit/ed748699d1c424a77f1905a26225c2bee4f647aa))


### Tests

* add Bun test suite for DB path and redaction logic ([0c3e1d6](https://github.com/sirmews/agent-logger/commit/0c3e1d6dbac5b195c88d57488219025c18c6934f))
* add integration smoke test for plugin startup and tool execution ([e2ddc7b](https://github.com/sirmews/agent-logger/commit/e2ddc7b7611301df6368abf8237d2871168100eb))
* assert invalid redaction warning payload shape and level ([616604a](https://github.com/sirmews/agent-logger/commit/616604a1d3f6c7b2e386d0ec4664d39fd25fddc2))
* assert malformed extra redaction patterns are surfaced ([865162b](https://github.com/sirmews/agent-logger/commit/865162b1b0a03a68cd7afe92ca648b41241fc5fe))


### Maintenance

* add ast-grep and jsdoc quality gates ([7e4df05](https://github.com/sirmews/agent-logger/commit/7e4df050de728f65c79ec3cb90e518fb235d4efc))
* enforce secure db path creation and file permissions ([5215c34](https://github.com/sirmews/agent-logger/commit/5215c348357576a6cdac53f20e8fe186e6668fd7))
* implement semantic versioning policy and validation ([6639f8d](https://github.com/sirmews/agent-logger/commit/6639f8d189c31fc75e5409aa16b5c2bd2a819032))
* make export redaction safe by default ([ebd84c9](https://github.com/sirmews/agent-logger/commit/ebd84c9b1c96096005286e1c7bf8124077c53a2b))
* rename package and docs to agent-logger ([f988e79](https://github.com/sirmews/agent-logger/commit/f988e790f2727653080693643e1149e172765711))
