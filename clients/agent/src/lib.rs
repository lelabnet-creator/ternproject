//! TERN agent.
//!
//! Exposed as a library as well as a binary so the probe engine can be reused by
//! third-party integrations, and so the conformance suite can drive it directly
//! rather than through the CLI.

pub mod config;
pub mod doctor;
pub mod probe;
pub mod probe_transport;
pub mod proxy;
pub mod runner;
pub mod transport;
