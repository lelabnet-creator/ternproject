# Recette de déploiement — trois distributions, sorties de leur boîte

Ce dossier porte la trace d'installations qui ont réellement eu lieu : des
machines virtuelles vierges, le script d'amorçage récupéré depuis GitHub comme
n'importe qui le ferait, et la suite conduite comme une personne la conduirait —
les questions lues à mesure qu'elles arrivent, les réponses tapées, rien de
déposé à l'avance.

Ce que la recette vérifie, dans l'ordre : que Docker est bien absent au départ,
que l'installateur le pose lui-même, que l'empreinte du binaire est vérifiée
avant qu'il ne s'exécute, que la pile démarre, que la fenêtre de premier
lancement s'ouvre puis se referme derrière le premier compte, qu'un agent
s'ajoute et s'inscrit au démarrage, qu'une cible publique est mesurée — et, en
dernier, que tout cela revient après un redémarrage.

Les scripts qui produisent tout ceci sont dans `.vm-lab/` à la racine du dépôt.
Sans eux, ce dossier ne serait qu'une affirmation.

## Mots de passe

Écrits en clair, parce que c'est exactement ce qu'ils sont : les identifiants de
machines jetables, sans accès entrant, détruites à la fin de la recette. Un
secret qu'il faudrait protéger n'aurait rien à faire dans un banc de test.

| Quoi | Identifiant | Mot de passe |
|---|---|---|
| Compte système des VM | `tern` | `tern-lab-2026` |
| Administrateur TERN | `admin@lab.example` | `tern-lab-admin-2026` |

La page créée s'appelle `Lab` (slug `lab`), et la cible supervisée est
`https://example.com/` — choisie parce qu'elle existe pour cela, ne demande pas
d'authentification et répond partout.

## Ce que contient chaque dossier

```
<distribution>/
  logs/         le dialogue complet de l'installation, l'état de la pile,
                les journaux de démarrage de l'application, le service de
                l'agent, le résumé de la page publique
  screenshots/  la console de la VM aux moments qui comptent
  resultats.json  chaque étape, son verdict, et les identifiants ci-dessus
```

`ubuntu/v0.1.1-defauts-trouves/` garde la trace de la campagne précédente. Elle
est conservée parce que c'est elle qui a trouvé les défauts corrigés depuis, et
qu'un banc qui n'archive que ses succès ne prouve rien.

## Ce que cette campagne a trouvé

Aucun de ces défauts n'était visible depuis un poste de développement. Tous
l'étaient depuis une machine vierge.

| Défaut | Où il se voyait | Correction |
|---|---|---|
| Rocky : aucun paquet Docker dans les dépôts de base | l'installation s'arrêtait sur un refus correct et une impasse | le dépôt de Docker est proposé, jamais supposé |
| Arch : base de paquets plus ancienne que les miroirs | 404 sur chaque miroir, « no packages were upgraded » | la mise à jour du système est proposée avant l'installation |
| Docker installé mais pas activé au démarrage | rien ne revenait après un redémarrage | la question est posée quand `is-enabled` dit non |
| L'agent refusait l'adresse que le produit lui donnait | ajout d'un agent sur un LAN sans TLS | autorisation explicite, posée par l'installateur généré |
| Cadre et états illisibles sur une console | seize couleurs, pas de police semi-graphique | marques ASCII, couleur portée par le libellé, gouttière visible |

## Rejouer la recette

```sh
python3 .vm-lab/run.py ubuntu     # ou rocky, ou arch
python3 .vm-lab/console.py ubuntu # le rendu sur une vraie console
```

Il faut QEMU avec KVM, un pont `br0` déclaré dans `/etc/qemu/bridge.conf`, et
les images cloud des trois distributions dans `.vm-lab/images/`. Chaque exécution
repart d'une copie neuve de l'image : une VM déjà installée donnerait un
résultat qui ne prouve rien.
