"""
Répondre au script d'installation comme une personne le ferait.

Piper un bloc de réponses dans `ssh -tt` marchait tant qu'on savait exactement
combien de questions seraient posées — et ce n'est jamais vrai d'un script qui
n'en pose que ce qui manque. Une question de moins, et toutes les réponses
suivantes se décalent d'un cran : le port publié devient « o », Compose refuse,
et la panne semble venir du produit. Une question de plus, et le flux s'épuise :
le script attend indéfiniment sur `read`, sans rien afficher qui l'explique.

Alors on lit ce que le script écrit, et on répond quand il demande. C'est aussi
la seule façon de garder une trace de l'échange telle qu'elle s'est produite —
questions et réponses dans l'ordre, ce qu'un bloc de stdin ne montre pas.
"""

import os
import pty
import re
import select
import time

ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")


def drive(argv, rules, timeout=3000, idle_hint=None):
    """
    Lance `argv` sur un pseudo-terminal et répond selon `rules`.

    `rules` est une liste de (motif, réponse). Le premier motif qui apparaît en
    fin de sortie déclenche sa réponse, une seule fois — une question reposée
    signale un problème qu'il vaut mieux voir échouer que masquer en répondant
    deux fois.

    Renvoie (code de sortie, transcription).
    """
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(argv[0], argv)

    transcript = []
    pending = list(rules)
    buffer = ""
    deadline = time.time() + timeout
    last_read = time.time()
    status = None

    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 5)
        if r:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            text = chunk.decode("utf-8", "replace")
            transcript.append(text)
            buffer += ANSI.sub("", text)
            last_read = time.time()

            # Seule la fin compte : une question est posée à l'invite, et le
            # début du tampon contient tout ce qui a déjà été répondu.
            tail = buffer[-2000:]
            for i, (pattern, answer) in enumerate(pending):
                if re.search(pattern, tail):
                    # Une question oui/non de cliclack se valide sur la touche
                    # elle-même : `y` et `n` soumettent sans attendre. Y ajouter
                    # un retour chariot laisse un caractère de trop dans le
                    # tampon, que l'invite suivante avale — le port publié
                    # devenait « y8231 », refusé, et l'installation s'arrêtait
                    # là sans que rien ne dise pourquoi.
                    keystroke = answer if answer in ("y", "n") else answer + "\n"
                    os.write(fd, keystroke.encode())
                    transcript.append(f"\n[réponse automatique : {answer!r}]\n")
                    pending.pop(i)
                    buffer = ""
                    break
        else:
            # Rien depuis longtemps et plus rien à répondre : le script attend
            # une question qu'on n'a pas prévue, ou il a fini sans fermer le
            # terminal. Dans les deux cas il faut rendre la main avec la trace.
            if idle_hint and time.time() - last_read > idle_hint:
                transcript.append(
                    f"\n[silence de {idle_hint}s — réponses restantes : {[p for p, _ in pending]}]\n"
                )
                break

        done = os.waitpid(pid, os.WNOHANG)
        if done[0] == pid:
            status = done[1]
            break

    if status is None:
        try:
            status = os.waitpid(pid, os.WNOHANG)[1]
        except ChildProcessError:
            status = 0

    os.close(fd)
    code = os.waitstatus_to_exitcode(status) if status is not None else -1
    return code, "".join(transcript)
