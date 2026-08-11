# TERN documentation

Written for two readers: a developer who has to change TERN, and a systems
administrator who has to run it. Where the two need different things, the page
says which.

| Page                                   | What it answers                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Getting started](./tutorial.md)       | From nothing to a page that monitors — a first agent, a control, a relay, an isolated zone |
| [Architecture](./architecture.md)      | What the pieces are, why they are separate, and how a request moves through them           |
| [Data model](./data-model.md)          | Every table, what it holds, and the decisions frozen into it                               |
| [Data exchange](./data-exchange.md)    | Every way data enters or leaves: ingestion, pairing, jobs, probes, webhooks, feeds         |
| [The probe specification](./probes.md) | What a probe is, what an assertion means, and why it is implemented twice                  |
| [Importing controls](./import.md)      | The YAML file format, field by field, and what a rejected file tells you                   |
| [Operations](./operations.md)          | Installing, sizing, backing up, upgrading, and what breaks first                           |
| [Security model](./security.md)        | Who can do what, what is encrypted, and what an attacker gets from each thing they steal   |

## The API reference is not a page here

Every instance serves its own, because it is generated from the schemas that
validate the requests — so it describes the build you are running rather than
the one this repository last documented.

| Where                  | What                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `/api/v1/docs`         | The reference, rendered and browsable. Linked from the admin rail. |
| `/api/v1/openapi.json` | The OpenAPI 3 document, for a client generator or a contract test. |

## The shortest possible description

TERN publishes the health of IT services on a status page, one page per tenant.
Measurements arrive through an ingestion API — from the Rust agent, from a
generated script, or from an existing monitoring system through a webhook — and
are stored in a TimescaleDB hypertable with continuous aggregates behind it. The
public page reads the aggregates; the admin reads both.

Everything else in this documentation is detail hanging off that sentence.

## Conventions in these pages

- **"Control"** is the thing being monitored — one service, one endpoint, one
  job. It is what the code calls it, and what the API paths use. The public page
  calls them _components_, because that is what a reader of a status page
  expects; they are the same rows.
- **"Point"** is one measurement of one control at one instant.
- Paths are given relative to the repository root.
- SQL identifiers are given as they exist in the database (`snake_case`), and
  TypeScript identifiers as they exist in the code (`camelCase`). Drizzle
  translates between the two; nothing else does.
