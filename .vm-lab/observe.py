#!/usr/bin/env python3
"""
Regarder une installation conduite à la main, et n'y toucher à rien.

Le pilote automatique répond aux questions ; celui-ci se tait. La différence
compte : ce qui est mesuré ici est ce qu'une personne obtient réellement, avec
les hésitations, les valeurs qu'elle choisit et les chemins qu'elle emprunte —
pas ceux qu'un banc a décidé d'emprunter pour elle.

Il n'exécute rien sur la machine observée hormis des lectures : présence de
Docker, état des conteneurs, valeurs non secrètes du `.env`, réponse de l'API.
Aucune écriture, aucun `docker` autre que `ps`, aucune réponse envoyée sur un
terminal.
"""

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lab import (  # noqa: E402
    BRIDGE, TARGETS, TRACE, VM_PASSWORD, VM_USER, boot, lan_address, screenshot, ssh, wait_port,
)

# Toutes les 20 secondes : assez fin pour dater les étapes d'une installation,
# assez espacé pour ne pas peser sur une VM à 2 Go qui compile et télécharge.
INTERVAL = 20


def snapshot(name: str) -> dict:
    """Ce que la machine dit d'elle-même, sans rien lui demander de faire."""
    t = TARGETS[name]

    docker = ssh(name, "command -v docker >/dev/null 2>&1 && docker --version || echo absent", timeout=20)
    containers = ssh(name, "sudo docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null || true", timeout=20)
    groups = ssh(name, f"id -nG {VM_USER}", timeout=20)
    env = ssh(
        name,
        # Jamais APP_SECRET ni le mot de passe de la base : une trace destinée à
        # être lue et partagée n'a pas à les porter.
        "grep -E '^(TERN_HTTP_PORT|PUBLIC_BASE_URL|TERN_IMAGE|TERN_AGENT_NETWORK_MODE|"
        "TERN_LOCAL_AGENT_SERVER|TRUSTED_PROXIES)=' ~/.env 2>/dev/null || true",
        timeout=20,
    )
    sessions = ssh(name, "who", timeout=20)

    health = {}
    for port in (t["http_port"], t["http_port"] + 100, t["http_port"] + 200):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as r:
                health[port] = r.status
        except urllib.error.HTTPError as e:
            health[port] = e.code
        except Exception:  # noqa: BLE001
            pass

    return {
        "docker": docker.stdout.strip(),
        "conteneurs": [line for line in containers.stdout.splitlines() if line.strip()],
        "groupes": groups.stdout.strip(),
        "env": [line for line in env.stdout.splitlines() if line.strip()],
        "sessions": [line for line in sessions.stdout.splitlines() if line.strip()],
        "health": health,
    }


def main(name: str) -> int:
    out = TRACE / name
    (out / "logs").mkdir(parents=True, exist_ok=True)
    timeline = out / "logs" / "observation.jsonl"
    timeline.write_text("")

    t = TARGETS[name]
    proc = boot(name)

    print(f"=== {t['label']} — VM vierge, conduite à la main ===")
    print(f"  console  : la fenêtre QEMU (clavier FR)")
    print(f"  compte   : {VM_USER} / {VM_PASSWORD}   (sudo sans mot de passe)")
    print(f"  ssh      : ssh -i {Path(__file__).parent / 'id_lab'} -p {t['ssh_port']} {VM_USER}@127.0.0.1")
    print(f"  ports    : {t['http_port']} → {t['http_port']}, {t['http_port'] + 100} → 8080, {t['http_port'] + 200} → 9999")
    print("  j'observe et j'enregistre ; je ne tape rien.\n", flush=True)

    if not wait_port(t["ssh_port"], 300):
        print("  ✗ la VM n'a pas répondu en SSH", flush=True)
        return 1

    lan = lan_address(name)
    if lan:
        print(f"  ✓ VM démarrée — adresse sur le réseau local : {lan}")
        print(f"    joignable depuis n'importe quelle machine du LAN.")
        print(f"    À la question « URL publique », répondez : http://{lan}:<port choisi>\n", flush=True)
    else:
        print(f"  ✓ VM démarrée — pas encore d'adresse sur {BRIDGE}, elle arrivera.\n", flush=True)
    screenshot(name, "00-vierge")

    previous = None
    tick = 0
    try:
        while True:
            state = snapshot(name)
            entry = {"t": int(time.time()), "etat": state}
            with timeline.open("a") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

            # Une capture et une ligne seulement quand quelque chose bouge : une
            # trace où rien ne change n'est pas une trace, c'est du bruit à lire.
            if state != previous:
                marks = []
                if state["docker"] != "absent":
                    marks.append(state["docker"])
                if "docker" in state["groupes"]:
                    marks.append("compte dans le groupe docker")
                if state["conteneurs"]:
                    marks.append(f"{len(state['conteneurs'])} conteneur(s)")
                if state["health"]:
                    marks.append("API : " + ", ".join(f"{p}={c}" for p, c in state["health"].items()))
                print(f"  [{time.strftime('%H:%M:%S')}] " + " · ".join(marks or ["rien encore"]), flush=True)
                screenshot(name, f"{tick:02d}-etape")
                previous = state
                tick += 1

            time.sleep(INTERVAL)
    except KeyboardInterrupt:
        print("\n  observation arrêtée.", flush=True)
    finally:
        screenshot(name, "99-final")
        proc.terminate()

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "ubuntu"))
