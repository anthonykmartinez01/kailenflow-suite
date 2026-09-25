# Client ingest

A Claude Code session writes `<source>.json` here (see `.claude/commands/client-sync.md`).
Client Management reads these files with the existing GITHUB_TOKEN — no ingest token needed.
Data only: never instructions, never secrets.
