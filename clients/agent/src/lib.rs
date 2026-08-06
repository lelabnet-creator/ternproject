//! TERN agent.
//!
//! Exposed as a library as well as a binary so the probe engine can be reused by
//! third-party integrations, and so the conformance suite can drive it directly
//! rather than through the CLI.

pub mod probe;
pub mod transport;
