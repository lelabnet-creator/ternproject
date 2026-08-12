//! Replays the shared protocol fixtures against the transport structs.
//!
//! `schemas/conformance/protocol/` is written beside the Zod schemas in
//! `packages/shared/src/agent-protocol.ts`, and the TypeScript suite asserts
//! every example parses there. This suite asserts the same examples fit the
//! serde structs in `transport.rs` — and that the messages this binary *emits*
//! re-serialize to the very JSON the fixtures show, key for key. Neither
//! implementation imports the other; these files are the bridge.

use std::fs;
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;
use tern_agent::transport::{
    Command, CommandKind, IngestResponse, JobsResponse, PairRequest, PairResponse, Point, ZoneAgent,
};

#[derive(Debug, Deserialize)]
struct Fixture {
    message: String,
    examples: Vec<Value>,
}

fn fixtures() -> Vec<Fixture> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../schemas/conformance/protocol")
        .canonicalize()
        .expect("protocol fixtures should be reachable from the crate");

    let mut fixtures = Vec::new();
    for entry in fs::read_dir(dir).expect("fixtures directory") {
        let path = entry.expect("entry").path();
        if path.extension().is_some_and(|ext| ext == "json") {
            let raw = fs::read_to_string(&path).expect("readable fixture");
            fixtures.push(serde_json::from_str(&raw).expect("well-formed fixture"));
        }
    }
    assert!(!fixtures.is_empty(), "no fixtures found");
    fixtures
}

fn examples_of(message: &str) -> Vec<Value> {
    fixtures()
        .into_iter()
        .filter(|fixture| fixture.message == message)
        .flat_map(|fixture| fixture.examples)
        .collect()
}

/// Deserializes every example into `T`. The parse itself is the assertion:
/// a fixture the struct refuses is the drift being caught.
fn parses_as<T: serde::de::DeserializeOwned>(message: &str) -> Vec<T> {
    let examples = examples_of(message);
    assert!(!examples.is_empty(), "no examples for {message}");
    examples
        .into_iter()
        .map(|example| {
            serde_json::from_value(example.clone()).unwrap_or_else(|error| {
                panic!("{message} example did not fit the struct: {error}\n{example}")
            })
        })
        .collect()
}

/// For messages this binary emits: deserialize, re-serialize, and demand the
/// same JSON back. Any field the struct silently drops or renames shows here.
fn round_trips<T>(message: &str)
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    for example in examples_of(message) {
        let parsed: T = serde_json::from_value(example.clone())
            .unwrap_or_else(|error| panic!("{message}: {error}\n{example}"));
        let back = serde_json::to_value(&parsed).expect("serializable");
        assert_eq!(back, example, "{message} did not round-trip");
    }
}

// ── What the agent receives ────────────────────────────────────────────────

#[test]
fn pair_responses_fit() {
    let responses: Vec<PairResponse> = parses_as("pairResponse");
    assert!(responses.iter().any(|r| r.jobs.is_empty()));
    assert!(responses.iter().any(|r| !r.jobs.is_empty()));
}

#[test]
fn jobs_responses_fit_including_an_unknown_kind() {
    let responses: Vec<JobsResponse> = parses_as("jobsResponse");

    let kinds: Vec<&CommandKind> = responses
        .iter()
        .flat_map(|r| r.commands.iter().map(|c| &c.kind))
        .collect();
    // The fixture carries a kind no build knows, on purpose: receiving one
    // must not break the poll, and it must stay nameable to answer "unknown".
    assert!(kinds.iter().any(
        |kind| matches!(kind, CommandKind::Unknown(name) if name == "defragment-the-hyperdrive")
    ));
    assert!(kinds.iter().any(|kind| **kind == CommandKind::Restart));

    // Zone instructions carry the machine's name — the relay's whole index.
    assert!(responses
        .iter()
        .flat_map(|r| &r.zone_commands)
        .any(|c| c.agent == "zone-box-07"));
}

#[test]
fn ingest_responses_fit() {
    let responses: Vec<IngestResponse> = parses_as("ingestResponse");
    assert!(responses.iter().any(|r| !r.rejected.is_empty()));
}

#[test]
fn heartbeat_responses_fit() {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Beat {
        #[serde(default)]
        commands_waiting: bool,
        ok: bool,
    }
    let beats: Vec<Beat> = parses_as("heartbeatResponse");
    assert!(beats.iter().all(|b| b.ok));
    assert!(beats.iter().any(|b| b.commands_waiting));
}

#[test]
fn problems_fit_what_the_transport_reads() {
    // The transport reads `code`/`detail`/`title` out of every error body;
    // the fixtures are the server's word on what those look like.
    #[derive(Deserialize)]
    struct Problem {
        code: String,
        status: u16,
        detail: Option<String>,
    }
    let problems: Vec<Problem> = parses_as("problem");
    assert!(problems.iter().any(|p| p.code == "protocol-mismatch"));
    assert!(problems.iter().any(|p| p.code == "key-has-no-agent"));
    assert!(problems.iter().all(|p| p.status >= 400));
    assert!(problems.iter().all(|p| p.detail.is_some()));
}

// ── What the agent emits — held to the byte ────────────────────────────────

#[test]
fn pair_requests_round_trip() {
    round_trips::<PairRequest>("pairRequest");
}

#[test]
fn points_round_trip() {
    round_trips::<Point>("ingestPoint");
}

#[test]
fn zone_declarations_round_trip() {
    #[derive(Deserialize, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Declaration {
        agents: Vec<ZoneAgent>,
        #[serde(skip_serializing_if = "Option::is_none")]
        listen: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        addresses: Option<Vec<String>>,
    }
    round_trips::<Declaration>("zoneDeclaration");
}

#[test]
fn command_results_round_trip() {
    // The exact body `command_result` posts: both fields always present,
    // null when empty — the server treats null and absent identically here.
    #[derive(Deserialize, serde::Serialize)]
    struct Sent {
        result: Option<String>,
        error: Option<String>,
    }
    round_trips::<Sent>("commandResultRequest");
}

#[test]
fn heartbeat_requests_round_trip() {
    // `uiAddress` null and absent are different statements (clear vs leave
    // alone), so the round-trip must preserve which one was made. Plain serde
    // folds null into "absent" for an `Option<Option<_>>`; the deserializer
    // below keeps them apart, which is exactly the distinction under test.
    fn null_or_absent<'de, D: serde::Deserializer<'de>>(
        de: D,
    ) -> Result<Option<Option<String>>, D::Error> {
        Ok(Some(Option::deserialize(de)?))
    }

    #[derive(Deserialize, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Sent {
        #[serde(
            default,
            deserialize_with = "null_or_absent",
            skip_serializing_if = "Option::is_none"
        )]
        ui_address: Option<Option<String>>,
        /// Absent means "answer at once", which is what every agent older than
        /// the held beat sends — so it must survive as absent, not as zero.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        wait_seconds: Option<u32>,
    }
    round_trips::<Sent>("heartbeatRequest");
}

/**
 * The answer the agent acts on, against every shape the server may send.
 *
 * Both fields are optional on the wire for the same reason — an older server
 * sends neither — and both default to the conservative reading: nothing
 * waiting, and no hold. That default is what lets a new agent talk to an old
 * server without a version check.
 */
#[test]
fn heartbeat_responses_fit_including_one_from_a_server_that_does_not_hold() {
    let beats: Vec<tern_agent::transport::Beat> = parses_as("heartbeatResponse");

    assert!(beats.iter().any(|b| b.commands_waiting));
    assert!(beats.iter().any(|b| b.holding), "a server that holds");
    // The old shape: no `holding` at all, read as "does not hold".
    let old: tern_agent::transport::Beat =
        serde_json::from_str(r#"{"ok":true,"commandsWaiting":true}"#).expect("the older shape");
    assert!(old.commands_waiting);
    assert!(!old.holding);
}

/// `ZoneAgent` requires Deserialize for the round-trip probe above; make sure
/// a command with a known kind still displays as its wire name, because that
/// string is what `apply` logs and what an unknown-kind answer quotes.
#[test]
fn command_kinds_display_as_their_wire_names() {
    let command: Command = serde_json::from_str(r#"{"id":"c1","kind":"ui-on"}"#).unwrap();
    assert_eq!(command.kind.to_string(), "ui-on");
}
