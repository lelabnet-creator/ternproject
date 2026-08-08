# Arch — la console, et le retour après redémarrage (v0.1.6)

Campagne distincte de `v0.1.6/`, qui rejoue la recette complète. Celle-ci ne
mesure que trois choses, et elle les mesure sur la **console réelle** de la VM
plutôt que par SSH :

1. l'installation depuis une machine neuve où Docker est absent, avec le binaire
   compilé localement plutôt que celui publié ;
2. ce que la console reçoit — inventaire de tous les points de code du flux, et
   captures de l'écran ;
3. le retour de la pile après un redémarrage, `/health` étant interrogé **avant
   toute commande Docker de la session** : un `docker ps` réveille à lui seul la
   pile quand `docker.socket` est activé sans `docker.service`, et on verrait
   une machine saine là où le site est resté éteint pour tout le monde.

## Lire `resultats.json` sans se tromper

Le fichier enregistre des échecs, et ils ne veulent pas dire ce qu'ils
paraissent dire.

**`l'installateur va au bout` — ÉCHEC.** L'installateur s'est arrêté de son
plein gré, et il a eu raison. `pacman -Syu` avait remplacé le noyau, et il l'a
détecté :

> This machine is running a kernel it no longer has the modules for.
> A kernel upgrade replaced them. Until this machine restarts, Docker cannot
> load the network modules it needs, and it fails on an iptables error that
> says nothing about the kernel.

C'est le comportement voulu : sans ce garde-fou, l'installation échoue plus
loin sur une erreur iptables qui ne nomme pas sa cause. Les étapes suivantes
échouent en cascade parce que Docker n'était effectivement pas installé.

**La suite est dans `logs/reprise-apres-noyau.log`.** La machine a été
redémarrée, comme l'installateur le demandait, et l'installation a été relancée
telle quelle. Noyau 7.1.6-arch1-1, les trois conteneurs démarrés, `docker`
activé au démarrage, `/health` à 200 — puis un second redémarrage, après lequel
`/health` répond 200 sans qu'aucune commande Docker n'ait été tapée.

## Les captures

`04-console-checklist.png` est celle qui compte. Sur une console dont la police
n'a ni `✓`, ni `○`, ni les caractères de spinner, les trois états se distinguent
quand même — vert `+` pour ce qui est fait, gris `.` pour ce qui attend, et la
barre `#####-------------`. Le cadre de la boîte est lisible pour la première
fois : il était peint en `\e[38;5;8m`, que cette console rend en noir sur noir.

`02-` et `03-` montrent le oui/non de part et d'autre : `[ Yes ]` en vidéo
inverse contre `No` en gris, puis l'inverse après une flèche.

## Ce que le flux contenait

Un seul caractère hors ASCII, hors cadre et hors Latin-1 : `—` (U+2014), cinq
fois. Il ne vient pas de TERN mais du repli « ASCII » de cliclack pour `└`, qui
n'est pas de l'ASCII. Suivi dans `BACKLOG.md`.
