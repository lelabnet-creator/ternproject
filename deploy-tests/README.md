# Recette de déploiement

Ce que TERN fait sur une machine où il n'a jamais tourné, sur trois
distributions, mesuré plutôt qu'annoncé.

## Pourquoi ce banc existe

`scripts/setup.sh` installe désormais Docker quand il manque, et il le fait
différemment selon le gestionnaire de paquets. Ce chemin ne s'exerce nulle part
ailleurs : les tests unitaires et d'intégration tournent sur une machine où
Docker est déjà là, et la suite end-to-end démarre une pile sur cette même
machine. Un défaut dans la branche `dnf` ne se verrait qu'au premier
utilisateur sous Rocky.

Trois systèmes, trois gestionnaires, un déroulé identique :

| Distribution     | Gestionnaire | Trace                |
| ---------------- | ------------ | -------------------- |
| Ubuntu 24.04 LTS | `apt-get`    | [`ubuntu/`](ubuntu/) |
| Rocky Linux 9    | `dnf`        | [`rocky/`](rocky/)   |
| Arch Linux       | `pacman`     | [`arch/`](arch/)     |

## Images cloud, et non ISO d'installation

Ce qui est testé ici est l'installation de TERN sur un système fraîchement
posé — pas les installateurs d'Ubuntu, de Rocky et d'Arch. Scripter
`autoinstall`, un `kickstart` et un `pacstrap` aurait ajouté trois programmes à
déboguer sans rien valider du produit, et aurait rendu le banc plus fragile que
la chose qu'il mesure.

Les images cloud sont les mêmes systèmes, publiés par les mêmes projets, sans
paquet supplémentaire. Docker est absent des trois au départ, et la trace le
constate avant de commencer.

## Le déroulé, sur chacune

1. La VM démarre, cloud-init pose un compte, SSH répond.
2. **Docker est absent** — vérifié, pas supposé.
3. `setup.sh` est lancé. Il détecte le gestionnaire, demande avant d'installer,
   installe le moteur et le greffon Compose v2, active le service.
4. Il **s'arrête** : le compte courant n'appartient pas encore au groupe
   `docker`. C'est voulu, et la trace garde le message.
5. La commande donnée est exécutée telle quelle, puis `setup.sh` est relancé.
   Il pose ses questions, écrit `.env`, tire l'image publiée et démarre la pile.
6. L'instance répond sur `/health`, **depuis l'hôte**, à travers la redirection
   de port — donc le port publié fonctionne réellement.
7. La fenêtre de premier lancement est ouverte ; un compte administrateur et une
   page sont créés ; la fenêtre se referme derrière eux.
8. Un contrôle HTTP est créé sur une **cible publique** (`https://example.com/`).
9. Un agent est installé par `install.sh` et appairé par code PIN.
10. La cible remonte `operational`, et la page publique sert son résumé.

Chaque étape est enregistrée dans `<distribution>/resultats.json`, avec les
journaux complets dans `<distribution>/logs/` et les captures d'écran de la
console dans `<distribution>/screenshots/`.

## Les identifiants

Ils sont en clair, ici et dans les traces, et c'est délibéré : ce sont ceux de
machines virtuelles jetables, sans accès entrant depuis autre chose que l'hôte,
détruites à la fin de la recette. Un secret qui mériterait d'être protégé
n'aurait rien à faire dans un banc de test.

| Quoi                    | Utilisateur         | Mot de passe          |
| ----------------------- | ------------------- | --------------------- |
| Compte système de la VM | `tern`              | `tern-lab-2026`       |
| Administrateur TERN     | `admin@lab.example` | `tern-lab-admin-2026` |

## Rejouer

```sh
python3 .vm-lab/run.py ubuntu     # ou rocky, ou arch
```

Le banc lui-même est dans `.vm-lab/`, ignoré par git : il contient des disques
de plusieurs gigaoctets. Seule la trace est conservée.
