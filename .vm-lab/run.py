#!/usr/bin/env python3
"""
Le déroulé, sur une distribution, du début à la supervision d'une cible.

Reproduit ce qu'une personne fait, dans l'ordre où elle le fait, y compris le
détour que le script lui impose : après avoir installé Docker, `setup.sh`
s'arrête parce que le compte courant n'appartient pas encore au groupe `docker`,
et lui donne la commande. C'est le comportement voulu, et le rejouer ici est la
seule façon de vérifier que le message dit vrai.
"""

import json
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dialogue import drive  # noqa: E402
from lab import (  # noqa: E402
    LAB, REPO, TRACE, TARGETS, VM_USER, VM_PASSWORD,
    TERN_ADMIN_EMAIL, TERN_ADMIN_PASSWORD, TERN_PAGE_NAME, TERN_PAGE_SLUG,
    PUBLIC_TARGET, boot, lan_address, wait_port, ssh, screenshot,
)

STEPS = []


class Incomplete(Exception):
    """
    L'installation ne s'est pas terminée, et la suite ne prouverait rien.

    Une exception plutôt qu'un `return` : le `finally` qui éteint la VM et
    l'écriture de `resultats.json` restent sur le chemin, ce qu'un retour
    anticipé au milieu du bloc ferait sauter. Une distribution où l'installateur
    refuse est un résultat à tracer, pas un run à perdre.
    """


def step(name: str, ok: bool, detail: str = ""):
    STEPS.append({"name": name, "ok": ok, "detail": detail})
    print(f"  {'✓' if ok else '✗'} {name}" + (f" — {detail}" if detail and not ok else ""))
    return ok


def http(url: str, method: str = "GET", body=None, timeout: int = 20):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), e.headers
    except Exception as e:  # noqa: BLE001
        return 0, str(e), None


def main(name: str) -> int:
    t = TARGETS[name]
    out = TRACE / name
    out.mkdir(parents=True, exist_ok=True)
    logs = out / "logs"
    logs.mkdir(exist_ok=True)

    print(f"\n=== {t['label']} ===")

    proc = boot(name)
    try:
        if not step("La VM démarre et répond en SSH", wait_port(t["ssh_port"], 300)):
            return 1
        # cloud-init peut encore écrire le compte quand le port répond.
        for _ in range(30):
            if ssh(name, "true", timeout=20).returncode == 0:
                break
            time.sleep(5)

        screenshot(name, "01-demarree")

        r = ssh(name, "cat /etc/os-release | head -2")
        (logs / "os-release.txt").write_text(r.stdout)

        absent = ssh(name, "command -v docker").returncode != 0
        step("Docker est absent au départ", absent, r.stdout)

        # L'adresse du LAN, connue avant les questions : c'est elle que l'on
        # donnera comme URL publique, et c'est tout l'intérêt du pont — une
        # instance joignable d'ailleurs que de sa propre machine.
        lan = lan_address(name)
        step("La VM a une adresse sur le réseau local", bool(lan), lan)

        # Seul le script d'amorçage, récupéré comme n'importe qui le ferait.
        # Ni binaire déposé, ni compose : `tern-setup` va chercher l'un, et le
        # second est téléchargé par lui.
        fetch = ssh(
            name,
            "curl -fsSL -o setup.sh "
            "https://raw.githubusercontent.com/lelabnet-creator/ternproject/main/scripts/setup.sh",
            timeout=120,
        )
        step("Le script d'amorçage se récupère depuis GitHub", fetch.returncode == 0, fetch.stderr)

        # Le chemin réel : le script d'amorçage, récupéré depuis GitHub, qui
        # choisit le binaire, vérifie son empreinte et lui passe la main.
        #
        # Le banc ne dépose plus rien : depuis que la release publie
        # `tern-setup`, l'installation est exactement celle d'un inconnu qui
        # n'a qu'une URL. C'est la seule version du test qui prouve quelque
        # chose sur le produit livré.
        answers = [
            # cliclack soumet directement sur `y` et `n` — pas besoin de
            # simuler les flèches, ce qui rendrait ce pilote dépendant du
            # rendu plutôt que du dialogue.
            (r"Install Docker now", "y"),
            # Les trois questions que seule une distribution pose. Une règle qui
            # ne trouve jamais son motif ne coûte rien — `drive` ne répond qu'à
            # ce qui apparaît — et les inscrire toutes ici garde une seule liste
            # pour les trois recettes, au lieu d'une liste par distribution qui
            # divergerait au premier changement.
            (r"Upgrade the system first", "y"),          # Arch : base de paquets périmée
            (r"Add Docker's repository", "y"),           # Rocky : rien à installer sans ça
            (r"Start Docker with this machine", "y"),    # partout où le service n'est pas activé
            (r"Add .* to the docker group", "y"),
            (r"Port published on the host", str(t["http_port"])),
            (r"Public URL", f"http://{lan or '127.0.0.1'}:{t['http_port']}"),
            (r"Trusted proxy CIDRs", ""),
            (r"Watch this machine's own services", "n"),
        ]

        code, out = drive(
            ["ssh", "-tt", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
             "-o", "LogLevel=ERROR", "-i", str(LAB / "id_lab"), "-p", str(t["ssh_port"]),
             f"{VM_USER}@127.0.0.1", "cd ~ && sh setup.sh"],
            answers, timeout=3000, idle_hint=300,
        )
        (logs / "setup.log").write_text(out)
        screenshot(name, "02-installation")

        installed = ssh(name, "command -v docker && docker --version").returncode == 0
        step(f"L'installateur pose Docker via {t['pkg']}", installed, out[-600:])

        step("L'empreinte du binaire est vérifiée avant exécution",
             "vérifiée" in out or "verified" in out, out[:400])

        compose_v2 = ssh(name, "sudo docker compose version").returncode == 0
        step("Compose v2 est présent", compose_v2)

        in_group = ssh(name, f"id -nG {VM_USER}").stdout
        step("Le script ajoute le compte au groupe docker", "docker" in in_group, in_group)

        # Le binaire dit « Ready — <url> » en sortant, et laisse son journal.
        step("L'installation va au bout sans demander de reconnexion",
             "Ready" in out or "Prêt" in out, out[-400:])

        journal = ssh(name, "wc -l < tern-setup.log 2>/dev/null || echo 0")
        step("Un journal complet est laissé derrière",
             journal.stdout.strip().isdigit() and int(journal.stdout.strip()) > 10,
             journal.stdout)

        screenshot(name, "03-pile-demarree")

        # Sans `sg` : chaque appel `ssh` ouvre une session neuve, et le groupe
        # `docker` y est déjà lu. `sg` n'existe pas partout — sur Arch la
        # commande est simplement absente, et la recette lisait « sg: command
        # not found » là où elle croyait lire l'état de la pile.
        ps = ssh(name, "docker compose -f docker-compose.prod.yml ps")
        (logs / "compose-ps.txt").write_text(ps.stdout + ps.stderr)
        step("La pile tourne (app, db, agent)", ps.stdout.count("tern-prod") >= 3, ps.stdout[-400:])

        base = f"http://127.0.0.1:{t['http_port']}"
        healthy = False
        for _ in range(60):
            code, body, _ = http(f"{base}/health")
            if code == 200:
                healthy = True
                break
            time.sleep(5)
        step("L'instance répond sur /health depuis l'hôte", healthy)

        # Rien de ce qui suit n'a de sens sans instance, et tout s'y attarde :
        # sur Rocky, où l'installation s'était arrêtée avant Docker, la recette
        # a passé quinze minutes à expirer étape après étape avant de mourir sur
        # une trace Python. Un échec doit se lire vite, sinon on cesse de le
        # lire.
        if not healthy:
            print("  → installation incomplète : le reste de la recette est sans objet")
            raise Incomplete()

        # --- premier lancement ---------------------------------------------
        # Journalisé avant toute écriture : au run précédent l'instance se
        # déclarait déjà configurée sans que rien n'ait créé de compte, et sans
        # cette trace il n'y a pas moyen de savoir qui l'a fait.
        who = ssh(name, "docker compose -f docker-compose.prod.yml logs app 2>&1 | tail -40")
        (logs / "app-demarrage.txt").write_text(who.stdout + who.stderr)

        code, body, _ = http(f"{base}/api/v1/setup/state.json")
        (logs / "setup-state-initial.json").write_text(body)
        step("La fenêtre de premier lancement est ouverte", code == 200 and json.loads(body).get("needsSetup") is True, body[:200])

        code, body, headers = http(f"{base}/api/v1/setup/account", "POST", {
            "email": TERN_ADMIN_EMAIL, "name": "Recette", "password": TERN_ADMIN_PASSWORD,
            "tenantName": TERN_PAGE_NAME, "tenantSlug": TERN_PAGE_SLUG,
        })
        step("Le compte administrateur et la page sont créés", code == 200, body[:300])
        cookie = (headers.get("set-cookie", "").split(";")[0] if headers else "")

        code, body, _ = http(f"{base}/api/v1/setup/state.json")
        step("La fenêtre se referme derrière le premier compte",
             code == 200 and json.loads(body).get("needsSetup") is False, body[:200])

        # --- une cible publique supervisée ----------------------------------
        def admin(path, method="GET", payload=None):
            data = json.dumps(payload).encode() if payload is not None else None
            req = urllib.request.Request(f"{base}/api/v1/{TERN_PAGE_SLUG}{path}", data=data, method=method)
            req.add_header("cookie", cookie)
            if data:
                req.add_header("content-type", "application/json")
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return r.status, r.read().decode()
            except urllib.error.HTTPError as e:
                return e.code, e.read().decode()
            except Exception as e:  # noqa: BLE001
                # Une instance qui ne répond pas est un résultat de recette, pas
                # une panne du banc. Sur Rocky, où l'installation s'était
                # arrêtée avant Docker, ce chemin lançait un
                # ConnectionResetError qui tuait la recette : la trace
                # s'arrêtait sur une pile d'appels Python là où elle aurait dû
                # dire quelles étapes avaient échoué, et pourquoi.
                return 0, str(e)

        code, body = admin("/controls", "POST", {
            "key": "example-com", "name": "example.com", "kind": "http",
            # `status_code` avec un `range`, les noms du schéma partagé
            # (`packages/shared/src/probe.ts`). Le banc envoyait `statusIn`,
            # que rien n'a jamais accepté : l'API répondait 400 en nommant les
            # huit types qu'elle connaît, et c'est bien le produit qui avait
            # raison.
            "config": {"url": PUBLIC_TARGET, "method": "GET", "timeoutMs": 5000,
                       "followRedirects": True,
                       "assertions": [{"type": "status_code", "range": [200, 299]}]},
            "expectedIntervalS": 30,
        })
        step("Un contrôle HTTP sur une cible publique est créé", code in (200, 201), body[:300])

        # --- un agent ajouté à la main --------------------------------------
        # `/pairing-codes`, la route que l'admin appelle : un code à durée de
        # vie, pas un appairage. `/agents/pair` n'existe pas et répondait 404,
        # ce qui ressemblait à une régression du produit alors que le banc
        # frappait à une porte qu'il avait inventée.
        code, body = admin("/pairing-codes", "POST", {})
        pin = None
        if code in (200, 201):
            try:
                pin = json.loads(body).get("pin")
            except Exception:  # noqa: BLE001
                pin = None
        step("Un code d'appairage est généré", bool(pin), body[:200])

        if pin:
            # Sans `--no-service`, c'est-à-dire le chemin par défaut : celui
            # qui inscrit l'agent au démarrage. Le tester avec le drapeau qui
            # désactive précisément cette inscription revenait à ne pas la
            # tester du tout.
            inst = ssh(name, f"curl -fsSL -o install.sh {base}/install.sh "
                             f"&& sh install.sh --pin {pin}", timeout=900)
            (logs / "agent-install.log").write_text(inst.stdout + "\n--- stderr ---\n" + inst.stderr)
            step("L'agent s'installe et s'appaire", inst.returncode == 0, (inst.stdout + inst.stderr)[-500:])

            # Service système si l'installation avait les droits, service
            # utilisateur avec `linger` sinon : les deux reviennent au
            # redémarrage, et c'est la question posée. Un `enabled` quelque
            # part, pas un `enabled` à un endroit précis.
            unit = ssh(name, "systemctl is-enabled tern-agent.service 2>/dev/null; "
                             "systemctl --user is-enabled tern-agent.service 2>/dev/null; "
                             "loginctl show-user $(id -un) -p Linger 2>/dev/null || true")
            (logs / "agent-service.txt").write_text(unit.stdout + unit.stderr)
            step("L'agent est inscrit au démarrage", "enabled" in unit.stdout, unit.stdout.strip()[:200])

        screenshot(name, "04-agent-appaire")

        # --- la cible remonte-t-elle ? --------------------------------------
        up = False
        for _ in range(40):
            code, body = admin("/controls")
            if code == 200:
                rows = json.loads(body)
                target = next((c for c in rows if c.get("key") == "example-com"), None)
                if target and target.get("lastCheckStatus") == "operational":
                    up = True
                    break
            time.sleep(15)
        step(f"La cible publique est mesurée et remonte 'operational'", up)

        # `http` rend trois valeurs, `admin` en rend deux — la ligne les
        # confondait et la recette mourait d'un ValueError sur sa dernière
        # vérification, après que tout le reste était passé.
        code, body, _ = http(f"{base}/api/v1/public/{TERN_PAGE_SLUG}/summary.json")
        (logs / "summary.json").write_text(body)
        step("La page publique sert son résumé", code == 200)

        screenshot(name, "05-supervision")

        # --- et après un redémarrage ? --------------------------------------
        # La seule preuve de la phrase que le panneau de clôture affiche —
        # « redémarrés avec la machine ». Tout ce qui précède se mesure sur une
        # machine qui n'a pas encore éteint, et une pile qui tourne aujourd'hui
        # n'est pas une pile qui revient demain.
        #
        # Mesuré avant toute commande Docker de la session, parce qu'un
        # `docker ps` réveille à lui seul la pile quand `docker.socket` est
        # activé sans `docker.service` : on verrait une machine saine là où le
        # site est resté éteint pour tout le monde.
        ssh(name, "sudo systemctl reboot || sudo reboot", timeout=30)
        time.sleep(10)
        back = wait_port(t["ssh_port"], 300)
        step("La VM redémarre", back)

        if back:
            revived = False
            for _ in range(60):
                code, _, _ = http(f"{base}/health", timeout=10)
                if code == 200:
                    revived = True
                    break
                time.sleep(5)
            step("L'instance revient d'elle-même après un redémarrage", revived)

            agent_back = ssh(name, "pgrep -af tern-agent | head -3")
            step("L'agent revient d'elle-même après un redémarrage",
                 "tern-agent" in agent_back.stdout, agent_back.stdout.strip()[:200])
            screenshot(name, "06-apres-redemarrage")

        j = ssh(name, "sudo journalctl -u docker --no-pager -n 20 || true")
        (logs / "journal-docker.txt").write_text(j.stdout)

    except Incomplete:
        pass

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()

    (out / "resultats.json").write_text(json.dumps({
        "distribution": t["label"],
        "gestionnaire": t["pkg"],
        "identifiants": {
            "vm": {"utilisateur": VM_USER, "motDePasse": VM_PASSWORD},
            "tern": {"email": TERN_ADMIN_EMAIL, "motDePasse": TERN_ADMIN_PASSWORD},
        },
        "etapes": STEPS,
    }, indent=2, ensure_ascii=False))

    failed = [s for s in STEPS if not s["ok"]]
    print(f"  → {len(STEPS) - len(failed)}/{len(STEPS)} étapes réussies")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
