# Reprendre UBERCUBE

Ce guide est le point d'entrée d'une nouvelle session. Il ne suppose ni ancienne conversation, ni ancien dossier `.runtime`, ni accès à la production pour développer. Les règles applicables sont dans [AGENTS.md](../AGENTS.md).

## Préparer l'environnement

1. Ouvrir le bon dossier `ubercube.io`. Sur le poste de Marc : `C:/Users/Marc/Documents/Dev/ubercube.io`. Le Java voisin `../ubercube` est une référence **en lecture seule**.
2. Inspecter `git status --short --branch`, `git log -5 --oneline` et les différences locales. Identifier la branche et les travaux déjà présents ; préserver les changements d'un autre agent. Installer Bun **1.3.11**, puis `bun install --frozen-lockfile` et `bun run doctor`. Le doctor simple contrôle les dépendances et la présence des outils. Pour publier sur le serveur, `bun run doctor --server` vérifie SSH et le sudo limité sans modifier le jeu ; voir [les accès](releasing.md#cibles-et-accès).
3. Lancer `bun run dev --hostname=127.0.0.1` et ouvrir `http://localhost:3000`. Le client et le serveur se rechargent ; actualiser la page après recompilation. Aucun identifiant externe n'est nécessaire.
4. Lire le système concerné et ses tests avant de modifier. Exécuter les tests ciblés, puis `bun run check` avant livraison. Relire le diff et créer des commits ciblés qui regroupent code, tests et documentation du même changement.

`.env.example` documente les réglages locaux. Une variable `PUBLIC_GAME_SERVER_URL` héritée peut faire viser le serveur public à un client local : la laisser vide pour travailler avec le serveur local. Les fichiers `.env`, `.env.local` et autres valeurs privées sont ignorés. Garder les exemples sans secrets.

`.gitattributes` conserve les fichiers texte en LF, y compris sur Windows. Garder cette convention dans l'éditeur : les archives de publication doivent contenir exactement les octets du commit, sans conversion CRLF locale.

Sur Windows, un `EPERM` lors de `Bun.spawn` peut venir du bac à sable plutôt que du code. Exécuter la même commande par le mécanisme d'approbation prévu par l'environnement ; ne pas neutraliser le test. Un `bun run check` réussi comprend TypeScript, la suite de tests et le build. Les outils de publication exigent Bun 1.3.11 afin de comparer les builds par empreinte.

## Trouver le code et les décisions

| Travail | Points d'entrée | Référence |
|---|---|---|
| Simulation, combat, admissions, reset | `src/shared/game.ts`, `movement.ts`, `grenade.ts`, `weapon-pose.ts` | [Gameplay](gameplay-client.md) |
| Serveur HTTP/WSS et configuration | `src/server/index.ts`, `src/server/game.ts` | [Réseau](server-network.md) |
| Contrat client/serveur | `src/shared/protocol.ts`, `wire.ts` | [README, architecture](../README.md#architecture) |
| Terrain et structures | `src/shared/voxel.ts`, `terrain-generation.ts`, `vegetation.ts`, `buildings.ts` | [Terrain livré](terrain-generation.md) |
| Maillage et ombres | `src/client/terrain.ts`, `terrain.worker.ts`, `shadows.ts` | [Validation GPU](validation.md) |
| Écran de jeu, parcours et réglages | `src/client/main.ts`, `styles.css`, `public/index.html` | [UI historique](ui-reference.md) |
| Mobile | `src/client/touch-controls.ts`, `input-button.ts`, `main.ts` | [Deux pouces](mobile-controls.md) |
| Personnages, armes et effets | `src/client/player-visuals.ts`, `weapon-view.ts`, `presentation.ts` | [Personnages](player-reference.md) |
| Solo de secours | `src/client/solo.worker.ts`, `server-endpoints.ts` | [README](../README.md) |
| SEO et assets historiques | `public/index.html`, `public/assets/social/`, robots/sitemap | [SEO](seo.md), [licences](../THIRD_PARTY.md) |
| Publication | `scripts/release/`, `ops/` | [Publication et rollback](releasing.md) |

`src/server/game.ts` est la façade serveur ; la simulation commune au serveur et au worker solo est dans `src/shared/game.ts`. Ne pas créer deux implémentations divergentes. Le partagé ne dépend ni du DOM, ni de Three.js, ni de Bun ou des sockets.

Le produit validé : TDM ou FFA, jusqu'à 100 joueurs par défaut, pseudo sans compte, équipement puis apparition, AK-47/AWP en hitscan et grenades physiques, outils de construction/destruction, réinitialisation par manche. Le hitscan et les ragdolls ont été publiés le 15 septembre 2026 avec le protocole 3 côté client et serveur ; voir les preuves dans docs/deployment.md. L'UI, la police, le HUD, la minicarte, les personnages et armes reprennent le Java. Conserver l'accueil avec panorama, le lobby historique, les contrôles à deux pouces et le gain audio global `/50`. La [compensation historique AK/AWP](lag-compensation.md) est implémentée localement le 22 septembre 2026, avec le protocole 8, sans publication. Les sensations humaines, les grandes cartes, les effondrements et le scaling distribué restent des sujets ouverts ; aucune DB n'est nécessaire au périmètre actuel.

Les notes `voxel-engine.md` et certaines sections de `server-network.md` contiennent du cadrage ancien : leurs projets ne sont pas tous implémentés. Le code, le README et les résultats datés de `validation.md` établissent l'état réellement livré.

## Vérifier le bon niveau

- **Code** : `bun test tests/nom.test.ts`, puis `bun run check`. Les fixtures Java sont déjà dans les tests ; Java n'est pas une dépendance de cette suite.
- **Rendu** : `bun scripts/visual-check.ts`, ouvrir `http://127.0.0.1:3011/`, attendre le résultat de succès, inspecter les captures et diagnostics, puis arrêter le serveur. Ce contrôle utilise les shaders et modèles réels.
- **Parcours** : pseudo → lobby → kit → jeu → quitter. Vérifier arme, HUD, minicarte, son et absence d'erreurs console/réseau. Pour un changement tactile : déplacement + rotation + tir simultanés, visée, saut, grenade au relâchement et annulation à la pause/rotation.
- **Transport** : `bun run smoke --url=http://127.0.0.1:3000 --origin=http://127.0.0.1:3000`. Crée deux joueurs temporaires, vérifie protocole, synchronisation, commandes et départ ; ne tire pas et ne modifie pas le terrain. Le serveur doit être démarré, et l'origine doit être autorisée ou du même hôte.
- **Charge** : sur une instance locale séparée, `bun run loadtest --url=ws://127.0.0.1:3001/ws --players=100 --seconds=30`. Les clients jouent réellement. Tester aussi la concentration sur petite carte et les resets pour un changement de simulation ; ne pas lancer cette charge sur le serveur public sans demande spécifique.
- **Outillage serveur** : les tests Bun couvrent les archives et les limites de publication. Pour une modification de `scripts/release/server.sh`, exécuter aussi le banc Linux isolé décrit dans le [guide de publication](releasing.md#tester-loutillage-sans-publier) ; il n'est pas inclus dans `bun run check`.

Les essais dans un navigateur intégré peuvent refuser la capture du pointeur. Un viewport mobile émulé n'est pas un téléphone physique. Décrire séparément les tests unitaires, le transport réel, le rendu et les sensations humaines. Les preuves de nouvelles sessions vont dans `.runtime/`; les résultats utiles et leurs limites sont résumés dans `docs/validation.md`.

## Passer à une nouvelle session ou publier

Après une modification, actualiser les documents concernés et fournir changement, validation, commits et limites. Un état de conversation n'est pas une dépendance durable. Conserver les secrets, builds et preuves volumineuses dans les emplacements privés ou ignorés prévus, jamais dans les commits.

Une tâche de développement autorise l'inspection Git, le staging ciblé et les commits locaux nécessaires. Inspecter `git diff --cached` avant chaque commit ; ne pas embarquer des fichiers sans rapport avec la tâche. Les changements interdépendants peuvent partager un commit cohérent ; les corrections indépendantes doivent rester séparées. Donner un titre concret, par exemple `fix(audio): reduce global output gain`. En travail à plusieurs agents, le lead attribue les fichiers et reste seul responsable du staging, de l'intégration et des commits du dossier partagé.

Une demande « déploie » autorise le push de la branche choisie et les étapes nécessaires du [guide de publication](releasing.md). Le chemin habituel est **commits validés → push sur GitHub → déploiement Git Vercel → vérification du SHA publié**. Une demande de code seule laisse la production intacte. Ne pas déployer des fichiers locaux ni un commit absent du dépôt distant. Ne jamais réécrire un historique publié, supprimer une branche distante ou pousser en force sans demande explicite.

Au début d'une publication, comparer la branche locale, la branche distante et le déploiement réellement servi. Les empreintes datées `ops/deployed-client.json` et `ops/deployed-server.json` décrivent la dernière publication enregistrée, pas une lecture en direct. Les publications locales des 12–13 septembre 2026 restent documentées comme telles : ne pas leur attribuer rétroactivement une provenance Git. Les nouvelles publications doivent enregistrer le commit poussé et le SHA déclaré par Vercel.

Les identifiants ne sont jamais fournis par le dépôt : GitHub utilise l'accès Git configuré, Vercel un token privé. Sur le poste de Marc, SSH utilise le profil `ubercube-prod` et sa clé dédiée dans `C:/Users/Marc/.ssh` : les nouvelles sessions du même compte peuvent l'utiliser sans connaître un mot de passe ni démarrer `ssh-agent`. Activer et annuler une release via `sudo -n /usr/local/libexec/ubercube-release`, sans `ssh -t` et sans lancer un script transféré avec sudo. Une nouvelle machine sans ces accès peut développer et tester ; son accès doit être provisionné séparément.
