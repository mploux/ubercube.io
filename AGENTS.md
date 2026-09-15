# UBERCUBE — règles de travail

## Démarrage d'un nouvel agent

- Ce dépôt contient le contexte nécessaire ; ne pas dépendre d'une ancienne conversation. Lire [README.md](README.md), puis [docs/agent-start.md](docs/agent-start.md) et les seules notes pertinentes pour la tâche.
- Travailler dans `ubercube.io`. Exécuter `bun run doctor` ; installer les dépendances avec `bun install --frozen-lockfile` si nécessaire. Bun 1.3.11 est la version de référence pour les builds de publication.
- Développement : `bun run dev --hostname=127.0.0.1`. Validation : tests ciblés, puis `bun run check` avant livraison. Les contrôles GPU/navigateur et de charge sont distincts ; voir le guide de démarrage.
- Pour publier : lire [docs/releasing.md](docs/releasing.md). Les outils durables sont dans `scripts/release/` et les cibles publiques dans `ops/production.json`. `.runtime/` ne contient que des sorties locales, des preuves historiques et éventuellement un fichier privé d'authentification ; aucun ancien script de release n'est une procédure à recopier.
- Accès serveur : `bun run doctor --server` vérifie réellement SSH, le sudo limité et le script installé, sans redémarrer le jeu. Sur le poste de Marc, la clé dédiée et le profil `ubercube-prod` sont dans `C:/Users/Marc/.ssh`, disponibles aux autres sessions du même compte Windows. Utiliser le script installé `/usr/local/libexec/ubercube-release` avec `sudo -n`, jamais `sudo bash` sur un script transféré. Un blocage du bac à sable nécessite les permissions d'exécution/réseau adaptées, pas un nouveau mot de passe produit.
- Le déploiement courant enregistré et ses empreintes sont dans `ops/production.json`, `ops/deployed-client.json` et `ops/deployed-server.json`. Vérifier leur fraîcheur et le SHA Git réellement déployé avant publication. GitHub est la source des nouvelles publications ; les anciennes releases par fichiers locaux sont uniquement historiques.

## Autorité et périmètre

- Une tâche de développement autorise les opérations Git locales nécessaires : état, diff, création de branche si utile, staging ciblé et commits cohérents du travail validé. Garder un historique propre fait partie du travail, sans attendre un rappel de Marc.
- Marc porte le produit. Le lead développeur porte les décisions techniques, le découpage, la coordination, l'intégration et la validation.
- Marc autorise explicitement une équipe de sous-agents pour ce projet. Déléguer des missions bornées et indépendantes, avec un responsable et des fichiers attribués ; le lead relit les résultats et résout les désaccords.
- Le Java dans `C:/Users/Marc/Documents/Dev/ubercube` est une référence en lecture seule. La nouvelle implémentation appartient à ce dépôt.
- Ne pas redemander une autorisation déjà donnée. Faire remonter les véritables décisions produit ; avancer sur les travaux indépendants pendant leur clarification.
- Ne pas publier, déployer sur une infrastructure externe ou envoyer de messages à des tiers sans autorisation adaptée.
- Une demande de publication autorise les commits nécessaires, le push de la branche convenue, la préparation, les contrôles, la mise à jour des cibles concernées et leur vérification ; ne pas redemander cette même permission à chaque étape. Une demande de code seule ne pousse pas sur `main` et ne publie pas automatiquement.
- Ne jamais écrire de mots de passe, tokens ou clés privées dans les sources, la documentation, les manifests ou les arguments de commande. Utiliser les variables/fichiers privés décrits dans le guide de publication. Ne pas afficher leur contenu. Envoyer le token Vercel uniquement à `api.vercel.com`.

## Historique Git et publications

- Un commit représente un changement cohérent, avec ses tests et sa documentation pertinente. Utiliser des titres explicites (`fix(net): ...`, `feat(terrain): ...`, `docs: ...`), jamais un lot de fonctionnalités sans rapport, `init`, `WIP` ou une correction temporaire comme livraison finale.
- Inspecter `git diff` puis `git diff --cached` avant chaque commit. Ajouter les chemins concernés explicitement ; ne pas embarquer des changements tiers, identifiants, fichiers `.runtime/`, dépendances, builds ou captures temporaires. Ne pas annuler le travail d'un autre agent pour obtenir un état propre.
- Le lead coordonne le staging, les commits et les pushes lorsque plusieurs agents travaillent ensemble. Chaque agent a des fichiers attribués ; ils ne modifient pas simultanément l'index Git.
- Passer les vérifications adaptées avant de committer et garder les commits compilables/testables. Terminer avec un état Git propre pour le périmètre livré, en expliquant tout travail tiers restant.
- **Tout déploiement Vercel doit provenir d'un commit déjà poussé sur GitHub.** Le chemin normal est le push validé sur `main`, qui déclenche l'intégration Git Vercel. Pour une bascule coordonnée, construire depuis le SHA immuable d'une branche déjà poussée. Interdiction des uploads du dossier local, de `vercel --prod` depuis des fichiers non rattachés au commit et des scripts historiques `.runtime/*/publish.*`.
- Vérifier la chaîne complète : commit local → SHA présent sur la branche distante → source Git du déploiement Vercel → domaines de production. `READY` seul ne prouve pas que le bon commit est publié. Consigner le SHA dans les preuves de release ; le serveur doit correspondre au même contrat partagé.
- Ne jamais réécrire une branche partagée, rebase/amend des commits déjà poussés, supprimer l'historique ou effectuer un force-push sans demande explicite. Pour rattraper un historique incomplet, ajouter des commits cohérents ; ne pas inventer de dates ou d'anciens commits de publication.

## Principes, dans cet ordre

1. YAGNI : construire seulement ce qui est nécessaire au jalon courant.
2. KISS : préférer la simplicité qui résout correctement le problème.
3. DRY : réutiliser l'existant sans abstraction prématurée.
4. Encapsulation : respecter les responsabilités et les frontières.
5. Cause racine : comprendre et vérifier avant de corriger.

Comprendre le code et rechercher les mécanismes existants avant de modifier. Préserver les comportements hors périmètre. Ne pas ajouter de classe, helper, dépendance ou infrastructure sans besoin concret. Les commentaires expliquent brièvement une raison. Respecter les conventions établies et retirer les traces temporaires après diagnostic.

## Contraintes du jeu

- TypeScript, Three.js pour le client, Bun pour le serveur et l'outillage. Tailwind uniquement si utile à l'interface.
- Serveur autoritaire : les clients transmettent des intentions ; le serveur décide des déplacements, collisions, tirs, dégâts, modifications du monde et résultats.
- Identité attribuée côté serveur et liée à la session/connexion. Aucun compte ni base utilisateurs pour le premier périmètre.
- Parcours : pseudo, lobby d'équipement, partie. Arrivées en cours de partie jusqu'à la capacité configurée, initialement 100 joueurs.
- Mode choisi au lancement : TDM ou FFA. En TDM, chaque entrant est affecté à l'équipe la moins nombreuse. En FFA, il rejoint la partie sans équipe.
- Préserver le gameplay de référence, notamment construction et destruction. Effondrements reportés. Terrain réinitialisé entre manches.
- Reprendre les visuels, police, composants UI, HUD, minicarte, personnages et animations du Java. L'accueil garde le panorama ; le lobby utilise le fond historique. Ne pas réinventer cette direction visuelle sans demande produit.
- Préserver le solo de secours, les contrôles mobiles à deux pouces et l'atténuation audio globale par 50 (100 % du curseur reste disponible). Ces décisions sont déjà validées.
- Distinguer comportement de gameplay, défaut du Java et hypothèse non vérifiée. Ne pas transformer silencieusement les balles en hitscan ni inventer un rechargement différent.
- Le type de scaling futur, les conditions de fin de manche et le matériel cible restent à préciser. Ne pas introduire de simulation distribuée ou de base de données pour anticiper ces réponses.

## Frontières retenues pour le premier socle

Un seul package Bun suffit au départ. `src/server` possède l'orchestration et l'état autoritaire ; `src/client` possède l'affichage, l'interface, les entrées et l'audio ; `src/shared` contient les seules règles, données voxel, simulations et définitions de protocole réellement partagées. Le code partagé ne dépend ni du DOM, ni de Three.js, ni des API Bun, ni des sockets.

Le terrain de collision est indépendant des maillages. Une manche et ses révisions de terrain doivent être identifiables afin d'écarter les messages périmés. Optimiser à partir de mesures RAM, CPU, GPU et réseau ; ne pas promettre une capacité infinie.

Le client reconstruit le monde de base et reçoit les mutations. Une modification incompatible de la génération ou du contrat réseau nécessite de revoir `PROTOCOL_VERSION` dans `src/shared/protocol.ts` et de publier serveur et client ensemble. Le format binaire a sa propre version dans `wire.ts` ; ne pas l'incrémenter sans changement de format. Un redémarrage serveur déconnecte les joueurs et réinitialise la manche.

## Validation et communication

- Ajouter des tests qui protègent les règles, l'autorité ou les frontières réseau modifiées. Ne pas créer de tests qui ne font que recopier l'implémentation.
- Vérifier l'arrivée tardive pendant la destruction, les anciennes données après reset et les commandes invalides.
- Valider la cible de 100 joueurs avec une activité réelle simulée, y compris leur concentration au même endroit ; compter des connexions ne suffit pas.
- Distinguer lecture statique, tests automatisés, exécution multi-client et mesures de charge. Décrire ce qui a réellement été vérifié.
- Rapports courts : changement, raison, validation et limite restante. Ne pas présenter un document de conception comme une fonctionnalité implémentée.
- Ne pas lancer de charge sur la production pour une simple validation locale. `bun run smoke` crée deux joueurs temporaires sur la cible explicitement indiquée ; utiliser un serveur local ou la cible de publication autorisée, puis vérifier la fermeture des connexions.
- Mettre à jour la documentation touchée par le changement. Après une publication réellement vérifiée, actualiser les empreintes et l'état daté dans `ops/`, ainsi que la preuve de publication. Ne jamais présenter les empreintes d'une préparation comme celles de la production.

Les décisions produit et les jalons sont suivis dans [README.md](README.md). Les notes spécialisées se trouvent dans `docs/`.
