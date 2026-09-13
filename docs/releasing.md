# Publier et revenir à la version précédente

Chaque nouvelle publication Vercel doit être construite depuis un **commit poussé sur GitHub**. Le chemin normal est : revue → tests → commits ciblés → push sur `main` → déploiement Git automatique → vérification du SHA servi. Ne pas envoyer des fichiers locaux à Vercel, utiliser `vercel --prod` depuis le dossier de travail, ni fabriquer une attribution Git pour un upload.

Une tâche de code autorise l'inspection Git et les commits locaux nécessaires. Le push, le staging, l'activation, la promotion, le rollback et le smoke distant relèvent d'une demande de publication adaptée. Ne jamais réécrire l'historique publié ou pousser en force sans demande explicite. Les publications historiques réalisées par upload restent documentées comme telles dans [deployment.md](deployment.md).

## Cibles et accès

Les cibles publiques sont dans [ops/production.json](../ops/production.json) : client Vercel `ubercube-io`, serveur `game.ubercube.io`, SSH `codex@2.29.30.129`, service `ubercube`, sources `/opt/ubercube`. Configuration serveur `/etc/ubercube.env`, proxy `/etc/caddy/Caddyfile`. Les outils ne modifient ni ces configurations, ni les comptes, ni les clés. Bun 1.3.11 est la référence locale de comparaison ; Vercel gère son runtime de build et `packageManager` ne garantit pas à lui seul sa version exacte. Relever la version dans les logs lors d'une divergence, sans relâcher le contrôle du code exécuté.

Prérequis : Bun **1.3.11**, dépendances installées, Git avec un accès autorisé au dépôt GitHub `origin`, OpenSSH (`ssh`, `scp`), `tar`. Le serveur possède déjà Bun, bash, GNU tar/coreutils, curl et systemd. `bun run doctor` contrôle uniquement la présence locale ; il n'accorde aucun accès. Vercel doit rester relié au même dépôt GitHub avec `main` comme branche Production ; vérifier cette liaison avant une première publication depuis une nouvelle session.

**Vercel** : le script lit `VERCEL_TOKEN`, sinon le fichier JSON privé désigné par `VERCEL_AUTH_FILE` (champ `token`), sinon le fichier local historique `.runtime/vercel-cli/auth.json`. Un champ d'environnement vide est considéré absent. Ce fichier existe sur le poste de Marc mais n'est pas livré avec un clone. Sur un nouveau poste, obtenir un accès autorisé au projet via le compte Vercel et fournir le token par un mécanisme privé. [.env.deploy.example](../.env.deploy.example) décrit les noms de variables ; un éventuel `.env.local` avec les vraies valeurs reste ignoré. Ne jamais afficher le token, le placer dans un argument, le copier dans `ops/`, ni l'envoyer au site du jeu. Le script l'envoie uniquement à `https://api.vercel.com`, sans suivre les redirections.

**Hetzner** : utiliser une clé déjà autorisée via OpenSSH/ssh-agent, ou une saisie interactive du mot de passe SSH puis sudo. Le dernier déploiement utilisait une saisie interactive ; une authentification par clé et un sudo sans mot de passe ne sont **pas** garantis sur ce poste. Aucun mot de passe n'est enregistré dans ce guide. Une nouvelle session sans accès ne doit pas chercher dans un ancien chat ni inventer un identifiant : faire provisionner un accès privé par Marc. Lors du premier accès depuis une autre machine, faire vérifier l'empreinte de l'hôte et conserver `known_hosts` ; ne pas désactiver sa vérification.

Si l'environnement bloque `ssh`, `scp` ou la création de sous-processus, employer son mécanisme normal d'approbation. Les droits de la machine ne sont pas définis par `AGENTS.md`. Ne pas affaiblir les contrôles pour faire passer une commande.

## Préparer une version vérifiable

1. Inspecter la branche, `git status --short --branch`, l'historique récent et les différences. Terminer les changements, passer `bun run check` et les contrôles navigateur/réseau pertinents. Relire les fichiers indexés, puis créer des commits ciblés. Ne pas embarquer des travaux étrangers à la tâche ; en dossier partagé, seul le lead intègre et crée les commits.
2. Lire `ops/production.json` et ses deux manifests : `deployed-client.json` décrit les sources du dernier client publié, `deployed-server.json` les fichiers serveur actifs. Ce sont des **preuves datées**, pas une lecture en direct.
3. Exécuter `bun run release:vercel status`. Identifier l'ID et le SHA réellement servis par les domaines. Comparer aussi avec `origin` ; si la production ou la branche distante a avancé, établir les différences avant de publier. Un push sur `main` publie le client seulement, sans mettre à jour Hetzner.
4. Geler le commit validé depuis un arbre de travail propre. Exemple PowerShell, depuis la racine :

```powershell
$releaseId = Get-Date -Format 'yyyyMMdd-HHmmss'
$releasePath = ".runtime/releases/$releaseId"
$releaseCommit = git rev-parse HEAD
bun run release:prepare "--id=$releaseId"
```

La commande ne fait aucun appel réseau. Elle exige un arbre propre, enregistre le SHA et la branche, et vérifie que les octets des fichiers inclus correspondent au commit. Elle refuse un identifiant invalide, une sortie déjà existante ou des fichiers liés hors du périmètre. Elle produit `release.json`, `source/`, `manifest.json`, `source.sha256`, `server.sha256`, `changes.json`, `server.tar.gz`, `validation.tar.gz`, `archives.sha256` et `server.sh`. Seuls `src/`, `public/` et les cinq fichiers nécessaires au build client sont inclus dans le manifeste de comparaison. Les archives serveur excluent le client public et les secrets ; les tests Linux sélectionnés sont séparés.

Inspecter `changes.json` et les fichiers modifiés par rapport à la production enregistrée, notamment toute suppression ou modification non liée à la tâche. Les archives serveur et les comparaisons utilisent les octets figés ; Vercel construit depuis le commit distant correspondant. Ne pas éditer `source/` ni installer ses dépendances : le build de comparaison retrouve le `node_modules` de la racine. En cas de changement, créer le commit nécessaire et préparer un nouvel identifiant. Les anciens dossiers `.runtime/*-release` sont des preuves, pas des procédures à recopier.

## Publier le bon périmètre

| Changement | Cibles |
|---|---|
| UI, audio, assets, présentation client | Vercel seulement |
| Transport/configuration serveur, code sans effet client | Hetzner selon les fichiers concernés |
| `src/shared`, génération de terrain, contrat de connexion | Examiner les deux côtés ; publier ensemble en cas d'incompatibilité |

Le terrain de base est régénéré par chaque client : modifier cette génération sans versionner le contrat provoquerait un désaccord de collisions. `PROTOCOL_VERSION` est dans `src/shared/protocol.ts`; le codec binaire possède sa version distincte dans `wire.ts`. Un redémarrage serveur termine la partie et ses modifications. Préparer les deux versions **avant** la bascule réduit l'interruption ; les pages anciennes devront être rechargées.

### Publication habituelle par push

Pour un changement client compatible avec le serveur actif, intégrer les commits validés sur `main` sans réécrire l'historique, préparer le snapshot depuis ce commit, puis :

```powershell
git push origin main
bun run release:vercel status "--commit=$releaseCommit" --ref=main
```

Le push déclenche le build Git de Vercel. Tant que les domaines servent l'ancien commit, `status --commit` échoue : attendre le nouveau déploiement, vérifier qu'il est `READY`, puis relancer ce contrôle. Lire aussi l'erreur du build si celui-ci échoue ; ne pas contourner un échec Git par un upload local.

Récupérer l'ID réellement servi avec `status`, puis vérifier ce build automatique sans passer par `stage` ou `promote` :

```powershell
bun run release:vercel verify "--release=$releasePath" --deployment=dpl_PUBLISHED "--commit=$releaseCommit" --ref=main
```

Remplacer `dpl_PUBLISHED` par l'ID réel. Le contrôle doit confirmer **à la fois** la provenance Git, le SHA attendu, les domaines et les ressources publiques. Compléter avec le smoke et le parcours navigateur décrits plus bas. Un push réussi seul ne prouve pas que la production a changé.

Pour une modification incompatible client/serveur, utiliser la préparation coordonnée ci-dessous. Pousser d'abord le commit sur une branche de travail choisie, sans pousser `main` avant que le serveur compatible soit prêt : ce dernier déclencherait une bascule client automatique.

### Staging serveur, sans toucher la partie publique

Pour un changement serveur, transférer les quatre fichiers dans un dossier neuf. Les variables ci-dessous restent celles de la préparation :

```powershell
$sshTarget = 'codex@2.29.30.129'
ssh -o StrictHostKeyChecking=yes $sshTarget "mkdir -p /home/codex/ubercube-releases/$releaseId"
scp -o StrictHostKeyChecking=yes "$releasePath/server.sh" "$releasePath/server.tar.gz" "$releasePath/validation.tar.gz" "$releasePath/archives.sha256" "${sshTarget}:/home/codex/ubercube-releases/$releaseId/"
ssh -t -o StrictHostKeyChecking=yes $sshTarget "bash /home/codex/ubercube-releases/$releaseId/server.sh stage $releaseId"
```

Le staging tourne sans sudo : vérification des empreintes et chemins d'archives, extraction dans `staged/`, puis tests Linux avec sockets locales. Il laisse la production active. En cas d'échec, corriger et préparer une nouvelle release ; ne pas fabriquer les marqueurs de validation.

### Staging Vercel depuis une branche déjà poussée

Remplacer `dpl_CURRENT` par l'ID courant obtenu avec `status`, jamais par un ID d'exemple ou un ancien historique :

```powershell
$baseline = 'dpl_CURRENT'
bun run release:vercel stage "--release=$releasePath" "--baseline=$baseline"
bun run release:vercel status --deployment=dpl_STAGED
```

Le script vérifie le projet, l'adresse publique du serveur et les domaines, ainsi que la présence du SHA préparé sur la branche distante. La branche enregistrée lors de la préparation est utilisée par défaut ; `--ref=nom-de-branche` permet de choisir une autre branche distante contenant ce même commit. Le script compile le snapshot pour comparaison puis crée un déploiement Production **depuis ce commit GitHub**, avec attribution automatique des domaines désactivée. Il n'envoie aucun fichier source local. `deployment.json` contient l'ID retourné à utiliser à la place de `dpl_STAGED`. Attendre `READY`; un build `ERROR` ou `CANCELED` ne doit pas être promu. Les checksums protègent le snapshot, ils ne remplacent pas la revue et les tests.

Un déploiement de staging peut être protégé par Vercel. Ne pas envoyer le token de compte à son URL, ni désactiver sa protection : l'état du build est vérifié par l'API ; les fichiers publics seront comparés après promotion.

### Bascule et vérification

Quand les deux versions sont prêtes, activer le serveur si nécessaire :

```powershell
ssh -t -o StrictHostKeyChecking=yes $sshTarget "sudo bash /home/codex/ubercube-releases/$releaseId/server.sh activate $releaseId /home/codex/ubercube-releases/$releaseId"
```

L'activation préserve les sources précédentes dans `/opt/ubercube/releases/ID/previous-src`, vérifie à nouveau les fichiers testés, redémarre le service, vérifie les empreintes actives et `/health`. Un échec d'activation déclenche la restauration précédente. Lire le résultat réel ; si la restauration échoue aussi, réparer le service avant de promouvoir un client incompatible.

Après confirmation que le serveur actif est compatible (ou qu'il n'a pas besoin de changer pour cette publication) :

```powershell
bun run release:vercel promote "--release=$releasePath" "--baseline=$baseline" --backend-ready
bun run release:vercel status
bun run release:vercel verify "--release=$releasePath"
bun run smoke --url=https://game.ubercube.io --origin=https://www.ubercube.io "--output=$releasePath/smoke.json"
```

`--backend-ready` est une assertion technique de l'opérateur, pas une nouvelle demande d'autorisation utilisateur. `/health` ne publie pas le numéro de protocole : vérifier aussi les sources actives et la connexion. La promotion est asynchrone ; attendre que **tous** les domaines ciblent le nouvel ID avant `verify`. Cette commande contrôle le SHA Git déployé, recompile le snapshot et compare chaque ressource publique (JS, workers, chunks, CSS, HTML, assets). Seule la valeur `debugId` du commentaire final précédant `sourceMappingURL` dans les fichiers JS peut différer : elle ne fait pas partie du code exécuté. Les empreintes brutes servies et locales restent enregistrées avec l'empreinte de comparaison ; toute autre différence échoue. Les source maps elles-mêmes sont exclues car leur accès peut être restreint.

Si la release coordonnée a utilisé une branche de travail, synchroniser ensuite `main` avec le commit validé, idéalement par fast-forward. Si l'intégration crée un nouveau commit, il faut le valider et préparer son propre snapshot. Le push de `main` peut lancer un autre build Git ; vérifier également son SHA et ses ressources lorsqu'il remplace le build promu.

Le smoke crée deux joueurs temporaires et vérifie protocole, monde partagé, apparitions, commandes, visée et fermeture des connexions. Il ne valide pas le rendu : ouvrir également le vrai site, parcourir pseudo → lobby → kit → jeu, inspecter console/réseau, terrain et HUD, puis quitter. Ne pas déclarer un déploiement terminé avec seulement un statut `READY`.

### Revenir à la version précédente

Revenir aux versions **compatibles des deux côtés** si le protocole ou le monde partagé a changé. Pour le serveur, `ID` désigne la release qui vient d'être activée, et non celle que l'on souhaite retrouver :

```sh
sudo bash /opt/ubercube/releases/ID/server.sh rollback ID
```

La commande refuse d'annuler une autre release installée depuis. Elle restaure `previous-src`, redémarre et contrôle la santé. Pour les archives antérieures à cet outillage, utiliser les chemins de sauvegarde documentés dans [l'historique](deployment.md) ; ils n'ont pas de `server.sh` générique.

Pour Vercel, promouvoir l'ID explicitement connu de la version compatible précédente et indiquer son SHA poussé :

```sh
bun run release:vercel rollback --deployment=dpl_PREVIOUS --baseline=dpl_CURRENT --commit=SHA_PREVIOUS --ref=main --backend-ready
bun run release:vercel status --commit=SHA_PREVIOUS --ref=main
```

Il s'agit de promouvoir un build Production existant et READY du même projet, dont la provenance Git est vérifiable. Remplacer les IDs et `SHA_PREVIOUS` par les valeurs relevées avant la publication. Les anciens builds issus d'uploads locaux ne sont pas des cibles acceptées : si leur contenu doit être restauré, créer un commit de restauration, le pousser puis publier ce commit. Vérifier ensuite les ressources connues de cette version, le smoke et le navigateur. Ne pas réutiliser le manifeste du build annulé pour vérifier celui restauré. Un rollback opérationnel ne réécrit jamais Git ; corriger ensuite la branche avec un nouveau commit ou un revert ciblé.

## Enregistrer le résultat

Après vérification complète seulement, actualiser les champs `recorded*` de `ops/production.json`, enregistrer le SHA source publié et le SHA effectivement déclaré par Vercel, copier `manifest.json` vers `ops/deployed-client.json` pour un client publié, et convertir les entrées de `server.sha256` en `{ "file": "src/...", "sha256": "..." }` dans `ops/deployed-server.json` pour un serveur publié. Une release seulement préparée, échouée ou une modification locale du package ne change **pas** les empreintes de production.

Ajouter date, cibles, commits, validation et limites dans `docs/deployment.md`/`docs/validation.md`, puis créer un commit distinct pour ces preuves. Les rapports et archives détaillés restent dans `.runtime/releases/ID/` ; les chemins et faits utiles doivent être compréhensibles dans les documents durables. Ne pas archiver d'identifiants avec les preuves. Tout nouveau push sur `main`, y compris un commit documentaire, peut déclencher Vercel : contrôler le déploiement réellement servi après ce push et ne pas confondre le commit de preuve avec le commit applicatif qu'il décrit.

## Tester l'outillage sans publier

`bun run check` inclut les tests de préparation (provenance Git, périmètre des archives, fichiers liés, modifications pendant le gel), de l'API Vercel simulée (token, hôte, baseline, manifests, SHA déployé) et du smoke avec deux serveurs locaux TDM/FFA. Ces tests ne poussent aucun commit du projet et ne publient pas sur Vercel.

Le script serveur possède un banc séparé, car ses permissions et outils sont Linux. Depuis Linux :

```sh
sudo bash tests/release-server.sh --user=YOUR_LINUX_USER
```

Remplacer le nom par un utilisateur Linux non root existant. Sur le poste Windows de Marc avec la distribution WSL Debian existante :

```powershell
wsl -d Debian -u root -- bash /mnt/c/Users/Marc/Documents/Dev/ubercube.io/tests/release-server.sh --user=mploux
```

Le banc utilise uniquement un dossier temporaire `/tmp/ubercube-server-test.*`, redirige les chemins du script dans ce dossier et simule Bun, systemd, curl et les attentes. Les fichiers, archives, empreintes et permissions restent réels. Il couvre staging, refus d'archive corrompue et de tests échoués, activation, rollback et restauration après échec de chacune de ces opérations. Le dossier est retiré à la fin. Il n'utilise ni le serveur de jeu, ni un service système réel, ni le réseau.

Les résultats des publications réellement vérifiées sont datés dans [deployment.md](deployment.md). Le banc shell et les API simulées ne prouvent pas à eux seuls une publication réelle.
