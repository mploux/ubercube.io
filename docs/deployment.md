# Déployer UBERCUBE

**Procédure courante : [publication et rollback](releasing.md).** Cette page conserve l'installation, les explications d'hébergement et l'historique des publications. Les identifiants datés ci-dessous ne doivent pas être copiés dans une nouvelle release : utiliser `ops/production.json`, vérifier l'état distant et préparer une nouvelle release avec `scripts/release/`.

Le client statique peut être servi par Vercel et permet de jouer seul sans hébergement supplémentaire. Pour le multijoueur, la simulation reste dans un processus Bun permanent, sur une seule instance pour la première version. Le serveur conserve le monde en mémoire : son redémarrage termine les sessions et réinitialise le terrain. Les connexions et instances temporaires des Vercel Functions ne conviennent pas au monde partagé actuel.

## Publication des impacts sur cadavres ×4 — 20 septembre 2026

Le client issu du commit `d263001834db692f48a17181cce7b9f9ed12a78b`, poussé sur `main`, est publié par l'intégration Git Vercel : `dpl_wAyRUfhz8UQWQn7AnJ4LSYADZBbz`. Les trois domaines `www.ubercube.io`, `ubercube.io` et `ubercube-io.vercel.app` servent ce commit ; 51 ressources publiques correspondent au build figé de la release `20260920-224939`, vérifiées à 20:51 UTC. Ce changement ajoute les réactions aux tirs AK/AWP sur les cadavres, impulsions 48/80 choisies par Marc, avec sang au point touché.

La publication contient uniquement les cinq fichiers client nécessaires. Le portage conserve les types du protocole 3 ; les évolutions réseau stable-100 restent sur `work/stable-100-corpse-impacts`. Les treize fichiers serveur/partagés actifs correspondent aux empreintes figées, sans redémarrage du service : PID 79486, démarré le 15 septembre à 15:11:32 UTC, release serveur `20260915-170315` conservée.

Validation : TypeScript, 361 tests / 14 902 assertions, build de 11 sorties, contrôle GPU ×4 et sang réussis. Le smoke Internet vérifie deux identités, monde commun, apparitions autoritaires, commandes acquittées, visée/annulation, départ, protocole et CORS. Le navigateur public passe pseudo → lobby → Assault → jeu → déconnexion, avec arme, terrain et HUD visibles et sans erreur console. Retour à zéro joueur confirmé. La capture de souris est refusée par le navigateur intégré : la prise en main libre n'est pas qualifiée par ce parcours.

Preuves locales dans `.runtime/corpse-x4-release/.runtime/releases/20260920-224939/` depuis le dépôt principal : `release.json`, `changes.json`, `verification.json`, `smoke.json`, `server-verification.txt` et `server-after.txt`. Le commit documentaire de ces preuves peut déclencher un second build identique ; son SHA et ses ressources sont contrôlés séparément après le push.

## Serveur de partie

Installer les dépendances puis lancer `bun run start`, ou construire le `Dockerfile` fourni. L'image ne contient que le serveur et le code partagé ; elle ne sert pas l'interface du jeu. Exposer le port 3000 derrière un proxy HTTPS qui transmet les connexions WebSocket `/ws`. Conserver l'en-tête `Host` public. Exécuter une seule instance avec redémarrage automatique.

Variables du processus serveur, en remplaçant les domaines d'exemple :

```dotenv
MODE=tdm
HOST=0.0.0.0
PORT=3000
MAX_PLAYERS=100
ALLOWED_ORIGINS=https://ubercube.example,https://ubercube-project.vercel.app
```

`MODE=ffa` lance une partie chacun pour soi. Les autres réglages figurent dans `.env.example`. `ALLOWED_ORIGINS` contient des origines HTTP(S) exactes, sans chemin, identifiants ou joker. Les accès du même hôte et les clients non navigateur sans en-tête `Origin` restent compatibles. Ajouter explicitement chaque domaine de prévisualisation autorisé ; tous les sites `*.vercel.app` ne doivent pas pouvoir se connecter par défaut.

Le serveur doit répondre sur `https://game.example/health` et `https://game.example/api/status`, et accepter les WebSockets à `wss://game.example/ws`.

## Client Vercel

`vercel.json` configure le projet statique : installation `bun install --frozen-lockfile`, compilation `bun run build`, résultat `dist/client`.

Définir cette variable dans l'environnement Production du projet Vercel pour permettre aux joueurs de rejoindre le serveur :

```dotenv
PUBLIC_GAME_SERVER_URL=https://game.example
```

Cette adresse publique est intégrée au client lors de la compilation ; elle ne contient aucun secret. Une modification nécessite un nouveau build. Le client l'utilise à la fois pour l'état du serveur et la connexion WebSocket. Si elle manque sur Vercel, le build réussit et le bouton « Play solo » permet de jouer dans le navigateur. Aucune requête HTTP ou WebSocket de jeu n'est alors envoyée. Une adresse fournie invalide ou sans HTTPS fait toujours échouer le build.

Si le serveur configuré est inaccessible, le client propose également le solo ; un échec de connexion initial lance une partie solo automatiquement. Le mode solo exécute la même simulation dans un Web Worker, avec un seul joueur, sans bots ni sauvegarde. Quitter puis relancer crée un nouveau monde. Masquer l'onglet suspend la simulation solo. Une partie solo ne devient pas multijoueur lorsque le serveur revient : retourner à l'accueil pour le rejoindre.

En local, laisser la variable vide conserve `localhost:3000`. `.vercelignore` exclut les fichiers d'environnement et les données locales du transfert. Une publication depuis les fichiers locaux n'exige pas de modification du dépôt Git.

## Vérification après publication

Sans serveur configuré, vérifier pseudo → équipement → partie solo, puis les mouvements, tirs, grenades et modifications du terrain. Quitter et relancer doit réinitialiser le terrain. Avec un serveur multijoueur configuré, ouvrir le domaine de production dans deux navigateurs et rejoindre la même partie ; rejoindre après une destruction, puis vérifier une nouvelle manche. Contrôler HTTPS/WSS et l'absence d'erreur CORS. La page de production ne doit pas dépendre du serveur de développement du PC.

Le projet [ubercube-io](https://vercel.com/marcandr-plouxs-projects/ubercube-io) est relié à `mploux/ubercube.io` : un push sur `main` déclenche le déploiement du client en production. Le serveur Hetzner est publié séparément ; ce push ne met pas à jour sa simulation.

## Installation Hetzner du 12 septembre 2026

Hôte `2.29.30.129`, Debian 13, deux vCPU AMD EPYC et environ 4 Gio de RAM. Le serveur utilise Bun 1.3.11 installé dans `/usr/local/bin/bun`, avec les sources `src/server` et `src/shared` dans `/opt/ubercube`. Ces sources n'importent aucune dépendance tierce ; aucun build client ni installation npm n'est nécessaire sur cet hôte. Docker n'est pas utilisé.

Le service `ubercube` fonctionne sous un compte système sans connexion interactive. Les sources appartiennent à root et le service ne peut pas les modifier. `systemd` le lance au démarrage et le relance après un échec. La configuration se trouve dans `/etc/ubercube.env` : TDM, 100 places, carte 256 × 64 × 256, seed 12345, sans fin de manche automatique. `HOST=127.0.0.1` réserve le port 3000 au proxy local.

[Caddy](https://caddyserver.com/docs/running), installé depuis son dépôt officiel, porte HTTPS et WebSocket. Son fichier `/etc/caddy/Caddyfile` contient :

```caddyfile
game.ubercube.io {
    reverse_proxy 127.0.0.1:3000
}
```

Le domaine `game.ubercube.io` possède un enregistrement DNS A vers `2.29.30.129` chez OVH, vérifié le 12 septembre 2026. Les ports publics 80 et 443 sont ouverts et SSH conserve le port 22. HTTPS et WSS ont été validés depuis une autre machine avec vérification normale du certificat. Deux clients ont rejoint la même partie TDM, reçu des équipes opposées et synchronisé leurs déplacements. Les origines autorisées sont `https://www.ubercube.io`, `https://ubercube.io` et `https://ubercube-io.vercel.app` ; une origine inconnue est refusée en HTTP et WebSocket.

La variable Production Vercel `PUBLIC_GAME_SERVER_URL=https://game.ubercube.io` est configurée. Le déploiement `dpl_9TbinwYJQHn6VUUXL6HSLPUZfZsd`, construit depuis le commit client `3a1d11620e96496a63340b0eef7620b48366b2a6`, est READY et affecté à `www.ubercube.io`. L'adresse du serveur a été vérifiée dans le JavaScript public. L'accueil détecte désormais le serveur et propose « Join game » ; le solo reste disponible si le serveur devient inaccessible. Aucun changement Git n'a été nécessaire pour cette publication.

Commandes d'exploitation, depuis une connexion SSH :

```sh
sudo systemctl status ubercube caddy --no-pager
sudo journalctl -u ubercube -n 100 --no-pager
sudo journalctl -u caddy -n 100 --no-pager
curl -fsS http://127.0.0.1:3000/health
sudoedit /etc/ubercube.env
sudo systemctl restart ubercube
```

Pour changer de mode, régler `MODE=ffa` ou `MODE=tdm`, puis redémarrer le service. Chaque redémarrage déconnecte les joueurs et réinitialise le monde. Pour une mise à jour, sauvegarder les sources actuelles, transférer les nouvelles sources serveur et partagées validées, conserver la configuration système, puis redémarrer et vérifier `/health` ainsi qu'une connexion WSS. Un changement de protocole exige une publication coordonnée du client et du serveur.

## Publication des corrections réseau et personnages — 12 septembre 2026

Le serveur Hetzner a été mis à jour à 09:47:21 UTC avec les sources serveur/partagées locales validées. 84 tests passent directement sur Linux (565 assertions). L'archive transférée a été contrôlée par SHA256, ainsi que les fichiers `game.ts`, `protocol.ts` et `wire.ts` après activation. L'ancienne source reste disponible dans `/opt/ubercube/releases/20260912-before-network-characters/src`. La configuration, Caddy et les origines autorisées sont conservés. Le service est actif ; aucun joueur n'était connecté au redémarrage.

Le client correspondant est publié en production sur [www.ubercube.io](https://www.ubercube.io), déploiement Vercel `dpl_ALaZHSS76TZsitQMbcSHWAVT994Y`, état READY. Cette publication utilise directement les fichiers locaux, sans commande ni push Git. Le dépôt distant n'est donc pas synchronisé par cette opération. La variable `PUBLIC_GAME_SERVER_URL` conserve `https://game.ubercube.io`.

HTTPS/WSS ont été vérifiés avec deux clients, dont la nouvelle visée autoritaire et son annulation visibles par l'autre joueur. Le navigateur public a traversé pseudo → lobby → apparition Assault, avec le compteur Hetzner passant de zéro à un puis revenant à zéro après déconnexion. Les mesures après publication sont consignées dans la [validation](validation.md).

## Publication SEO — 12 septembre 2026

La production Vercel utilise ensuite `dpl_EUvDHNgWmGJnSeFcaEuvLAvX1ok3` (READY), publié depuis les fichiers locaux avec uniquement les cinq changements SEO validés. Canonique, métadonnées, JSON-LD, robots, sitemap et visuel historique ont été contrôlés sur `www.ubercube.io`. Le serveur Hetzner et son adresse intégrée sont conservés. Aucun Git n'a été utilisé. Détails : [référencement et partage](seo.md).

## Publication des contrôles à deux pouces — 12 septembre 2026

La production utilise désormais `dpl_2Aq9bVu484565wgzu66H1J2YANAy`, READY, sur `www.ubercube.io`. Les quatre changements validés sont `src/client/touch-controls.ts`, `src/client/main.ts`, `src/client/styles.css` et `public/index.html`, comparés par empreinte au déploiement favicon `dpl_9hxuDs5v4KyzwypgEnX5PiPh5yRB`. Les 76 autres fichiers sources sont identiques. HTML, CSS et JavaScript répondent en HTTP 200 ; la reconnaissance du double appui, la visée basculée et les indications tactiles sont présentes dans les fichiers publics.

Le serveur Hetzner et le protocole sont inchangés ; l'adresse de connexion conserve `https://game.ubercube.io`. Le favicon historique est conservé. La publication utilise les sources locales sans commande Git : le dépôt distant n'est pas synchronisé par cette opération. Validation et limites : [contrôles à deux pouces](mobile-controls.md). Preuves locales : `.runtime/vercel-two-thumb-release/verification.json`.

## Publication de l'arc compact — 13 septembre 2026

La production utilise `dpl_8k4QegiHN6uu4qK2CpEarzoqKwCE`, READY, sur `www.ubercube.io` et `ubercube.io`. Les trois fichiers validés `public/index.html`, `src/client/main.ts` et `src/client/styles.css` ont été transférés ; les empreintes des 77 autres fichiers sont identiques au déploiement précédent. HTML, CSS et JavaScript publics répondent en HTTP 200 et correspondent exactement au HTML figé et au build avec les paramètres Production. L'arc, les trois pictogrammes, les libellés et le correctif de ciblage tactile sont présents.

L'adresse de jeu reste `https://game.ubercube.io` ; `/health` répond en HTTP 200. Aucun Git ni changement serveur Hetzner. Preuves : `.runtime/vercel-arc-release/verification.json`, `source-diff.json` et `manifest.json`. Validation tactile : [contrôles mobiles](mobile-controls.md).

## Volume initial à 2 % — 13 septembre 2026

Le volume par défaut passe de 100 % à 2 %, soit un gain initial divisé par 50. Les préférences déjà enregistrées sont conservées. TypeScript et le build passent. Le déploiement Vercel `dpl_4124HE9PczBWRKAbfCdjNqtyrjHE` est READY sur `www.ubercube.io` et `ubercube.io` : HTML et JavaScript publics vérifiés en HTTP 200, identiques aux fichiers validés, avec la valeur initiale et l'affichage à 2 %. Seuls `public/index.html` et `src/client/main.ts` ont changé ; les 78 autres fichiers sont identiques à la version arc compact. Aucun Git ni changement Hetzner. Preuves : `.runtime/vercel-audio-release/verification.json` et `manifest.json`.

## Correction : gain global divisé par 50 — 13 septembre 2026

Marc a précisé que la réduction devait s'appliquer au gain global, pas au pourcentage initial. Le changement précédent est remplacé : le curseur démarre à 100 % et `GameAudio` divise le gain de chaque son par 50. Le nouveau 100 % correspond donc à l'ancien 2 %. Les préférences enregistrées restent applicables ; un joueur ayant conservé 2 % peut remettre le curseur à 100 %.

TypeScript et le build passent. Vercel `dpl_H7mp85cQK1twGmABen8UgjfifE3Z` est READY sur les domaines de production. HTML et JavaScript publics répondent en HTTP 200 et correspondent exactement aux fichiers validés, avec le réglage initial à 100 % et le gain global `/ 50` présents. Seuls `public/index.html`, `src/client/main.ts` et `src/client/presentation.ts` ont changé ; les 77 autres fichiers sont identiques. Aucun Git ni changement Hetzner. Preuves : `.runtime/vercel-audio-gain-release/verification.json` et `manifest.json`.

## Publication du terrain Java et des bâtiments — 13 septembre 2026

Le serveur Hetzner a été activé à **16:32:58 UTC**, après validation des archives et des empreintes des 13 fichiers serveur/partagés. Les 112 tests sélectionnés passent sur Linux (2 949 assertions) ; la génération de 24 472 voxels échantillonnés est identique aux navigateurs et à Bun local. L'ancienne source est conservée dans `/opt/ubercube/releases/20260913-before-terrain/src`, avec la nouvelle version dans `/opt/ubercube/releases/20260913-terrain`. Aucun joueur n'était connecté ; la configuration, Caddy et les origines autorisées sont conservés.

Vercel **`dpl_46LahA4vFkaZ7uDxNmpqezN2KzM7`**, READY, a d'abord été construit sans changer les domaines, puis promu après activation du serveur. Les domaines `www.ubercube.io`, `ubercube.io` et `ubercube-io.vercel.app` ciblent cette version. Le manifeste contient 84 fichiers : trois fichiers partagés modifiés (`game.ts`, `protocol.ts`, `voxel.ts`) et quatre ajoutés (`terrain-generation.ts`, `vegetation.ts`, `buildings.ts`, `ruin-model.ts`), les 77 autres étant identiques à la publication du gain audio. L'adresse de jeu reste `https://game.ubercube.io`. Aucun Git n'a été utilisé ; cette publication ne synchronise pas le dépôt distant.

Le protocole 2 est actif des deux côtés. Une page restée ouverte sur l'ancienne version doit être rechargée. HTTPS/CORS, deux joueurs WSS dans le même monde avec équipes opposées, déplacement et visée sont vérifiés en production. Un client de protocole 1 est refusé avant `welcome` ou transfert du monde. Les connexions de test sont fermées. Preuves serveur et réseau : `.runtime/terrain-release/` ; manifeste et preuves Vercel : `.runtime/vercel-terrain-release/`.

La promotion Vercel a été acceptée à **16:33:43 UTC**. Les 50 fichiers exécutés ou publics contrôlés correspondent exactement au build local, notamment les workers de terrain et de solo ; seuls les source maps, non nécessaires au jeu et répondant HTTP 403, sont exclus. Le vrai site public a ensuite été rejoint dans Edge, en format tactile 844 × 390 : pseudo → lobby → Assault, connexion au serveur multijoueur, relief enneigé, arme, HUD et minicarte visibles. 52 snapshots et 119 intentions ont été observés, sans erreur JavaScript/WebGL/serveur ni requête échouée. Le joueur de test a quitté via l'interface et le navigateur dédié a été fermé. Ce contrôle ne remplace pas un téléphone physique. Captures et rapport : `.runtime/terrain-release/browser/`.

## Retour aux publications Git — 13 septembre 2026

Les travaux locaux ont été intégrés en six commits ciblés, puis poussés sur `main`, sans réécrire les quatre commits déjà publiés. Le déploiement Git automatique Vercel `dpl_9aqGDxktthNXy15yjDjnRLxMbzpo` est READY sur les trois domaines de production. Son `gitSource.sha` et le commit poussé correspondent à `c5d0b3a917c854c41330317ecdc30f9a3d29c2e2`. Vérification datée : `2026-09-13T17:52:20.759Z`.

Les 50 ressources publiques passent la comparaison avec le snapshot de ce commit : 49 sont identiques octet par octet ; seul le `debugId` final de source map de `main.js` diffère. Le code exécuté et le lien de source map sont identiques. Les logs Vercel indiquent Bun 1.3.14, contre 1.3.11 pour la référence locale. Le vérificateur conserve les deux empreintes brutes et tolère uniquement cette valeur de métadonnée terminale, avec un test qui refuse toute différence de code, d'URL, d'asset ou d'octets hors de cette valeur.

Le smoke Internet à deux joueurs passe : HTTPS/CORS, refus de l'ancien protocole, identités distinctes, monde partagé, équipes, commandes acquittées, visée et déconnexion. L'accueil public affiche le formulaire et la population ; aucun nouvel essai de maniement ou de rendu complet n'est revendiqué pour ce nettoyage Git. Hetzner n'a pas été redémarré : ses 13 fichiers enregistrés correspondent au code committé après normalisation LF, sans changement de comportement. Ses empreintes brutes et sa release `20260913-terrain` restent conservées.

Les preuves sont dans `.runtime/releases/20260913-194417/verification.json` et `smoke.json`. Les manifests client et serveur dans `ops/` décrivent ce constat daté. Le commit suivant de correctif du vérificateur et de documentation ne change aucun fichier entrant dans le build client ; son push peut néanmoins produire un nouvel ID Vercel, à contrôler par son propre SHA. Les preuves de ce dernier contrôle restent dans son dossier de release, sans créer une boucle de commits documentaires à chaque nouveau build.

## Accès serveur des nouvelles sessions — 15 septembre 2026

Le refus SSH des autres agents venait de l'absence de clé autorisée : les premières publications utilisaient un mot de passe interactif. Le poste Windows de Marc dispose maintenant du profil OpenSSH `ubercube-prod` (également applicable à `codex@2.29.30.129`), avec une clé dédiée dans son profil utilisateur, hors dépôt. Empreinte publique : `SHA256:rI3H1dMWRqazBuITST66Qwqepx0rJO24mYQ4YdqSBio`. L'entrée serveur utilise `restrict` et n'autorise pas de terminal ou de forwarding. Les autres clés et comptes sont conservés.

Le script revu est installé root:root, mode 755, dans `/usr/local/libexec/ubercube-release`. La règle `/etc/sudoers.d/ubercube-release`, root:root, mode 440, autorise `codex` à exécuter uniquement ce script sans mot de passe. `visudo` valide la configuration. L'accès administratif général conserve son mot de passe : `sudo -n /bin/true` est refusé depuis une connexion indépendante. Le script installé correspond à `scripts/release/server.sh`, SHA256 `aaadb27a198c4ffa84fb0ccd8f1a5d161f7fd9c7c559662ca55037ada6c91b65`.

Un second agent a exécuté `bun run doctor --server` dans sa propre session : `readyToDeployServer: true`, sans saisie ni accès au mot de passe. Le contrôle confirme la clé, le sudo limité, le service actif sous l'UID non root 987 et l'empreinte du script installé. L'exécution réseau/sous-processus hors bac à sable reste nécessaire lorsqu'elle est bloquée ; elle ne doit pas être confondue avec un refus d'authentification SSH. La copie SCP a également été vérifiée.

Aucune activation de release, publication Vercel ou réinitialisation de partie : le service conserve son PID 47076 et son démarrage du 13 septembre à 16:32:57 UTC. Les empreintes applicatives de `ops/` sont inchangées. Les nouvelles fonctionnalités locales restent à publier par une opération distincte. La procédure courante est dans [releasing.md](releasing.md#cibles-et-accès) ; une autre machine ou un autre compte OS nécessite sa propre clé autorisée.

## Publication du hitscan et des ragdolls — 15 septembre 2026

AK-47 et AWP utilisent désormais le raycast autoritaire instantané ; les traces sont cosmétiques et les grenades restent physiques. Les ragdolls reçoivent le point et la direction de l'impact fatal. Le protocole 3 est actif côté serveur et client ; le format binaire des snapshots reste en version 1. Les pages ouvertes avant la bascule doivent être rechargées.

Le commit applicatif `35f4830848dce771b485939db58142fc07aefa99`, puis le correctif d'accès `d7266822b0c5052e94492eb864d3032819a4af76`, ont été poussés sur `release/hitscan-20260915`, puis sur `main` sans réécriture. La release figée `.runtime/releases/20260915-091500/` provient de ce dernier SHA. Les 348 tests locaux, le build et le banc shell WSL passent ; les 126 tests Linux de l'archive serveur passent également, avec 3 026 assertions.

Après préparation des deux côtés, `/usr/local/libexec/ubercube-release` a activé le serveur via le sudo limité. Les 13 empreintes actives correspondent au snapshot ; les sources précédentes sont dans `/opt/ubercube/releases/20260915-091500/previous-src`. Le changement d'empreinte de `ruin-model.ts` est seulement sa normalisation CRLF → LF. Aucun réglage système n'a changé et aucune charge n'a été lancée sur la production.

Vercel a d'abord promu `dpl_Go9EZFPQTkmgkFgiccCyJHFFcrkU`, puis le push sur `main` a créé `dpl_9nAEDwi3kuwXwAsgWB1MYQkFZjmP`. Les deux builds déclarent le SHA GitHub `d7266822b0c5052e94492eb864d3032819a4af76`. À 07:37 UTC, les trois domaines publics ciblent le second : **51 ressources publiques vérifiées** contre le snapshot, avec uniquement la tolérance déjà documentée du commentaire final `debugId`. Les logs du build indiquent Bun 1.3.14, contre 1.3.11 pour la comparaison locale.

Le smoke Internet à deux joueurs passe avec le protocole 3 : HTTP/CORS, ancien protocole refusé, monde/manche partagés, équipes distinctes, apparition, commandes acquittées, visée et départ observé. Le navigateur public passe pseudo → lobby → Assault → partie → déconnexion ; terrain, arme, HUD et minicarte sont visibles, sans erreur ni avertissement console. La capture souris est refusée par le navigateur intégré : ce parcours ne valide pas le maniement interactif des tirs. Les tests GPU et de charge locaux du 14 septembre restent les preuves détaillées du changement. Les joueurs temporaires sont déconnectés, retour à zéro joueur.

Les preuves sont `verification-promoted.json`, `verification.json`, `smoke.json`, `server-stage.log` et `server-activate.log` dans le dossier de release. Les manifests de `ops/` décrivent cette publication vérifiée. Le commit suivant ne contient que documentation et preuves ; son push peut créer un autre build du même contenu applicatif, dont la vérification sera conservée dans son propre dossier de release sans boucle de commits documentaires.

## Impulsions ragdoll ×4 — 15 septembre 2026

Après comparaison vidéo ×1/×2/×4/×8, Marc a choisi ×4 pour les deux armes : AK 48, AWP 80. Le point et la direction de l'impact restent identiques, ainsi que les dégâts, grenades, pelle et paramètres physiques du cadavre. Le seul fichier applicatif modifié est `src/shared/game.ts`, partagé avec le solo. Le protocole reste 3.

Le commit `75845992deb283c90175f98ac42aefdb8cffd261`, précédé du banc vidéo `505e059`, est poussé sur `main`. Vercel `dpl_HWm4XT3h9v7sKyfUvNEpkeJbKjFu` sert ce SHA sur les trois domaines, avec 51 ressources vérifiées à 15:12 UTC. Hetzner utilise la release `20260915-170315` : les 13 empreintes actives passent et la version précédente est conservée dans `previous-src`. Aucun joueur n'était connecté lors de l'activation.

TypeScript, 350 tests locaux et le build passent ; 133 tests Linux passent avant activation, dont les événements de mort avec impulsions 48/80. Le smoke Internet à deux joueurs et le parcours navigateur accueil → lobby → Assault → partie → déconnexion passent. La console est sans erreur ni avertissement ; la capture souris reste refusée par le navigateur intégré. La validation visuelle du facteur retenu provient de la vidéo locale approuvée par Marc. Aucune charge n'a été lancée en production. Preuves dans `.runtime/releases/20260915-170315/` ; un éventuel build du commit documentaire suivant est vérifié séparément, sans changer les sources applicatives.
