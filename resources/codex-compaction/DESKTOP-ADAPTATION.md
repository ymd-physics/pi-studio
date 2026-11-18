# Bundled Codex compaction

Source: the user's `Pi-Version-Manager/packages/pi-codex-compaction`, based on
`@ogulcancelik/pi-codex-compaction` 0.1.6 (MIT, Can Celik), with the local
`tools-compat` patch. `LOCAL-SOURCE.json` records the upstream/local source hashes;
those hashes describe the **input**, not the adapted Desktop files. Original
`native-compaction.ts` SHA-256: `e4fb9dd3230e313c8ea19e2a6ba040826cca96c88e1ade484ac672938cf3ddcc`.

Kept: native session details/checkpoint format, Codex request/response conversion,
64k retained-user-message budget, encrypted checkpoint replay, active-tool and
grammar compatibility, native auth resolution, retry policy, and native hooks.

Desktop adaptations:
- New small entrypoint instead of terminal rendering and pre-0.84.4 fallback.
- Pi >=1.4 stable-version gate; exact Codex provider/API and official endpoint only.
  Model admission is shared with the allowance UI through
  `packages/shared/codex-model.ts` (included alongside this adapter in the unpacked app).
  Unrelated/absent models leave compaction to Pi; quota errors do not disable Codex
  compaction, and incompatible encrypted checkpoints still fail closed.
- Native loader policy defers remote compaction to any installed compaction hook.
  Replay is deterministic/idempotent with the original plugin; it always validates
  recognized checkpoints rather than guessing that another provider hook owns them.
- RPC status reporting and protection against replay/compaction with a different
  model or endpoint. No translation of encrypted state to ordinary summaries.
- Redirect rejection, whole-operation timeout, 16 MiB response limit, body cleanup,
  capped retry delays, and corrected missing `retry-after-ms` parsing.

Tests: `PI_CORE_ROOT=/absolute/path/to/pi-coding-agent node --test tests/codex-compaction.test.mjs`
from the repository root. Tests use mocked transport and native in-memory sessions.
`tests/codex-compaction.spec.mjs` runs the real native runtime via Electron with an
offline transport fixture. Terminal continuation requires this adapter (alone) or
the compatible original plugin; no extension is auto-installed in the user's Pi.
