//! The assertion engine.
//!
//! This is the half of probe evaluation that must agree, statement for
//! statement, with the TypeScript implementation in `packages/shared`. Neither
//! can import the other, so both are held to the fixtures in
//! `schemas/conformance/` — that suite is the contract, and this module exists
//! to satisfy it.
//!
//! No I/O here on purpose: sockets are easy to check by hand, "does
//! `$.queue.depth < 100` mean the same thing in both languages" is not.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── Vocabulary ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Operational,
    Degraded,
    Partial,
    Down,
    Maintenance,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Degraded,
    /// The default when a probe does not say: an assertion nobody graded is
    /// assumed to matter.
    #[default]
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Comparator {
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
    Contains,
    Matches,
    Exists,
    Absent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ValueKind {
    #[default]
    String,
    Number,
    Bool,
}

// ── Assertions ──────────────────────────────────────────────────────────────

// Serialize as well as Deserialize: an `agent.toml` round-trips through this
// type when the editor generates one, so the two must agree in both directions.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Assertion {
    StatusCode {
        #[serde(default)]
        severity: Severity,
        #[serde(default)]
        eq: Option<i64>,
        #[serde(default, rename = "in")]
        in_list: Option<Vec<i64>>,
        #[serde(default)]
        range: Option<(i64, i64)>,
    },
    Latency {
        #[serde(default)]
        severity: Severity,
        #[serde(default = "default_lt")]
        comparator: Comparator,
        ms: i64,
    },
    Body {
        #[serde(default)]
        severity: Severity,
        #[serde(default = "default_contains")]
        comparator: Comparator,
        value: String,
    },
    Header {
        #[serde(default)]
        severity: Severity,
        name: String,
        #[serde(default = "default_eq")]
        comparator: Comparator,
        #[serde(default)]
        value: Option<String>,
    },
    JsonPath {
        #[serde(default)]
        severity: Severity,
        path: String,
        #[serde(default = "default_eq")]
        comparator: Comparator,
        #[serde(default)]
        value: Option<Value>,
        #[serde(default, rename = "as")]
        as_kind: ValueKind,
        #[serde(default)]
        capture: bool,
    },
    JsonSearch {
        #[serde(default)]
        severity: Severity,
        #[serde(default)]
        key: Option<String>,
        #[serde(default = "default_exists")]
        comparator: Comparator,
        #[serde(default)]
        value: Option<Value>,
    },
    CertExpiresIn {
        #[serde(default)]
        severity: Severity,
        days: i64,
    },
    DnsRecord {
        #[serde(default)]
        severity: Severity,
        #[serde(default = "default_contains")]
        comparator: Comparator,
        #[serde(default)]
        value: Option<String>,
    },
}

fn default_lt() -> Comparator {
    Comparator::Lt
}
fn default_eq() -> Comparator {
    Comparator::Eq
}
fn default_contains() -> Comparator {
    Comparator::Contains
}
fn default_exists() -> Comparator {
    Comparator::Exists
}

impl Assertion {
    fn severity(&self) -> Severity {
        match self {
            Assertion::StatusCode { severity, .. }
            | Assertion::Latency { severity, .. }
            | Assertion::Body { severity, .. }
            | Assertion::Header { severity, .. }
            | Assertion::JsonPath { severity, .. }
            | Assertion::JsonSearch { severity, .. }
            | Assertion::CertExpiresIn { severity, .. }
            | Assertion::DnsRecord { severity, .. } => *severity,
        }
    }

    fn type_name(&self) -> &'static str {
        match self {
            Assertion::StatusCode { .. } => "status_code",
            Assertion::Latency { .. } => "latency",
            Assertion::Body { .. } => "body",
            Assertion::Header { .. } => "header",
            Assertion::JsonPath { .. } => "json_path",
            Assertion::JsonSearch { .. } => "json_search",
            Assertion::CertExpiresIn { .. } => "cert_expires_in",
            Assertion::DnsRecord { .. } => "dns_record",
        }
    }
}

// ── Observation and result ──────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    /// Set when the target could not be reached at all.
    pub error: Option<String>,
    pub latency_ms: Option<i64>,
    pub status_code: Option<i64>,
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
    pub body: Option<String>,
    pub cert_expires_in_days: Option<i64>,
    #[serde(default)]
    pub dns_records: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AssertionResult {
    #[serde(rename = "type")]
    pub type_name: String,
    pub passed: bool,
    pub severity: Severity,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub status: Status,
    pub latency_ms: Option<i64>,
    pub value: Option<f64>,
    pub message: Option<String>,
    pub assertions: Vec<AssertionResult>,
}

/// Evaluates assertions against an observation.
pub fn evaluate(assertions: &[Assertion], observation: &Observation) -> ProbeResult {
    // An unreachable target short-circuits: assertions about a response that
    // never arrived would report misleading detail such as "expected 200, got
    // nothing".
    if let Some(error) = &observation.error {
        return ProbeResult {
            status: Status::Down,
            latency_ms: observation.latency_ms,
            value: None,
            message: Some(error.clone()),
            assertions: Vec::new(),
        };
    }

    let parsed_body: Option<Value> = observation
        .body
        .as_ref()
        .and_then(|b| serde_json::from_str(b).ok());

    let mut results = Vec::with_capacity(assertions.len());
    let mut captured: Option<f64> = None;

    for assertion in assertions {
        let (passed, detail, capture) = evaluate_one(assertion, observation, parsed_body.as_ref());
        if let Some(value) = capture {
            captured = Some(value);
        }
        results.push(AssertionResult {
            type_name: assertion.type_name().to_string(),
            passed,
            severity: assertion.severity(),
            detail,
        });
    }

    let down = results
        .iter()
        .find(|r| !r.passed && r.severity == Severity::Down);
    let degraded = results
        .iter()
        .find(|r| !r.passed && r.severity == Severity::Degraded);

    let status = if down.is_some() {
        Status::Down
    } else if degraded.is_some() {
        Status::Degraded
    } else {
        Status::Operational
    };

    ProbeResult {
        status,
        latency_ms: observation.latency_ms,
        value: captured,
        // Naming the failing assertion and its actual value is the difference
        // between a status page you can act on and one that says "check failed".
        message: down.or(degraded).map(|r| r.detail.clone()),
        assertions: results,
    }
}

fn evaluate_one(
    assertion: &Assertion,
    observation: &Observation,
    json: Option<&Value>,
) -> (bool, String, Option<f64>) {
    match assertion {
        Assertion::StatusCode {
            eq, in_list, range, ..
        } => {
            let Some(code) = observation.status_code else {
                return (false, "no HTTP status code in response".into(), None);
            };
            if let Some(expected) = eq {
                return (
                    code == *expected,
                    format!("status {code}, expected {expected}"),
                    None,
                );
            }
            if let Some(list) = in_list {
                let joined = list
                    .iter()
                    .map(|c| c.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                return (
                    list.contains(&code),
                    format!("status {code}, expected one of {joined}"),
                    None,
                );
            }
            if let Some((lo, hi)) = range {
                return (
                    code >= *lo && code <= *hi,
                    format!("status {code}, expected {lo}–{hi}"),
                    None,
                );
            }
            (true, format!("status {code}"), None)
        }

        Assertion::Latency { comparator, ms, .. } => {
            let Some(latency) = observation.latency_ms else {
                return (false, "no latency measured".into(), None);
            };
            let ok = match comparator {
                Comparator::Lte => latency <= *ms,
                _ => latency < *ms,
            };
            (ok, format!("latency {latency} ms, threshold {ms} ms"), None)
        }

        Assertion::Body {
            comparator, value, ..
        } => {
            let body = observation.body.as_deref().unwrap_or("");
            let ok = match comparator {
                Comparator::Contains => body.contains(value.as_str()),
                Comparator::Matches => safe_match(body, value),
                _ => !body.contains(value.as_str()),
            };
            (
                ok,
                format!("body {} {:?}", comparator_name(*comparator), value),
                None,
            )
        }

        Assertion::Header {
            name,
            comparator,
            value,
            ..
        } => {
            // HTTP header names are case-insensitive per RFC 9110; comparing
            // them literally works against some servers and not others.
            let actual = observation
                .headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.clone());

            let ok = compare_str(actual.as_deref(), *comparator, value.as_deref());
            (
                ok,
                format!(
                    "header {name}: {} {} {}",
                    actual.as_deref().unwrap_or("(absent)"),
                    comparator_name(*comparator),
                    value.as_deref().unwrap_or("")
                )
                .trim_end()
                .to_string(),
                None,
            )
        }

        Assertion::JsonPath {
            path,
            comparator,
            value,
            as_kind,
            capture,
            ..
        } => {
            let raw = json.and_then(|doc| query_json_path(doc, path));
            let actual = coerce(raw.as_ref(), *as_kind);
            let expected = value.as_ref().and_then(|v| coerce(Some(v), *as_kind));

            let ok = compare_values(actual.as_ref(), *comparator, expected.as_ref());
            let captured = if *capture {
                actual.as_ref().and_then(as_f64)
            } else {
                None
            };

            (
                ok,
                format!(
                    "{path} = {} {} {}",
                    format_value(raw.as_ref()),
                    comparator_name(*comparator),
                    format_value(value.as_ref())
                ),
                captured,
            )
        }

        Assertion::JsonSearch {
            key,
            comparator,
            value,
            ..
        } => {
            let matches = json
                .map(|doc| search_json(doc, key.as_deref()))
                .unwrap_or_default();

            let found = match comparator {
                Comparator::Exists | Comparator::Absent => !matches.is_empty(),
                _ => matches.iter().any(|candidate| {
                    compare_str(
                        Some(&value_to_string(candidate)),
                        *comparator,
                        value.as_ref().map(value_to_string).as_deref(),
                    )
                }),
            };

            let ok = if *comparator == Comparator::Absent {
                !found
            } else {
                found
            };

            (
                ok,
                format!(
                    "search {} {} {}",
                    key.as_ref()
                        .map(|k| format!("key \"{k}\""))
                        .unwrap_or_else(|| "any key".into()),
                    comparator_name(*comparator),
                    format_value(value.as_ref())
                ),
                None,
            )
        }

        Assertion::CertExpiresIn { days, .. } => {
            let Some(left) = observation.cert_expires_in_days else {
                return (false, "no certificate observed".into(), None);
            };
            (
                left >= *days,
                format!("certificate expires in {left} d, want ≥ {days} d"),
                None,
            )
        }

        Assertion::DnsRecord {
            comparator, value, ..
        } => {
            let ok = match comparator {
                Comparator::Exists => !observation.dns_records.is_empty(),
                _ => observation
                    .dns_records
                    .iter()
                    .any(|r| compare_str(Some(r), *comparator, value.as_deref())),
            };
            (
                ok,
                format!(
                    "dns [{}] {} {}",
                    observation.dns_records.join(", "),
                    comparator_name(*comparator),
                    value.as_deref().unwrap_or("(absent)")
                ),
                None,
            )
        }
    }
}

// ── Comparison ──────────────────────────────────────────────────────────────

fn compare_str(actual: Option<&str>, comparator: Comparator, expected: Option<&str>) -> bool {
    match comparator {
        Comparator::Exists => actual.is_some(),
        Comparator::Absent => actual.is_none(),
        Comparator::Eq => actual == expected,
        Comparator::Ne => actual != expected,
        Comparator::Contains => actual.unwrap_or("").contains(expected.unwrap_or("")),
        Comparator::Matches => safe_match(actual.unwrap_or(""), expected.unwrap_or("")),
        // Ordering on strings would make "9" > "10". A non-numeric operand
        // fails rather than comparing lexicographically.
        _ => match (
            actual.and_then(|a| a.parse::<f64>().ok()),
            expected.and_then(|e| e.parse::<f64>().ok()),
        ) {
            (Some(a), Some(b)) => compare_numbers(a, comparator, b),
            _ => false,
        },
    }
}

fn compare_values(
    actual: Option<&Value>,
    comparator: Comparator,
    expected: Option<&Value>,
) -> bool {
    match comparator {
        Comparator::Exists => actual.is_some_and(|v| !v.is_null()),
        Comparator::Absent => actual.is_none_or(|v| v.is_null()),
        Comparator::Eq => actual == expected,
        Comparator::Ne => actual != expected,
        Comparator::Lt | Comparator::Lte | Comparator::Gt | Comparator::Gte => {
            match (actual.and_then(as_f64), expected.and_then(as_f64)) {
                (Some(a), Some(b)) => compare_numbers(a, comparator, b),
                _ => false,
            }
        }
        Comparator::Contains | Comparator::Matches => compare_str(
            actual.map(value_to_string).as_deref(),
            comparator,
            expected.map(value_to_string).as_deref(),
        ),
    }
}

fn compare_numbers(a: f64, comparator: Comparator, b: f64) -> bool {
    if !a.is_finite() || !b.is_finite() {
        return false;
    }
    match comparator {
        Comparator::Lt => a < b,
        Comparator::Lte => a <= b,
        Comparator::Gt => a > b,
        Comparator::Gte => a >= b,
        _ => false,
    }
}

/// A user-supplied pattern must never take the process down, and an invalid
/// regex is a configuration mistake — a failed assertion, not a panic.
fn safe_match(value: &str, pattern: &str) -> bool {
    regex::Regex::new(pattern)
        .map(|re| re.is_match(value))
        .unwrap_or(false)
}

fn coerce(value: Option<&Value>, kind: ValueKind) -> Option<Value> {
    let value = value?;
    if value.is_null() {
        return None;
    }
    match kind {
        ValueKind::Number => as_f64(value).map(Value::from),
        ValueKind::Bool => Some(Value::Bool(match value {
            Value::Bool(b) => *b,
            Value::String(s) => s == "true" || s == "1",
            Value::Number(n) => n.as_f64() == Some(1.0),
            _ => false,
        })),
        ValueKind::String => Some(match value {
            Value::String(s) => Value::String(s.clone()),
            other => Value::String(other.to_string()),
        }),
    }
}

fn as_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn format_value(value: Option<&Value>) -> String {
    match value {
        None => "(absent)".into(),
        Some(Value::String(s)) => format!("{s:?}"),
        Some(other) => other.to_string(),
    }
}

fn comparator_name(comparator: Comparator) -> &'static str {
    match comparator {
        Comparator::Eq => "eq",
        Comparator::Ne => "ne",
        Comparator::Lt => "lt",
        Comparator::Lte => "lte",
        Comparator::Gt => "gt",
        Comparator::Gte => "gte",
        Comparator::Contains => "contains",
        Comparator::Matches => "matches",
        Comparator::Exists => "exists",
        Comparator::Absent => "absent",
    }
}

// ── JSONPath ────────────────────────────────────────────────────────────────

/// A deliberately small subset: `$.a.b[0]`, `$['a b'].c`, `[*]`, negative
/// indexes.
///
/// A full JSONPath library would be a dependency the TypeScript side has to
/// match expression for expression. A small grammar keeps the two honestly
/// equivalent and covers what a health endpoint actually exposes.
pub fn query_json_path(document: &Value, path: &str) -> Option<Value> {
    let mut current = document;

    for token in tokenise_path(path) {
        if token == "*" {
            current = current.as_array()?.first()?;
            continue;
        }

        if let Some(array) = current.as_array() {
            let index: i64 = token.parse().ok()?;
            let resolved = if index < 0 {
                array.len().checked_sub(index.unsigned_abs() as usize)?
            } else {
                index as usize
            };
            current = array.get(resolved)?;
            continue;
        }

        current = current.as_object()?.get(&token)?;
    }

    Some(current.clone())
}

fn tokenise_path(path: &str) -> Vec<String> {
    let cleaned = path.strip_prefix('$').unwrap_or(path);
    let mut tokens = Vec::new();
    let mut chars = cleaned.chars().peekable();
    let mut current = String::new();

    while let Some(ch) = chars.next() {
        match ch {
            '.' => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            '[' => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
                let mut inner = String::new();
                let quote = matches!(chars.peek(), Some('\'') | Some('"'));
                if quote {
                    let q = chars.next().unwrap();
                    for c in chars.by_ref() {
                        if c == q {
                            break;
                        }
                        inner.push(c);
                    }
                    // Consume the closing bracket.
                    chars.next();
                } else {
                    for c in chars.by_ref() {
                        if c == ']' {
                            break;
                        }
                        inner.push(c);
                    }
                }
                tokens.push(inner);
            }
            _ => current.push(ch),
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Collects every leaf value, optionally restricted to a key name — for APIs
/// whose response shape moves between versions.
pub fn search_json(document: &Value, key: Option<&str>) -> Vec<Value> {
    let mut found = Vec::new();
    walk(document, None, key, &mut found);
    found
}

fn walk(node: &Value, current_key: Option<&str>, key: Option<&str>, found: &mut Vec<Value>) {
    match node {
        Value::Object(map) => {
            for (k, v) in map {
                walk(v, Some(k), key, found);
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                let idx = index.to_string();
                walk(item, Some(&idx), key, found);
            }
        }
        leaf => {
            if key.is_none() || key == current_key {
                found.push(leaf.clone());
            }
        }
    }
}
