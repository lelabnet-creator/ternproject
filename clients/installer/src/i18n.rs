//! The two message catalogs, side by side.
//!
//! English is the default, French takes over when the system says so. That
//! default is not politeness: this installer lands on a rented server abroad at
//! least as often as on a desk machine, the locale is the only clue we have
//! about who is going to read the screen, and English is the one with the best
//! odds of being understood by whoever is in front of it.
//!
//! `TERN_LANG` wins over everything — for tests, and for the person whose
//! server is in English but who is not. Otherwise `LC_ALL`, then `LC_MESSAGES`,
//! then `LANG`: that is the priority POSIX gives those variables, and the first
//! non-empty one decides.
//!
//! One struct with two constant instances rather than a `match` on a key, which
//! is what the shell had to do. A hundred-branch `case` reads badly and gets
//! completed worse: the French and the English wording of the same message end
//! up fifty lines apart. Side by side in the same order, a key missing from one
//! of them is a compile error rather than an empty string at run time — the one
//! guarantee the shell version could never have.

/// Which of the two catalogs is in use.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    En,
    Fr,
}

impl Lang {
    /// The catalog that goes with this language.
    pub fn catalog(self) -> &'static Catalog {
        match self {
            Lang::En => &EN,
            Lang::Fr => &FR,
        }
    }
}

/// Reads the language out of the environment.
///
/// The reader is a parameter rather than a direct `std::env::var` so the rule
/// can be exercised without touching the process environment, which is global
/// and shared by every test running in parallel.
pub fn detect(read: impl Fn(&str) -> Option<String>) -> Lang {
    let picked = ["TERN_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|name| read(name))
        .find(|value| !value.is_empty());

    match picked {
        // `fr`, `FR`, `fr_FR.UTF-8` and `fr_CA` all mean the same thing here,
        // so it is a prefix test and not an equality.
        Some(value) if value.to_ascii_lowercase().starts_with("fr") => Lang::Fr,
        _ => Lang::En,
    }
}

/// The language of this process.
pub fn detect_from_env() -> Lang {
    detect(|name| std::env::var(name).ok())
}

/// Substitutes `{}` placeholders, left to right.
///
/// `format!` needs a literal, and these strings are data. The shell had to cut
/// every message carrying a value into `_PRE` and `_POST` halves and glue them
/// back together at the call site; a placeholder keeps the sentence in one
/// piece, which matters when the two languages do not put the value in the same
/// spot. A missing argument leaves its `{}` visible rather than panicking:
/// a clumsy message beats an installer that dies while reporting something.
pub fn fill(template: &str, args: &[&str]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    let mut args = args.iter();

    while let Some(at) = rest.find("{}") {
        let Some(arg) = args.next() else { break };
        out.push_str(&rest[..at]);
        out.push_str(arg);
        rest = &rest[at + 2..];
    }
    out.push_str(rest);
    out
}

/// Every string this installer can put on the screen or in `.env`.
pub struct Catalog {
    pub title: &'static str,
    pub no_tty: &'static str,
    pub docker_docs: &'static str,
    pub then_rerun: &'static str,
    pub journal_hint: &'static str,
    pub journal_hint_fail: &'static str,

    /// The two answers to every yes/no question. cliclack writes them itself,
    /// in English; the theme takes them from here instead.
    pub yes: &'static str,
    pub no: &'static str,

    pub docker_required: &'static str,
    pub docker_macos: &'static str,
    pub docker_os_unknown: &'static str,
    pub docker_no_pkgmgr: &'static str,
    pub docker_no_root: &'static str,
    pub docker_missing: &'static str,
    pub pkgmgr_detected: &'static str,
    pub pkg_from_distro: &'static str,
    pub sudo_heads_up: &'static str,
    pub docker_install_q: &'static str,
    pub docker_declined: &'static str,
    pub apt_update_failed: &'static str,
    pub docker_no_pkg: &'static str,
    pub docker_no_pkg_2: &'static str,
    pub pkg_failed: &'static str,
    pub service_failed: &'static str,
    pub service_hint: &'static str,
    pub no_systemd: &'static str,
    pub compose_missing: &'static str,
    pub compose_expected: &'static str,
    pub hint_compose_apt: &'static str,
    pub hint_compose_dnf: &'static str,
    pub hint_compose_pacman: &'static str,
    pub docker_ready: &'static str,
    pub compose_required: &'static str,
    pub daemon_no_access: &'static str,
    pub daemon_down: &'static str,

    pub sock_title: &'static str,
    pub sock_1: &'static str,
    pub sock_2: &'static str,
    pub sock_add_q: &'static str,
    pub sock_no_access: &'static str,
    pub sock_manual: &'static str,
    pub sock_usermod_failed: &'static str,
    pub sock_added: &'static str,
    pub sock_reexec: &'static str,
    pub sock_just_added: &'static str,
    pub sock_relogin: &'static str,

    pub step_apt_update: &'static str,
    pub step_install_engine: &'static str,
    pub step_install_compose: &'static str,
    pub step_enable_service: &'static str,
    pub step_join_group: &'static str,
    pub step_fetch_compose: &'static str,
    pub step_write_config: &'static str,
    pub step_pull: &'static str,
    pub step_build: &'static str,
    pub step_start: &'static str,
    pub step_wait_api: &'static str,
    pub step_check_volume: &'static str,
    pub note_already: &'static str,
    /// The row at the foot of the checklist: `Step 4 of 9`.
    pub step_counter: &'static str,

    pub head_docker: &'static str,
    pub head_install: &'static str,
    pub curl_required: &'static str,
    pub download_failed: &'static str,

    pub head_access: &'static str,
    /// The default on offer, shown in the field itself. cliclack appends its
    /// own English `(default)` when it builds this hint; spelling it out here
    /// is what keeps a French install from answering in English.
    pub default_hint: &'static str,
    pub q_port: &'static str,
    pub bad_port: &'static str,
    pub q_public_url: &'static str,
    pub localhost_warn: &'static str,
    pub proxy_hint: &'static str,
    pub q_trusted_proxies: &'static str,
    /// What the empty answer means, said out loud. There is no sensible value
    /// to propose here, and a blank line where a default belongs reads as a
    /// question with no way out.
    pub q_proxies_none: &'static str,

    pub head_agent: &'static str,
    pub agent_intro: &'static str,
    pub agent_q: &'static str,
    pub agent_host: &'static str,
    pub agent_host_warn: &'static str,
    pub agent_container: &'static str,

    pub env_written: &'static str,
    pub secret_new: &'static str,
    pub env_head: &'static str,
    pub env_db: &'static str,
    pub env_secret: &'static str,
    pub env_access: &'static str,
    pub env_agent: &'static str,
    pub env_product: &'static str,
    pub env_carried: &'static str,

    pub legacy_1: &'static str,
    pub legacy_2: &'static str,
    pub legacy_3: &'static str,
    pub legacy_4: &'static str,
    pub legacy_5: &'static str,
    pub dump_file: &'static str,

    pub no_sources: &'static str,
    pub build_hint: &'static str,
    pub image_not_found: &'static str,
    pub build_failed: &'static str,
    pub start_failed: &'static str,
    pub logs_hint: &'static str,
    pub api_timeout: &'static str,
    pub api_migrating: &'static str,
    pub no_volume: &'static str,
    pub volume_ok: &'static str,

    pub done_panel_title: &'static str,
    /// What is true of this machine now that the run is over — not a repeat of
    /// the checklist, which has just been read.
    pub done_state: &'static str,
    pub done_admin: &'static str,
    pub done_public: &'static str,
    pub done_body: &'static str,
    /// The one thing on that screen that cannot wait until tomorrow.
    pub done_first_admin: &'static str,
    pub stop_label: &'static str,
    pub logs_label: &'static str,
    pub outro_ready: &'static str,
}

// ── english ──────────────────────────────────────────────────────────────────
pub static EN: Catalog = Catalog {
    title: "TERN — setting up an instance",
    no_tty: "This installer is interactive: download it, then run it (no pipe).",
    docker_docs: "Install guide: https://docs.docker.com/engine/install/",
    then_rerun: "Then run this installer again.",
    journal_hint: "Setup log     : {}",
    journal_hint_fail: "The whole run, command by command, is in {}",

    yes: "Yes",
    no: "No",

    docker_required: "Docker is required.",
    docker_macos:
        "On macOS, install Docker Desktop and start it before running this installer again.",
    docker_os_unknown: "This installer does not know how to install Docker on {}.",
    docker_no_pkgmgr: "No package manager known here (apt-get, dnf, yum, pacman).",
    docker_no_root:
        "Installing needs administrator rights, and neither root nor sudo answers here.",
    docker_missing: "Docker is not installed",
    pkgmgr_detected: "Package manager detected: {}",
    pkg_from_distro: "Packages will come from this distribution's repositories.",
    sudo_heads_up: "The install goes through sudo; you may be asked for a password.",
    docker_install_q: "Install Docker now?",
    docker_declined: "Docker is required, and the install was declined.",
    apt_update_failed: "apt-get update failed.",
    docker_no_pkg: "No Docker package in the repositories configured on this machine.",
    docker_no_pkg_2:
        "That would mean adding the Docker repository, which this installer does not do.",
    pkg_failed: "Installing {} failed.",
    service_failed: "The docker service did not start.",
    service_hint: "Worth a look: systemctl status docker",
    no_systemd: "Non-systemd init: start the Docker daemon yourself before continuing.",
    compose_missing: "Docker is installed, but the Compose v2 plugin is missing.",
    compose_expected: "Expected package on this distribution: {}",
    hint_compose_apt: "docker-compose-v2, or docker-compose-plugin with the Docker repository",
    hint_compose_dnf: "docker-compose-plugin, or docker-compose on Fedora",
    hint_compose_pacman: "docker-compose",
    docker_ready: "Docker is installed",
    compose_required: "Docker Compose v2 is required (docker compose), and Docker must be running.",
    daemon_no_access: "Your account cannot reach the Docker daemon (the daemon itself is running).",
    daemon_down: "The Docker daemon is not answering.",

    sock_title: "Access to the Docker daemon",
    sock_1: "Docker is usable by root and by the \"docker\" group, and by nobody else.",
    sock_2: "Belonging to that group amounts to being an administrator of this machine.",
    sock_add_q: "Add {} to the docker group?",
    sock_no_access: "Docker is installed, but your account cannot reach it.",
    sock_manual: "Without that: sudo usermod -aG docker {}, then open a new session.",
    sock_usermod_failed: "Could not add {} to the docker group.",
    sock_added: "Added. It takes effect at your next login.",
    sock_reexec: "Picking the install back up with the rights just granted…",
    sock_just_added: "Your account has just been added to the docker group.",
    sock_relogin: "Close this session, open a new one, and run this installer again.",

    step_apt_update: "Refreshing the package lists",
    step_install_engine: "Installing Docker ({})",
    step_install_compose: "Installing Docker Compose ({})",
    step_enable_service: "Enabling the Docker service",
    step_join_group: "Adding {} to the docker group",
    step_fetch_compose: "Fetching the compose file",
    step_write_config: "Writing the configuration",
    step_pull: "Pulling the images",
    step_build: "Building the image",
    step_start: "Starting the services",
    step_wait_api: "Waiting for the API",
    step_check_volume: "Checking database storage",
    note_already: "already there",
    step_counter: "Step {} of {}",

    head_docker: "Installing Docker",
    head_install: "Installing TERN",
    curl_required: "curl is required to fetch {}.",
    download_failed: "Download failed: {}",

    head_access: "HTTP access",
    default_hint: "{} (default)",
    q_port: "Port published on the host",
    bad_port: "A port is a number between 1 and 65535.",
    q_public_url: "Public URL (the one a browser uses)",
    localhost_warn: "This address only names this machine from this machine.\n\
         Remote agents, links in outgoing mail and generated install scripts all\n\
         reuse it as it stands. Fix it in .env if anyone else has to reach this\n\
         instance.",
    proxy_hint: "Behind a reverse proxy or a domain name, give the external URL —\n\
         that is the one reused everywhere.",
    q_trusted_proxies: "Trusted proxy CIDRs (empty for direct access)",
    q_proxies_none: "none — this instance is reached directly",

    head_agent: "What the agent should be able to watch",
    agent_intro: "By default it sees the internet and this instance, but neither this\n\
         machine's own services nor the other Docker containers.",
    agent_q: "Watch this machine's own services too?",
    agent_host: "The agent will probe from the machine.",
    agent_host_warn: "{}: Docker Desktop does not give host mode the meaning expected\n\
         here. The setting will be written, but the agent may see neither this\n\
         machine's loopback nor its local network.",
    agent_container: "The agent will probe from its container. Changeable later: the\n\
         Agents screen says what to change.",

    env_written: "{}, mode 600",
    secret_new: "APP_SECRET generated locally, never transmitted",
    env_head: "# Written by the TERN installer — do not commit (.gitignore blocks .env*).",
    env_db: "# ── Database ────────────────────────────────────────────────────────────────",
    env_secret: "# ── Instance secret ─────────────────────────────────────────────────────────\n\
         # Encrypts TOTP secrets, probe authentication headers and subscriber\n\
         # addresses. Changing it makes those values unreadable: back it up with the\n\
         # database, never regenerate it.",
    env_access: "# ── Access ──────────────────────────────────────────────────────────────────",
    env_agent: "# ── What this instance's agent can measure ───────────────────────────────────\n\
         # service:app — it shares the API's network stack. The internet and this\n\
         #               instance's containers; neither the machine's loopback nor the\n\
         #               other Docker networks.\n\
         # host        — it shares the machine's own stack. Its loopback services, its\n\
         #               local network and the other Docker networks become visible.\n\
         #               Linux only.\n\
         #\n\
         # The two lines go together: in host mode the API is only reachable on its\n\
         # published port, and the second one is what tells the agent so.",
    env_product: "# ── The product ─────────────────────────────────────────────────────────────\n\
         # Nothing here, and that is deliberate: the page name, its address, the\n\
         # administrator account and the outgoing mail server are all entered the\n\
         # first time the admin console is opened, by the person sitting in front of\n\
         # it. No password has to travel through this file — a cleartext password\n\
         # left lying about ends up being read.\n\
         #\n\
         # For an instance exposed before anyone opens it, setting TERN_TENANT_SLUG,\n\
         # TERN_TENANT_NAME, TERN_ADMIN_EMAIL and TERN_ADMIN_PASSWORD creates\n\
         # everything at startup and closes that window before the first request is\n\
         # served.",
    env_carried: "# ── Carried over from the previous configuration ─────────────────────────────",

    legacy_1: "This install keeps its database inside the container, not on a volume.",
    legacy_2: "The mount pointed at {}, a path this image does not use.",
    legacy_3: "Correcting it now would hand you an empty database in place of yours.",
    legacy_4: "Back it up first, then run this installer again:",
    legacy_5: "Then restore the dump into the fresh database. See docs/operations.md.",
    dump_file: "tern-before-migration.dump",

    no_sources: "No sources here — published image: {}",
    build_hint: "The first build takes a few minutes. To use a published image instead:\n\
         TERN_IMAGE=… tern-setup",
    image_not_found: "Image not found: {}",
    build_failed: "The build failed.",
    start_failed: "Startup failed.",
    logs_hint: "docker compose -f {} logs app",
    api_timeout: "The API did not answer in time.",
    api_migrating: "The containers may still be running their migrations:",
    no_volume: "The database does not appear to sit on a volume. It works, but one\n\
         `docker compose up -d` would destroy it. Check the `volumes:` block of the\n\
         `db` service in {}.",
    volume_ok: "Database on the db-data volume — it survives a container recreation.",

    done_panel_title: "Installation complete",
    done_state: "TERN is up on this machine: the API, its agent and the database,\n\
         each in its own container, restarted with the machine. The whole\n\
         configuration is in .env, which this installer can replay to change\n\
         any of it.",
    done_admin: "Admin console : {}",
    done_public: "Public page   : {}",
    done_body: "Open the admin console now: the page is named there, the\n\
         administrator account is created there, and the outgoing mail server\n\
         is set up there. The public page stays empty until it is.",
    done_first_admin: "Until that administrator account exists, the first person to open\n\
         the admin address becomes the administrator of this instance.",
    stop_label: "Stop          : docker compose -f {} down",
    logs_label: "Logs          : docker compose -f {} logs -f app",
    outro_ready: "Ready — {}",
};

// ── français ─────────────────────────────────────────────────────────────────
pub static FR: Catalog = Catalog {
    title: "TERN — installation d'une instance",
    no_tty: "Installateur interactif : téléchargez-le puis exécutez-le (pas de pipe).",
    docker_docs: "Installation : https://docs.docker.com/engine/install/",
    then_rerun: "Puis relancez cet installateur.",
    journal_hint: "Rapport        : {}",
    journal_hint_fail: "Toute l'exécution, commande par commande, est dans {}",

    yes: "Oui",
    no: "Non",

    docker_required: "Docker est requis.",
    docker_macos:
        "Sur macOS, installez Docker Desktop et lancez-le avant de relancer cet installateur.",
    docker_os_unknown: "Cet installateur ne sait pas installer Docker sur {}.",
    docker_no_pkgmgr: "Aucun gestionnaire de paquets connu ici (apt-get, dnf, yum, pacman).",
    docker_no_root:
        "L'installation demande les droits d'administration, et ni root ni sudo ne répondent ici.",
    docker_missing: "Docker n'est pas installé",
    pkgmgr_detected: "Gestionnaire de paquets détecté : {}",
    pkg_from_distro: "Les paquets viendront des dépôts de cette distribution.",
    sudo_heads_up: "L'installation passera par sudo ; un mot de passe sera peut-être demandé.",
    docker_install_q: "Installer Docker maintenant ?",
    docker_declined: "Docker est requis, et l'installation a été refusée.",
    apt_update_failed: "apt-get update a échoué.",
    docker_no_pkg: "Aucun paquet Docker dans les dépôts configurés de cette machine.",
    docker_no_pkg_2:
        "Il faudrait y ajouter le dépôt de Docker, ce que cet installateur ne fait pas.",
    pkg_failed: "L'installation de {} a échoué.",
    service_failed: "Le service docker n'a pas démarré.",
    service_hint: "À regarder : systemctl status docker",
    no_systemd: "Init non-systemd : démarrez le démon Docker vous-même avant de continuer.",
    compose_missing: "Docker est installé, mais le plugin Compose v2 manque.",
    compose_expected: "Paquet attendu sur cette distribution : {}",
    hint_compose_apt: "docker-compose-v2, ou docker-compose-plugin avec le dépôt de Docker",
    hint_compose_dnf: "docker-compose-plugin, ou docker-compose sur Fedora",
    hint_compose_pacman: "docker-compose",
    docker_ready: "Docker est installé",
    compose_required: "Docker Compose v2 est requis (docker compose), et Docker doit tourner.",
    daemon_no_access: "Votre compte n'a pas accès au démon Docker (le démon, lui, tourne).",
    daemon_down: "Le démon Docker ne répond pas.",

    sock_title: "Accès au démon Docker",
    sock_1: "Docker n'est utilisable que par root et par le groupe « docker ».",
    sock_2: "Appartenir à ce groupe équivaut à être administrateur de cette machine.",
    sock_add_q: "Ajouter {} au groupe docker ?",
    sock_no_access: "Docker est installé, mais votre compte n'y a pas accès.",
    sock_manual: "Sans cela : sudo usermod -aG docker {}, puis rouvrez votre session.",
    sock_usermod_failed: "Impossible d'ajouter {} au groupe docker.",
    sock_added: "Ajouté. Prend effet à la prochaine ouverture de session.",
    sock_reexec: "Reprise de l'installation avec les droits acquis…",
    sock_just_added: "Votre compte vient d'être ajouté au groupe docker.",
    sock_relogin: "Fermez cette session, rouvrez-en une, et relancez cet installateur.",

    step_apt_update: "Mise à jour des listes de paquets",
    step_install_engine: "Installation de Docker ({})",
    step_install_compose: "Installation de Docker Compose ({})",
    step_enable_service: "Activation du service Docker",
    step_join_group: "Ajout de {} au groupe docker",
    step_fetch_compose: "Récupération du fichier compose",
    step_write_config: "Écriture de la configuration",
    step_pull: "Récupération des images",
    step_build: "Construction de l'image",
    step_start: "Démarrage des services",
    step_wait_api: "Attente de l'API",
    step_check_volume: "Vérification du stockage de la base",
    note_already: "déjà là",
    step_counter: "Étape {} sur {}",

    head_docker: "Installation de Docker",
    head_install: "Installation de TERN",
    curl_required: "curl est requis pour récupérer {}.",
    download_failed: "Téléchargement impossible : {}",

    head_access: "L'accès HTTP",
    default_hint: "{} (par défaut)",
    q_port: "Port publié sur l'hôte",
    bad_port: "Un port est un nombre entre 1 et 65535.",
    q_public_url: "URL publique (celle qu'un navigateur utilise)",
    localhost_warn: "Cette adresse ne désigne cette machine que depuis elle-même.\n\
         Les agents distants, les liens des courriels et les scripts d'installation\n\
         générés la reprendront telle quelle. À corriger dans .env si des tiers\n\
         doivent accéder à cette instance.",
    proxy_hint: "Derrière un reverse proxy ou un nom de domaine, indiquez l'URL externe —\n\
         c'est elle qui sera reprise partout.",
    q_trusted_proxies: "CIDR des proxys de confiance (vide si accès direct)",
    q_proxies_none: "aucun — cette instance est jointe directement",

    head_agent: "Ce que l'agent doit pouvoir surveiller",
    agent_intro: "Par défaut il voit Internet et cette instance, mais pas les services de\n\
         cette machine ni les autres conteneurs Docker.",
    agent_q: "Surveiller aussi les services de cette machine ?",
    agent_host: "L'agent mesurera depuis la machine.",
    agent_host_warn: "{} : Docker Desktop ne donne pas au mode hôte le sens attendu ici.\n\
         Le réglage sera écrit, mais l'agent risque de ne voir ni la loopback de la\n\
         machine ni son réseau local.",
    agent_container: "L'agent mesurera depuis son conteneur. Modifiable plus tard :\n\
         l'écran Agents indique quoi changer.",

    env_written: "{}, mode 600",
    secret_new: "APP_SECRET généré localement, jamais transmis",
    env_head: "# Écrit par l'installateur TERN — ne pas committer (.gitignore bloque .env*).",
    env_db: "# ── Base de données ─────────────────────────────────────────────────────────",
    env_secret: "# ── Secret d'instance ───────────────────────────────────────────────────────\n\
         # Chiffre les secrets TOTP, les en-têtes d'authentification des sondes et les\n\
         # adresses des abonnés. Le changer rend ces valeurs illisibles : à sauvegarder\n\
         # avec la base, jamais à régénérer.",
    env_access: "# ── Accès ───────────────────────────────────────────────────────────────────",
    env_agent: "# ── Ce que l'agent de l'instance peut mesurer ───────────────────────────────\n\
         # service:app — il partage la pile réseau de l'API. Internet et les conteneurs\n\
         #               de cette instance ; ni la loopback de la machine, ni les autres\n\
         #               réseaux Docker.\n\
         # host        — il partage celle de la machine. Ses services en loopback, son\n\
         #               réseau local et les autres réseaux Docker deviennent visibles.\n\
         #               Linux uniquement.\n\
         #\n\
         # Les deux lignes vont ensemble : en mode hôte l'API n'est joignable que par\n\
         # son port publié, et la seconde est ce qui le dit à l'agent.",
    env_product: "# ── Le produit ──────────────────────────────────────────────────────────────\n\
         # Rien ici, et c'est voulu : le nom de la page, son adresse, le compte\n\
         # administrateur et le serveur d'envoi se saisissent au premier chargement de\n\
         # l'administration, par la personne qui est devant. Aucun mot de passe n'a donc\n\
         # à passer par ce fichier — un mot de passe en clair qui traîne finit par être\n\
         # lu.\n\
         #\n\
         # Pour une instance exposée avant que quiconque ne l'ouvre, définir\n\
         # TERN_TENANT_SLUG, TERN_TENANT_NAME, TERN_ADMIN_EMAIL et TERN_ADMIN_PASSWORD\n\
         # crée tout au démarrage et ferme la fenêtre avant la première requête servie.",
    env_carried: "# ── Reporté depuis la configuration précédente ───────────────────────────────",

    legacy_1: "Cette installation stocke sa base dans le conteneur, pas sur un volume.",
    legacy_2: "Le montage visait {}, un chemin que cette image n'utilise pas.",
    legacy_3: "La corriger maintenant présenterait une base vide à la place de la vôtre.",
    legacy_4: "Sauvegardez d'abord, puis relancez cet installateur :",
    legacy_5: "Puis restaurez le dump dans la base neuve. Voir docs/operations.md.",
    dump_file: "tern-avant-migration.dump",

    no_sources: "Pas de sources ici — image publiée : {}",
    build_hint: "La première construction prend quelques minutes. Pour utiliser une image\n\
         publiée : TERN_IMAGE=… tern-setup",
    image_not_found: "Image introuvable : {}",
    build_failed: "La construction a échoué.",
    start_failed: "Le démarrage a échoué.",
    logs_hint: "docker compose -f {} logs app",
    api_timeout: "L'API n'a pas répondu dans le délai.",
    api_migrating: "Les conteneurs tournent peut-être encore leurs migrations :",
    no_volume: "La base ne semble pas reposer sur un volume. Elle fonctionne, mais un\n\
         `docker compose up -d` la détruirait. Vérifiez le bloc `volumes:` du service\n\
         `db` dans {}.",
    volume_ok: "Base sur le volume db-data — elle survit à une recréation du conteneur.",

    done_panel_title: "Installation terminée",
    done_state: "TERN tourne sur cette machine : l'API, son agent et la base, chacun\n\
         dans son conteneur, redémarrés avec la machine. Toute la configuration\n\
         est dans .env, que cet installateur sait rejouer pour en changer\n\
         n'importe quelle valeur.",
    done_admin: "Administration : {}",
    done_public: "Page publique  : {}",
    done_body: "Ouvrez l'administration maintenant : c'est là que la page se nomme,\n\
         que le compte administrateur se crée et que le serveur d'envoi se\n\
         règle. La page publique reste vide tant que ce n'est pas fait.",
    done_first_admin: "Tant que ce compte administrateur n'existe pas, la première personne\n\
         à ouvrir l'adresse d'administration devient l'administrateur de cette\n\
         instance.",
    stop_label: "Arrêt          : docker compose -f {} down",
    logs_label: "Journaux       : docker compose -f {} logs -f app",
    outro_ready: "Prêt — {}",
};

#[cfg(test)]
mod tests {
    use super::*;

    /// A made-up environment, so the rule is exercised without touching the
    /// real one.
    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let owned: Vec<(String, String)> = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        move |name| {
            owned
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        }
    }

    #[test]
    fn english_is_the_default() {
        assert_eq!(detect(env(&[])), Lang::En);
        assert_eq!(detect(env(&[("LANG", "C.UTF-8")])), Lang::En);
        assert_eq!(detect(env(&[("LANG", "de_DE.UTF-8")])), Lang::En);
    }

    #[test]
    fn any_french_locale_shape_is_french() {
        for value in ["fr", "FR", "fr_FR.UTF-8", "fr_CA", "fr_BE@euro"] {
            assert_eq!(detect(env(&[("LANG", value)])), Lang::Fr, "{value}");
        }
    }

    #[test]
    fn tern_lang_wins_over_the_locale() {
        assert_eq!(
            detect(env(&[("TERN_LANG", "fr"), ("LC_ALL", "en_US.UTF-8")])),
            Lang::Fr
        );
        assert_eq!(
            detect(env(&[("TERN_LANG", "en"), ("LC_ALL", "fr_FR.UTF-8")])),
            Lang::En
        );
    }

    #[test]
    fn the_first_non_empty_variable_decides() {
        // LC_ALL outranks LANG, and an empty LC_ALL is not an answer.
        assert_eq!(
            detect(env(&[("LC_ALL", "en_GB"), ("LANG", "fr_FR")])),
            Lang::En
        );
        assert_eq!(
            detect(env(&[("LC_ALL", ""), ("LC_MESSAGES", "fr_FR")])),
            Lang::Fr
        );
    }

    /// A message that carries values has to carry the same number of them in
    /// both languages, or one of the two loses a value on the screen.
    #[test]
    fn both_catalogs_take_the_same_values() {
        for (english, french) in [
            (EN.step_counter, FR.step_counter),
            (EN.done_admin, FR.done_admin),
            (EN.done_public, FR.done_public),
            (EN.stop_label, FR.stop_label),
            (EN.logs_label, FR.logs_label),
            (EN.journal_hint, FR.journal_hint),
        ] {
            assert_eq!(
                english.matches("{}").count(),
                french.matches("{}").count(),
                "{english:?} / {french:?}"
            );
        }
        assert_eq!(EN.step_counter.matches("{}").count(), 2);
    }

    /// The closing panel puts its labels in a column. The padding is part of
    /// the wording, so each language keeps its own, and each has to be even.
    #[test]
    fn the_closing_panel_lines_up_its_labels() {
        for catalog in [&EN, &FR] {
            let widths: Vec<usize> = [
                catalog.done_admin,
                catalog.done_public,
                catalog.stop_label,
                catalog.logs_label,
                catalog.journal_hint,
            ]
            .iter()
            // Counted in characters and not in bytes: `Arrêt` is five columns
            // wide and six bytes long, and it is columns that line up.
            .map(|line| line.chars().take_while(|c| *c != ':').count())
            .collect();

            assert!(
                widths.windows(2).all(|pair| pair[0] == pair[1]),
                "columns do not line up: {widths:?}"
            );
        }
    }

    #[test]
    fn placeholders_are_filled_left_to_right() {
        assert_eq!(
            fill("Adding {} to {}", &["ann", "docker"]),
            "Adding ann to docker"
        );
        assert_eq!(fill("no placeholder", &["ann"]), "no placeholder");
        // A missing argument leaves the placeholder rather than panicking.
        assert_eq!(fill("{} and {}", &["one"]), "one and {}");
    }
}
