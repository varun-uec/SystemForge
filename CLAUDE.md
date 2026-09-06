# CLAUDE.md

Coding standards live in [AGENTS.md](AGENTS.md). This file holds general
working preferences for Claude Code on this project. Treat these as defaults,
not hard rules; use judgement.

## Model selection

Use the most appropriate and lowest-cost model for the task at hand. Reach for
a cheaper, faster model when the work needs little reasoning (renames,
formatting, boilerplate, small mechanical edits, simple lookups, doc tweaks).
Step up to a stronger model for genuinely hard work: non-trivial design,
tricky debugging, multi-file refactors, anything where a wrong answer is
expensive.

## Working style

- Read the relevant code before changing it. Understand the flow first.
- Prefer the smallest change that actually solves the problem.
- Fix bugs at the root, not per-caller.
- Don't add abstractions, config, or scaffolding until something needs them.
- Reuse what's already in the repo before writing new helpers.
- Run `bun run test` after changes; paste real output rather than guessing.
- Leave commits to the maintainer.
