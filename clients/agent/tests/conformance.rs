//! Replays the shared conformance fixtures.
//!
//! These are the same files the TypeScript suite runs. If this passes and that
//! passes, the two implementations agree on what a probe means — which is the
//! only claim worth making about a spec implemented twice.

use std::fs;
use std::path::PathBuf;

use serde::Deserialize;
use tern_agent::probe::{evaluate, Assertion, Observation, Status};

#[derive(Debug, Deserialize)]
struct Fixture {
    name: String,
    #[allow(dead_code)]
    why: String,
    assertions: Vec<Assertion>,
    observation: Observation,
    expect: Expectation,
}

#[derive(Debug, Deserialize)]
struct Expectation {
    status: String,
    value: Option<f64>,
    failing: Vec<String>,
}

fn conformance_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../schemas/conformance")
        .canonicalize()
        .expect("conformance fixtures should be reachable from the crate")
}

fn status_name(status: Status) -> &'static str {
    match status {
        Status::Operational => "operational",
        Status::Degraded => "degraded",
        Status::Partial => "partial",
        Status::Down => "down",
        Status::Maintenance => "maintenance",
        Status::Unknown => "unknown",
    }
}

#[test]
fn agrees_with_the_typescript_implementation() {
    let dir = conformance_dir();
    let mut files: Vec<_> = fs::read_dir(&dir)
        .expect("conformance directory should be readable")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();

    assert!(
        !files.is_empty(),
        "no fixtures found in {} — the contract is unenforced",
        dir.display()
    );

    for path in files {
        let raw = fs::read_to_string(&path).expect("fixture should be readable");
        let fixture: Fixture = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("{}: fixture did not parse: {e}", path.display()));

        let result = evaluate(&fixture.assertions, &fixture.observation);

        assert_eq!(
            status_name(result.status),
            fixture.expect.status,
            "{}: {} — status",
            path.file_name().unwrap().to_string_lossy(),
            fixture.name
        );

        assert_eq!(
            result.value,
            fixture.expect.value,
            "{}: {} — captured value",
            path.file_name().unwrap().to_string_lossy(),
            fixture.name
        );

        let failing: Vec<String> = result
            .assertions
            .iter()
            .filter(|a| !a.passed)
            .map(|a| a.type_name.clone())
            .collect();

        assert_eq!(
            failing,
            fixture.expect.failing,
            "{}: {} — failing assertions",
            path.file_name().unwrap().to_string_lossy(),
            fixture.name
        );
    }
}

#[test]
fn failure_messages_name_the_assertion_and_the_actual_value() {
    // "check failed" is useless at 3am, in either language.
    let assertions: Vec<Assertion> =
        serde_json::from_str(r#"[{"type":"status_code","severity":"down","eq":200}]"#).unwrap();
    let observation: Observation = serde_json::from_str(r#"{"statusCode":503}"#).unwrap();

    let result = evaluate(&assertions, &observation);
    let message = result.message.expect("a failure should carry a message");

    assert!(message.contains("503"), "message should cite what was seen");
    assert!(
        message.contains("200"),
        "message should cite what was expected"
    );
}
