#!/usr/bin/env python3
"""
Ce que l'installateur donne à voir sur une vraie console.

`run.py` conduit l'installation par SSH, dans un terminal qui a une police
complète et deux cent cinquante-six couleurs. C'est le chemin le plus courant et
ce n'est pas celui qui casse : les défauts signalés — l'encre grise invisible,
les états de checklist rendus par un seul et même losange, le cadre peint dans
la couleur du fond — n'existent tous que sur la console d'un serveur, seize
couleurs et une police qui n'a pas les caractères semi-graphiques.

Alors on regarde là. Le programme est lancé sur `tty1` par `openvt`, et l'écran
est photographié par QMP — le même chemin que les captures de la recette, sauf
qu'il y a cette fois quelque chose dessus.

C'est `examples/render.rs` qui est lancé, pas l'installateur : il dessine les
mêmes écrans avec le même thème, sans rien poser sur la machine et sans attendre
de réponse. Un binaire construit ici plutôt que celui de la release, parce que
la question posée est « à quoi ressemble ce que je viens d'écrire », et que la
release ne le porte qu'après coup.

    python3 console.py ubuntu

Les captures atterrissent dans deploy-tests/<distribution>/console/.
"""

import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lab import (  # noqa: E402
    LAB, TRACE, TARGETS, VM_USER, boot, wait_port, ssh, screenshot,
)

ROOT = Path(__file__).resolve().parent.parent
RENDER = ROOT / "clients/installer/target/x86_64-unknown-linux-musl/release/examples/render"

# Les écrans qui portent la réponse, et la langue dans laquelle chacun la porte.
# Les deux langues sur le même écran plutôt qu'un doublon de tout : ce qui est
# vérifié ici est le rendu, et une chaîne traduite ne change pas la couleur d'un
# filet — mais une chaîne traduite plus longue peut changer la largeur d'une
# boîte, et c'est cela qui mérite une capture.
ECRANS = [
    ("states", "en", "01-etats-checklist"),
    ("states", "fr", "02-etats-checklist-fr"),
    ("prompts", "en", "03-questions"),
    ("docker", "en", "04-installation-docker"),
]


def push(name: str, src: Path, dest: str) -> bool:
    t = TARGETS[name]
    r = subprocess.run(
        ["scp", "-O", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
         "-o", "LogLevel=ERROR", "-i", str(LAB / "id_lab"), "-P", str(t["ssh_port"]),
         str(src), f"{VM_USER}@127.0.0.1:{dest}"],
        capture_output=True, text=True, timeout=120,
    )
    if r.returncode != 0:
        print(f"  ✗ copie de {src.name} : {r.stderr.strip()[:200]}")
    return r.returncode == 0


def main(name: str) -> int:
    if not RENDER.is_file():
        print("Le binaire de rendu n'existe pas. Construisez-le :\n"
              "  cd clients/installer && cargo build --release --example render \\\n"
              "      --target x86_64-unknown-linux-musl")
        return 1

    out = TRACE / name / "console"
    out.mkdir(parents=True, exist_ok=True)

    proc = boot(name)
    try:
        if not wait_port(t_ssh := TARGETS[name]["ssh_port"], 300):
            print("  ✗ la VM ne répond pas en SSH")
            return 1
        for _ in range(30):
            if ssh(name, "true", timeout=20).returncode == 0:
                break
            time.sleep(5)
        print(f"  ✓ VM démarrée (ssh {t_ssh})")

        if not push(name, RENDER, "render"):
            return 1
        ssh(name, "chmod +x render")

        for mode, lang, label in ECRANS:
            # `openvt -s -w` bascule sur la console et attend la fin du
            # programme : sans `-s` l'écran photographié resterait celui de la
            # connexion, et sans `-w` la capture arriverait avant le dessin.
            #
            # `TERM=linux` et la locale sont passés explicitement : c'est ce que
            # la console porte réellement, et c'est ce dont la détection de jeu
            # de caractères se sert pour choisir entre `+` et `✓`.
            ssh(name,
                f"sudo openvt -c 1 -s -w -- env TERM=linux LANG=C.UTF-8 "
                f"TERN_LANG={lang} ./render {mode} > /dev/null 2>&1 &",
                timeout=30)
            time.sleep(6)
            err = screenshot(name, f"../console/{label}")
            print(f"  {'✗' if err else '✓'} {label}" + (f" — {err}" if err else ""))
            # La console est rendue avant l'écran suivant, sinon les deux se
            # superposent et la capture ne montre ni l'un ni l'autre.
            ssh(name, "sudo chvt 1 && sudo clear > /dev/tty1", timeout=20)
            time.sleep(1)

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()

    print(f"  → captures dans {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "ubuntu"))
