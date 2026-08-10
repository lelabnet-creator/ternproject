# CONTEXT

## Current Task

Rien en cours. `v0.1.17` est taguée. Une machine sans route vers TERN s'installe
maintenant en une commande copiée depuis l'admin : le PIN vient d'ici, le relais
le rachète en amont, et tout le reste passe par lui. Les trois installateurs
montrent une liste d'étapes qui se remplit. Vert : 785 tests JS, 56 côté agent,
75 côté installateur.

## Key Decisions

- Un PIN émis par TERN est **racheté par le relais** (`/agent/zone/redeem`,
  authentifié comme le relais, refusé aux non-proxy). La réponse ne porte
  aucune clé : l'agent de zone reçoit celle du relais, sans valeur en amont.
  C'est ce qui rend la commande copiable sans rien céder.
- Le rendu animé retombe en lignes simples quand la sortie n'est pas un
  terminal. `Checklist` le décidait déjà seul ; `install.sh` teste la sortie
  standard et non l'entrée, qu'un `curl | sh` occupe de toute façon.
- La sortie d'appairage est capturée puis restituée après la liste : elle porte
  la commande pour la machine suivante, et un redessin lui passerait dessus.

## Next Steps

- La recette VM avec isolement réel reste à jouer — scripts posés
  (`.vm-lab/zone-firewall.sh`, `check-connectivity.sh`), mesure d'avant-coupure
  prise, appairage du relais à faire.
- Le service worker sert un bundle périmé après une mise à jour.
- Aucun test serveur pour HTTP, TCP, DNS ; `ping` couvert par son seul checksum.
