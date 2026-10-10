# Third-party code

`src/vendor/local-ipc.mjs` and `src/vendor/claude-wake.mjs` are adapted from:

- Repository: https://github.com/WebisityStudio/claude-codex-mcp-bridge
- Commit: `8f12c880cfdba73812b6ab7bc0f373fc467e0343`
- Original files: `src/local-ipc.ts`, `src/claude-wake.ts`
- License: MIT. Full upstream notice is preserved in `src/vendor/LICENSE`.
- Changes: stripped TypeScript types, changed local imports, replaced mailbox-specific notice construction with `notice.mjs`. Human-readable errors and receipts were translated into Simplified Chinese; the held receipt now avoids inferring an unspecified native cause. Native socket ownership checks, peer authentication and no-replay behavior are retained.

The Codex follower turn envelope in `src/adapters.mjs` follows that repository's `src/codex-wake.ts` (same commit and license).

Design references, without copying their implementation into this project:

- https://github.com/buidangminh23/codex-mcp-bridge — native Desktop relay and conversation identity research. The current adapter uses the verified native request shape rather than installing its relay service.
- https://github.com/hootandy321/dsh-Agentlink — DSH session delegation and receipts. The actual DSH adapter here targets the locally verified 0.1.7-rc.1 named-argument RPC, not that project's old rc.6/rc.7 transport.

Runtime dependencies and their exact versions are recorded in package-lock.json. Their own license notices remain in their packages.

`src/vendor/claude-desktop.jxa` adapts the macOS Accessibility driver from:

- https://github.com/WarrenJones/desktop-agent-bridge
- Commit: `bf35dc6bfc3be678a5c1f0ee088521099bf4c688`
- License: MIT; full notice in `src/vendor/desktop-agent-bridge-LICENSE`.
- Changes: no permission-mode changes; protect unsent input, use the exact project control, wait for asynchronous prompt retention, identify pre-Send failures, and use a ready handshake before binding the real session and directory.

The native Codex Desktop frame shape and Claude peer permission-class wrapper were checked against `buidangminh23/codex-mcp-bridge` commit `20c1abf1083dbd6e977c71dc574ac13844bab045` and the installed clients. The small framed client here reuses this project's existing IPC module and verifies socket ownership; it is not a copied relay service.
