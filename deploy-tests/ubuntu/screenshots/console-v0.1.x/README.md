# La console d'un serveur, photographiée

Captures de la console **réelle** d'une VM Ubuntu 24.04 (`TERM=linux`), prises
par QMP pendant que `tern-setup` tournait sur `/dev/tty1`. Pas un rendu simulé :
c'est l'écran d'où venait le rapport « toutes les lignes affichent le même
losange », et c'est le seul endroit où le correctif pouvait être constaté plutôt
qu'argumenté.

Deux passes, dans l'ordre où elles ont eu lieu.

## Première passe — l'installation complète, Docker déjà présent et activé

| Fichier                             | Ce qu'on y voit                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `00-console-vierge.png`             | La console libérée de son getty, avant lancement. Point de référence.                            |
| `02-questions-port-url-proxys.png`  | Deux questions répondues, une ouverte. `o` vert pour ce qui est derrière nous, `?` cyan pour la question, `i` bleu pour l'information — plus un seul losange. |
| `03-oui-non-non-retenu.png`         | Le oui/non : `[ No ]` en vidéo inverse, `Yes` en gris.                                           |
| `04-oui-non-oui-retenu.png`         | Le même après une flèche : `[ Yes ]` en inverse, `No` en gris. La sélection se lit sans légende. |
| `05-checklist-trois-etats.png`      | **La capture qui compte.** Vert `+` terminé, gras `|` en cours, gris `.` à venir, et la barre `#######-----------`. Trois états distincts au premier coup d'œil, sans un seul caractère hors ASCII. |
| `06-panneau-final.png`              | Le panneau de clôture.                                                                           |

## Seconde passe — Docker présent mais **non activé au démarrage**

L'état fautif découvert en testant le redémarrage : la pile ne revenait pas.

| Fichier                                | Ce qu'on y voit                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `07a-` / `07b-question-docker-au-boot.png` | La question ajoutée : `!` jaune pour l'avertissement, `i` bleu pour ce que ça coûte, puis `[ Yes ]  No`. Deux clichés du même écran. |
| `08-docker-active-au-boot.png`         | La réponse acceptée : `+` vert, « Docker will start with this machine. »            |
| `09-panneau-final-seconde-passe.png`   | Le panneau, seconde passe.                                                          |

## Ce que ces images ne montrent pas

Le cadre des boîtes. Il est bien émis — `│ ─ ╮ ╯` — mais peint en `\e[38;5;8m`,
que cette console rend en noir sur noir. On voit le contenu des panneaux sans
les panneaux. Rien de lisible n'est dessiné dans la gouttière, donc aucune
information n'est perdue ; c'est la structure qui disparaît. Suivi dans
`BACKLOG.md`.
