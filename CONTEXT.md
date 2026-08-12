# CONTEXT

## Current Task

Rien en cours. `BACKLOG.md` entièrement coché ; `v0.1.32` publiée. Ne restent
que deux gestes qui demandent les machines de Jacques — mettre à jour l'agent de
.170, et supprimer les doublons déjà en base.

## Key Decisions

- **Un canal d'ordres**, parce que rien n'atteint un agent : ils interrogent, et
  un agent de zone n'a aucune route de retour. Six ordres — page, logs,
  redémarrage, pause, reprise, arrêt — pris au prochain sondage. Le relais porte
  ceux de sa zone et fait remonter les réponses sous sa clé.
- **Pause et stop** ne diffèrent que par ce qui continue d'écouter. Arrêté, rien
  n'entend une reprise : c'est ce qui le rend définitif, et la seule porte de
  sortie est `tern-agent resume` sur la machine. Les deux états sont dans la
  config, parce que le superviseur relance à toute sortie.
- **Le mot de passe de la page** revient comme réponse à `ui-on` : haché à
  l'écriture, c'est le seul instant où il existe ailleurs que sur la machine.
- **Les sondages de démarrage avalaient les ordres** — sur l'agent puis sur le
  relais. Le serveur les marque livrés en les livrant, donc ils étaient
  détruits. C'était le chemin le plus probable : on redémarre pour hâter.

## Next Steps

- Latence jusqu'à 5 min sur les ordres — piste : cadence courte tant qu'un ordre
  attend, ou signal sur le heartbeat qui bat toutes les minutes.
- Documentation : ordres, `resume`, page du relais, mise à jour, identifiant
  d'installation.
