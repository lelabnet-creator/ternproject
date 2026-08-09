# CONTEXT

## Current Task

Rien en cours. `v0.1.11` est taguée. Elle apporte la vue Fleet des proxies — rôle,
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
- Le binaire `x86_64-pc-windows-msvc` bloque la release GitHub depuis la 0.1.8.
  L'épinglage sur `ring` est sur main ; cette version est la première à
  l'éprouver.
- Trous de couverture : aucun test serveur pour HTTP, TCP, DNS ; `ping` couvert
  seulement par son checksum.
