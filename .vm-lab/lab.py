#!/usr/bin/env python3
"""
Recette de déploiement — trois distributions, une machine virtuelle chacune.

Ce que ce banc valide, et qui ne peut pas l'être autrement : `scripts/setup.sh`
sur un système où Docker n'a jamais été installé. Le chemin ajouté récemment —
détection du gestionnaire de paquets, installation, activation du service,
appartenance au groupe `docker` — ne s'exerce nulle part ailleurs, et se trompe
différemment sur apt, dnf et pacman.

Images cloud plutôt qu'ISO d'installation : ce sont les mêmes systèmes, publiés
par les mêmes projets. Scripter `autoinstall`, `kickstart` et un `pacstrap`
manuel aurait ajouté trois installateurs à déboguer sans rien valider du
produit.

Deux cartes réseau par VM : une en mode utilisateur pour l'administration du
banc — toujours à la même adresse, indépendante de tout DHCP — et une pontée sur
le réseau local, qui donne à la VM une vraie adresse joignable depuis n'importe
quelle machine. Voir `boot()` pour le détail de ce partage.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

LAB = Path(__file__).resolve().parent
REPO = LAB.parent
TRACE = REPO / "deploy-tests"
IMAGES = LAB / "images"

# Le pont de l'hôte qui porte le réseau local. Déjà autorisé dans
# /etc/qemu/bridge.conf, ce qui est la condition pour que le helper setuid
# accepte d'y raccorder une VM sans demander les droits root.
BRIDGE = os.environ.get("TERN_LAB_BRIDGE", "br0")

# La carte d'administration, en mode utilisateur. MAC fixe pour que la
# configuration réseau de cloud-init puisse l'apparier sans ambiguïté.
MGMT_MAC = "52:54:00:73:00:00"

# Le mot de passe de recette. Écrit en clair ici et dans la trace parce que
# c'est précisément ce qu'il est : le mot de passe d'une VM jetable, sans accès
# réseau entrant, détruite à la fin. Un secret qu'il faudrait protéger n'aurait
# rien à faire dans un banc de test.
VM_USER = "tern"
VM_PASSWORD = "tern-lab-2026"

TERN_ADMIN_EMAIL = "admin@lab.example"
TERN_ADMIN_PASSWORD = "tern-lab-admin-2026"
TERN_PAGE_NAME = "Lab"
TERN_PAGE_SLUG = "lab"

# La cible publique supervisée depuis chaque VM. Choisie parce qu'elle existe
# pour ça, ne demande pas d'authentification et répond partout.
PUBLIC_TARGET = "https://example.com/"

TARGETS = {
    "ubuntu": {
        "image": "ubuntu.img",
        "ssh_port": 2231,
        "http_port": 8231,
        "qmp_port": 4441,
        "label": "Ubuntu 24.04 LTS (cloud image)",
        "pkg": "apt",
        "mac": "52:54:00:73:31:01",
    },
    "rocky": {
        "image": "rocky.qcow2",
        "ssh_port": 2232,
        "http_port": 8232,
        "qmp_port": 4442,
        "label": "Rocky Linux 9 (GenericCloud)",
        "pkg": "dnf",
        "mac": "52:54:00:73:32:02",
    },
    "arch": {
        "image": "arch.qcow2",
        "ssh_port": 2233,
        "http_port": 8233,
        "qmp_port": 4443,
        "label": "Arch Linux (cloud image)",
        "pkg": "pacman",
        "mac": "52:54:00:73:33:03",
    },
}


def run(cmd, **kw):
    return subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, **kw)


def seed_iso(name: str) -> Path:
    """
    Le disque cloud-init : un utilisateur, un mot de passe, une clé SSH.

    Fabriqué avec xorriso plutôt que cloud-localds, absent ici. Le nom de volume
    `CIDATA` est ce que cloud-init cherche ; sans lui le disque est ignoré et la
    VM démarre sans compte utilisable, ce qui ressemble à un démarrage bloqué.
    """
    d = LAB / name / "seed"
    d.mkdir(parents=True, exist_ok=True)

    pubkey = (LAB / "id_lab.pub").read_text().strip()

    (d / "meta-data").write_text(f"instance-id: {name}\nlocal-hostname: {name}\n")
    (d / "user-data").write_text(
        "#cloud-config\n"
        f"hostname: {name}\n"
        "users:\n"
        f"  - name: {VM_USER}\n"
        "    sudo: ALL=(ALL) NOPASSWD:ALL\n"
        "    shell: /bin/bash\n"
        "    lock_passwd: false\n"
        f"    plain_text_passwd: {VM_PASSWORD}\n"
        "    ssh_authorized_keys:\n"
        f"      - {pubkey}\n"
        "ssh_pwauth: true\n"
        # Sans cela, l'image Arch démarre sans resolver et rien ne se télécharge.
        "manage_resolv_conf: true\n"
        "resolv_conf:\n"
        "  nameservers: [1.1.1.1, 8.8.8.8]\n"
        # Clavier français sur la console. Le banc tape par SSH et s'en moque ;
        # ces VM sont aussi regardées et pilotées à la main par la fenêtre QEMU,
        # et un AZERTY qui répond en QWERTY transforme la moindre vérification en
        # jeu de devinettes.
        "keyboard:\n"
        "  layout: fr\n"
        # Deux fois, parce que `keyboard:` est récent côté cloud-init et absent
        # de certaines images : `loadkeys` règle la console tout de suite, sans
        # rien supposer de la version.
        "runcmd:\n"
        "  - [ sh, -c, 'loadkeys fr 2>/dev/null || true' ]\n"
    )

    # La configuration réseau, et surtout l'ordre des routes.
    #
    # Sans ce fichier, cloud-init ne monte que la première interface : la carte
    # pontée reste DOWN et la VM n'a pas d'adresse sur le réseau local. Les deux
    # sont appariées par MAC, ce qui est la seule chose connue d'avance — les
    # noms (`enp0s2`, `enp0s3`) dépendent de l'ordre d'énumération PCI.
    #
    # Les métriques ne sont pas décoratives. Les deux cartes obtiennent une
    # route par défaut, et c'est celle de plus faible métrique qui décide de
    # l'adresse source retenue pour sortir — donc celle que `setup.sh` proposera
    # comme URL publique. On veut l'adresse du LAN, joignable de partout, et non
    # le 10.0.2.15 de l'émulateur qui ne désigne rien pour personne.
    (d / "network-config").write_text(
        "version: 2\n"
        "ethernets:\n"
        "  lan:\n"
        f"    match: {{macaddress: {TARGETS[name]['mac']}}}\n"
        "    dhcp4: true\n"
        "    dhcp4-overrides: {route-metric: 100}\n"
        "  mgmt:\n"
        f"    match: {{macaddress: {MGMT_MAC}}}\n"
        "    dhcp4: true\n"
        "    dhcp4-overrides: {route-metric: 300}\n"
    )

    iso = LAB / name / "seed.iso"
    r = run(["xorriso", "-as", "mkisofs", "-output", str(iso), "-volid", "CIDATA",
             "-joliet", "-rock",
             str(d / "user-data"), str(d / "meta-data"), str(d / "network-config")])
    if r.returncode != 0:
        raise SystemExit(f"seed iso {name}: {r.stderr[-2000:]}")
    return iso


def disk_for(name: str) -> Path:
    """
    Une copie de travail, agrandie.

    L'image d'origine reste intacte : les trois VM sont relancées plusieurs fois
    pendant la mise au point, et repartir d'un disque déjà installé donnerait un
    résultat qui ne prouve rien. Agrandie parce que l'image TERN et ses couches
    ne tiennent pas dans les 2 à 10 Go d'origine.
    """
    src = IMAGES / TARGETS[name]["image"]
    dst = LAB / name / "disk.qcow2"
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    shutil.copy2(src, dst)
    run(["qemu-img", "resize", str(dst), "20G"])
    return dst


def free_ports(name: str, timeout: int = 60) -> None:
    """
    Attendre que la VM précédente ait rendu ses ports.

    Tuer un processus ne libère pas ses sockets dans la seconde, et QEMU refuse
    de démarrer sur un port occupé — il sort avec « Failed to find an available
    port », sans fenêtre et sans rien d'autre. Vu de l'extérieur, la VM n'a
    simplement pas démarré, ce qui envoie chercher la panne partout sauf là où
    elle est.
    """
    t = TARGETS[name]
    ports = [t["ssh_port"], t["qmp_port"], t["http_port"],
             t["http_port"] + 100, t["http_port"] + 200]
    deadline = time.time() + timeout

    while time.time() < deadline:
        busy = []
        for port in ports:
            with socket.socket() as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    probe.bind(("127.0.0.1", port))
                except OSError:
                    busy.append(port)
        if not busy:
            return
        time.sleep(2)

    raise SystemExit(f"ports encore occupés après {timeout}s : {busy}")


def boot(name: str) -> subprocess.Popen:
    free_ports(name)
    t = TARGETS[name]
    disk = disk_for(name)
    seed = seed_iso(name)

    cmd = [
        "qemu-system-x86_64",
        "-name", f"tern-lab-{name}",
        "-machine", "q35,accel=kvm",
        "-cpu", "host",
        "-smp", "2",
        "-m", "2048",
        "-drive", f"file={disk},if=virtio,format=qcow2",
        "-drive", f"file={seed},if=virtio,format=raw,readonly=on",
        # Deux cartes réseau, et chacune répond à un besoin que l'autre ne peut
        # pas couvrir.
        #
        # La première est en mode utilisateur, avec les ports redirigés : c'est
        # le chemin d'administration du banc. Il ne dépend d'aucun DHCP, d'aucun
        # bail, d'aucune adresse à découvrir — `127.0.0.1:2231` est toujours la
        # bonne, même quand le réseau de la VM est cassé, ce qui est justement
        # le moment où il faut pouvoir entrer.
        #
        # La seconde est pontée sur `br0`, qui porte le réseau local. La VM y
        # prend une adresse du LAN et devient joignable depuis n'importe quelle
        # machine — ce que le mode utilisateur ne permet pas : son 10.0.2.15 est
        # privé à l'émulateur et rien ne route vers lui.
        #
        # Le pont passe par `qemu-bridge-helper`, setuid root, et `br0` figure
        # déjà dans `/etc/qemu/bridge.conf`. Aucun privilège à demander, aucune
        # interface de l'hôte à reconfigurer — et donc aucun risque de couper le
        # réseau de la machine qui héberge le banc.
        "-netdev",
        "user,id=mgmt"
        f",hostfwd=tcp::{t['ssh_port']}-:22"
        f",hostfwd=tcp::{t['http_port']}-:{t['http_port']}"
        f",hostfwd=tcp::{t['http_port'] + 100}-:8080"
        f",hostfwd=tcp::{t['http_port'] + 200}-:9999",
        "-device", f"virtio-net-pci,netdev=mgmt,mac={MGMT_MAC}",
        "-netdev", f"bridge,id=lan,br={BRIDGE}",
        # MAC fixe : c'est ce qui permet de retrouver l'adresse que le DHCP a
        # donnée, sans deviner et sans scanner le réseau.
        "-device", f"virtio-net-pci,netdev=lan,mac={t['mac']}",
        # Une fenêtre quand il y a un serveur d'affichage, sinon rien. Le banc
        # tourne sans surveillance la plupart du temps, mais pouvoir regarder la
        # console — et y taper — est ce qui permet de comprendre un blocage sans
        # deviner. `-nographic` est exclu dans les deux cas : il supprimerait
        # l'écran dont les captures sont tirées.
        "-display", "gtk" if os.environ.get("TERN_LAB_WINDOW") else "none",
        # Le clavier vu par la machine émulée. Le réglage cloud-init plus haut
        # arrange la console du système ; celui-ci arrange la couche en dessous,
        # et les deux sont nécessaires pour que la fenêtre réponde en AZERTY.
        "-k", "fr",
        "-vga", "std",
        "-qmp", f"tcp:127.0.0.1:{t['qmp_port']},server,nowait",
        "-serial", f"file:{LAB / name / 'serial.log'}",
    ]
    log = open(LAB / name / "qemu.log", "w")
    return subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT)


def lan_address(name: str, timeout: int = 120) -> str:
    """
    L'adresse que le DHCP du réseau local a donnée à la VM.

    Retrouvée par la MAC, qui est fixe : c'est la seule chose connue d'avance.
    Un `ping` sur l'adresse de diffusion peuple la table de voisinage de l'hôte
    quand la VM n'a pas encore parlé la première — sans cela, une machine qui
    vient de démarrer et n'a rien émis reste invisible.
    """
    mac = TARGETS[name]["mac"].lower()
    deadline = time.time() + timeout

    while time.time() < deadline:
        run(["ping", "-c", "1", "-b", "-W", "1", "255.255.255.255"])
        neigh = run(["ip", "-4", "neigh", "show"]).stdout
        for line in neigh.splitlines():
            if mac in line.lower():
                return line.split()[0]
        time.sleep(5)
    return ""


def wait_port(port: int, timeout: int) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as s:
            s.settimeout(2)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(3)
    return False


SSH_BASE = [
    "ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10",
    "-i", str(LAB / "id_lab"),
]


def ssh(name: str, command: str, tty: bool = False, timeout: int = 900):
    t = TARGETS[name]
    args = SSH_BASE + (["-tt"] if tty else []) + ["-p", str(t["ssh_port"]), f"{VM_USER}@127.0.0.1", command]
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def scp(name: str, local: Path, remote: str):
    t = TARGETS[name]
    args = ["scp", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
            "-o", "LogLevel=ERROR", "-i", str(LAB / "id_lab"), "-P", str(t["ssh_port"]),
            str(local), f"{VM_USER}@127.0.0.1:{remote}"]
    return subprocess.run(args, capture_output=True, text=True, timeout=300)


def screenshot(name: str, label: str):
    """
    Une capture de la console, par QMP.

    QEMU écrit du PPM ; converti en PNG parce qu'une trace que personne ne peut
    ouvrir n'est pas une trace.
    """
    t = TARGETS[name]
    out = TRACE / name / "screenshots"
    out.mkdir(parents=True, exist_ok=True)
    ppm = LAB / name / "shot.ppm"

    try:
        with socket.create_connection(("127.0.0.1", t["qmp_port"]), timeout=10) as s:
            f = s.makefile("rw")
            f.readline()
            f.write(json.dumps({"execute": "qmp_capabilities"}) + "\n")
            f.flush()
            f.readline()
            f.write(json.dumps({"execute": "screendump", "arguments": {"filename": str(ppm)}}) + "\n")
            f.flush()
            f.readline()
    except OSError as e:
        return f"screenshot {label}: {e}"

    time.sleep(1)
    png = out / f"{label}.png"
    r = run(["magick", str(ppm), str(png)])
    return None if r.returncode == 0 else f"convert {label}: {r.stderr[-300:]}"


if __name__ == "__main__":
    print("Ce fichier est une bibliothèque ; voir run.py.", file=sys.stderr)
