# Third-party code

`src/vendor/local-ipc.mjs` and `src/vendor/claude-wake.mjs` are adapted from:

- Repository: https://github.com/WebisityStudio/claude-codex-mcp-bridge
- Commit: `8f12c880cfdba73812b6ab7bc0f373fc467e0343`
- Original files: `src/local-ipc.ts`, `src/claude-wake.ts`
- License: MIT. Full upstream notice is preserved in `src/vendor/LICENSE`.
- Changes: stripped TypeScript types, changed local imports, replaced mailbox-specific notice construction with `notice.mjs`. Human-readable errors and receipts were translated into Simplified Chinese; the held receipt now avoids inferring an unspecified native cause. Native socket ownership checks, peer authentication and no-replay behavior are retained.

The Codex follower turn envelope in `src/adapters.mjs` follows that repository's `src/codex-wake.ts` (same commit and license).

Design references, without copying their implementation into this project:

- https://github.com/buidangminh23/codex-mcp-bridge — native Desktop relay and conversation identity research. Its relay did not connect successfully to the currently running app during this probe.
- https://github.com/hootandy321/dsh-Agentlink — DSH session delegation and receipts. The actual DSH adapter here targets the locally verified 0.1.7-rc.1 named-argument RPC, not that project's old rc.6/rc.7 transport.

Runtime dependencies and their exact versions are recorded in package-lock.json. Their own license notices remain in their packages.
