# Rocky — la console, et le retour après redémarrage (v0.1.6)

Même campagne que `../../arch/v0.1.6-console/` : la console réelle de la VM
plutôt que SSH, le binaire compilé localement plutôt que celui publié, et le
redémarrage mesuré dans le bon ordre.

Trois choses mesurées :

1. l'installation depuis une machine neuve où Docker est absent — sur Rocky,
   les dépôts de base ne publient pas Docker, donc c'est le chemin qui propose
   d'ajouter celui de Docker qui est exercé ;
2. ce que la console reçoit — inventaire de tous les points de code du flux, et
   captures de l'écran ;
3. le retour de la pile après un redémarrage, `/health` étant interrogé **avant
   toute commande Docker de la session**. Sans cet ordre, un `docker ps` réveille
   à lui seul la pile quand `docker.socket` est activé sans `docker.service`, et
   le test se prouve lui-même.

## Résultat

10 étapes sur 11.

L'unique échec, `l'installateur va au bout`, est un artefact du harnais et non
du produit : le pseudo-terminal SSH atteint sa fin de flux avant que `waitpid`
ne récupère le code de sortie, donc le code retour est inconnu. Tout ce qui en
dépend a réussi juste après — les trois conteneurs tournent, `docker` est activé
au démarrage, `/health` répond 200. L'installateur, lui, est bien allé au bout.

Après redémarrage : `/health` à 200 sans qu'aucune commande Docker n'ait été
tapée, et les trois conteneurs revenus seuls.

## Ce que le flux contenait

Hors ASCII, hors cadre et hors Latin-1 :

- `—` (U+2014), neuf fois — le repli « ASCII » de cliclack pour `└`, qui n'est
  pas de l'ASCII. Amont, suivi dans `BACKLOG.md`.
- `…` (U+2026), une fois.
- **`�` (U+FFFD), dix fois** — le caractère de remplacement, donc quelque chose
  dans le flux n'était pas de l'UTF-8 valide. Sans conséquence sur
  l'installation, qui a réussi, mais non identifié : c'est soit de la sortie dnf
  que nous relayons, soit un défaut de décodage du harnais. Suivi dans
  `BACKLOG.md`.
