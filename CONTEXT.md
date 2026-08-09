# CONTEXT

## Current Task

Rien en cours. `v0.1.12` est taguée. La `v0.1.11` a échoué sans rien publier —
un fichier mal formaté a fait tomber le job TypeScript, dont `Image` dépend. Elle apporte la vue Fleet des proxies — rôle,
IP, flux agent → proxy → TERN — et trois correctifs sortis d'un essai réel où
l'agent, le relais et le serveur se parlaient. Vert : 742 tests JS, 46 côté
agent, e2e 21/21.

## Key Decisions

- Le rôle proxy se détecte depuis `agent_version: "proxy/<version>"`, signal que
  le proxy envoie déjà. Un nouveau champ aurait fait passer les proxies déjà
  déployés pour des agents ordinaires.
- Un agent de zone est identifié parmi les lignes que ce serveur n'a jamais
  appairées (`apiKeyId IS NULL`). Le nom seul entrait en collision avec un agent
  direct sur la même machine.
- `PATCH /controls/:id` ne réécrit plus ce qu'il ne mentionne pas. `.partial()`
  ne retire pas un `.default()` — cinq champs se réinitialisaient en silence.

## Next Steps

- Une instance en 0.1.8 ne peut pas détecter cette version : son image ne connaît
  pas son propre numéro. Il faut un `docker compose pull && up -d` manuel, une
  fois, pour passer à une image ≥ 0.1.10.
- Le binaire Windows échouait parce que `observe_docker` utilisait
  `tokio::net::UnixStream` — la sonde `docker` de la 0.1.7 avait coûté une
  plateforme. Corrigé, mais non vérifié localement : ni `rustup` ni la cible
  Windows ici. C'est la CI de cette version qui le prouve.
- Trous de couverture : aucun test serveur pour HTTP, TCP, DNS ; `ping` couvert
  seulement par son checksum.
