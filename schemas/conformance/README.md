# Probe conformance fixtures

TERN evaluates the same probe specification in two places: the TypeScript evaluator in `apps/api`
(for targets reachable from the server) and the Rust agent in `clients/agent` (for targets behind a
firewall). Neither can import the other.

These fixtures are the contract. Each file describes a set of assertions, a simulated observation,
and the verdict both implementations must reach. Both replay them in CI.

The interesting failures are not "does an HTTP request work" — they are the quiet semantic
disagreements: whether `"5" < 10` compares as numbers or as strings, whether a header lookup is
case-insensitive, whether an invalid regex fails the assertion or crashes the probe. Those are what
these files pin down.

## Format

```jsonc
{
  "name": "short description",
  "why": "what this pins down, and why it matters",
  "assertions": [/* Assertion[] from probe.ts */],
  "observation": {/* ProbeObservation — what a transport would have produced */},
  "expect": {
    "status": "operational | degraded | down",
    "value": null, // captured measurement, if any
    "failing": ["assertion types expected to fail"],
  },
}
```

Assertions are written as they appear after schema defaults are applied, so a fixture reads the same
in both languages.

## Adding a case

Add one whenever a behaviour is decided rather than obvious — especially when fixing a bug. A
conformance fixture is how the fix reaches the other implementation.
