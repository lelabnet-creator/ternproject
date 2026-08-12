# CONTEXT

## Current Task

Release v0.2.0 en cours : le protocole agent v1 — schémas partagés, RFC 9457,
`X-Tern-Protocol`, correction de la latence de zone, `docs/protocol.md`.

## Key Decisions

- **Rupture assumée** : serveur, relais et agents se mettent à jour ensemble ;
  un désaccord de version répond `protocol-mismatch` en nommant les deux côtés.
- **Une seule définition des messages** (`@tern/shared/agent-protocol`),
  tenue côté Rust par les fixtures de `schemas/conformance/protocol/`.
- **v0.2.0, pas 0.1.33** : la rupture mérite le cran mineur, et le crate agent
  est bumpé aussi pour que la flotte distingue migré / à migrer.

## Next Steps

- Mettre à jour l'agent de .170 (rupture : il parlera `protocol-mismatch` sinon).
- Supprimer les doublons déjà en base (demande les machines de Jacques).
- Fumée réelle : ordre `restart` via relais (~1 min), `TERN_PROTOCOL_TRACE=1`.
