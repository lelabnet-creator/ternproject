# Agent protocol conformance fixtures

One file per protocol message, each carrying valid `examples` of the JSON that
crosses the wire between `tern-agent` / `tern-proxy` and the server.

Two test suites read these same files, and that is the whole point:

- `packages/shared/src/agent-protocol.test.ts` asserts every example parses
  against the Zod schema — the source of truth the API routes serve.
- `clients/agent/tests/protocol_conformance.rs` asserts every example
  deserializes into the Rust structs in `transport.rs`, and that the messages
  the agent *emits* re-serialize to the same JSON.

The two implementations of the protocol never import each other; these files
are the bridge. If a schema change breaks a fixture, fix the fixture *and*
whichever side no longer agrees — the failure is the drift being caught, not
the test being wrong.

Examples deliberately include the awkward cases: omitted optional fields,
explicit nulls where they mean something (`uiAddress`), and an instruction
`kind` no agent knows, because receiving one must not break the poll.
