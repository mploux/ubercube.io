# Compensation des tirs AK/AWP — 22 septembre 2026

Implémentation locale, **non publiée**, protocole 8. Le [diagnostic initial](combat-latency-20260922.md) reproduisait jusqu'à 1,049 bloc d'écart sur une cible en course à exactement 50 ms aller-retour. Le serveur vérifie maintenant les impacts AK/AWP sur les positions que le tireur voyait, avec un retour maximal de **250 ms**. L'interpolation, les vitesses et le transport restent identiques ; le ping et le délai de confirmation du tir ne diminuent pas.

## Contrat et autorité

Les commandes multijoueurs ajoutent ensemble trois valeurs facultatives :

- `viewTick` : tick fractionnaire interpolé lors du dernier `RemotePlayers.sample()` affiché. La simulation précédant le rendu, une commande utilise bien l'image précédente, même si un snapshot arrive entre les deux.
- `viewLatestTick` : dernier snapshot disponible lors de cet échantillonnage. Il permet de reconstruire aussi les arrivées, réapparitions et téléportations immédiatement visibles.
- `worldRevision` : révision du terrain appliquée par le client lors de la commande.

Le serveur rejette un trio incomplet, les valeurs non finies, les entiers invalides, les dates futures et un dernier snapshot non envoyé dans l'historique conservé. Le tick de visée ne peut dépasser le dernier snapshot déclaré. Une image trop ancienne ou un historique indisponible conserve la résolution actuelle du tir, sans supprimer l'intention de déplacement. Le solo omet le trio.

Chaque connexion conserve les snapshots effectivement envoyés, y compris ceux hors cadence lors d'une apparition. Les positions copiées des diffusions communes sont partagées entre connexions ; le serveur conserve 15 ticks et l'extrémité précédente nécessaire à l'interpolation. Il ne modifie jamais les positions vivantes pour effectuer les raycasts. Une victime déjà morte, réapparue dans une vie non vue, ou téléportée depuis l'image ne reçoit pas de dégâts sur son ancienne position. Les historiques sont purgés au départ, à l'apparition du tireur et au changement de manche.

Le serveur continue de choisir le canon, la direction, le recul, la dispersion, la cadence, les munitions et les dégâts. L'obstruction entre l'œil et le canon utilise le même historique que le rayon principal. Le headshot est calculé dans la hitbox historique ; le point appliqué au ragdoll est translaté dans le corps actuel. RPG, grenades, pelle et médic gardent leurs règles.

Le client ne déclare ni cible ni dégât. Il peut cependant mentir sur une image passée dans la fenêtre autorisée : ces contrôles bornent le retour et les données utilisables, sans prouver cryptographiquement ce qui était affiché ni mesurer un RTT serveur indépendant.

## Terrain construit et détruit

Les anciennes valeurs des voxels modifiés sont conservées par révision pendant 15 ticks, avec un plafond de 32 768 entrées pour l'historique et de 32 768 pour les changements en attente du tick. Un dépassement ou une révision expirée désactive la compensation du tir concerné.

Le rayon est bloqué par l'union des couvertures actuelles et des couvertures de la révision appliquée côté tireur. Ainsi, une construction récente protège immédiatement ; une destruction récente n'autorise pas à traverser un mur encore présent dans cette révision. Un impact dans un ancien bloc détruit ne le recrée pas. Les modifications antérieures à la diffusion du tick sont incluses.

Ce choix privilégie les couvertures. Il peut refuser un tir près d'une construction récente malgré l'ancienne image ; ce n'est pas une reproduction intégrale du monde passé. La révision logique reçue ne mesure pas le délai de reconstruction des maillages GPU.

## Résultats

Le banc déterministe exécute **1 152 essais par mode** : RTT de 0/50/100 ms, vitesses de 0/3/6/9 blocs/s, AK/AWP, visée centrée/anticipée et plusieurs phases de tick/snapshot. À exactement 50 ms RTT :

| Cible et visée | Sans compensation | Avec compensation |
|---|---:|---:|
| Immobile, centre | 24/24 | 24/24 |
| Marche à 6 blocs/s, centre | 0/24 | 24/24 |
| Course à 9 blocs/s, centre | 0/24 | 24/24 |

Chaque cellule vaut **par arme**. Les 576 tirs centrés de la matrice compensée touchent, dégâts et impacts concordants. Les 1 152 résultats sans métadonnées conservent exactement l'empreinte des lignes du diagnostic initial : `d1edfb14ef0df272ac84bb7efac722ac8ab76e2c173876e0a73e47844e48d8c5`. Le délai d'affichage reste identique ; c'est le choix de la hitbox lors du tir qui change. Ces taux décrivent la géométrie contrôlée, pas la précision attendue en partie.

Les deux vrais clients WebSocket confirment **260 tirs** sur dix configurations. Pour les configurations demandant 50 ms RTT, les médianes réellement mesurées vont de 63,02 à 63,22 ms sur Windows :

| Cible mobile, visée centrée | Diagnostic initial | Compensation finale |
|---|---:|---:|
| AK, marche | 0/27 | 27/27 |
| AK, course | 0/25 | 25/25 |
| AWP, course | 0/10 | 10/10 |

Ces dénominateurs excluent les demi-tours ; les 260 tirs restent tous dans les données détaillées. Les commandes acquittées, impacts et pertes de PV concordent. L'anticipation de contrôle de 150 ms manque maintenant ces cibles, comme attendu lorsque la hitbox correspond à l'image. Aucun input ou tick abandonné, zéro connexion restante à chaque scénario. Ce banc mesure aussi le délai de confirmation, qui reste soumis au transport.

Un banc distinct utilise **100 clients WebSocket actifs**, 20 s de combat puis 10 s après un reset, avec et sans métadonnées. Les quatre phases confirment pour tous les clients les acquittements et déplacements ; les tirs, impacts, PV et modifications de terrain sont observés. Aucun input ni tick abandonné, aucune erreur ; reset reçu par tous, zéro connexion restante.

| Métadonnées | Phase | Travail de tick p95 / p99 |
|---|---|---:|
| Absentes | Combat 20 s | 0,569 / 2,215 ms |
| Présentes | Combat 20 s | 1,328 / 3,641 ms |
| Présentes | Après reset 10 s | 1,116 / 3,352 ms |

La phase compensée de 20 s produit 3 344 tirs, 2 571 impacts sur joueurs et 401 mutations de terrain. Les historiques observés restent à sept snapshots par connexion au maximum. Les deux modes collectent les historiques : cette comparaison n'isole pas le coût total contre l'ancien serveur. Les combats divergent aussi entre les modes. Les percentiles stock couvrent au plus les derniers 1 024 ticks ; la phase après reset inclut donc des ticks précédents.

Serveur et 100 clients partagent le même processus Windows. Leur RTT médian réel est de 81 à 95 ms malgré les 50 ms demandées ; cette charge n'est pas une qualification à exactement 50 ms. La mémoire du processus inclut les mondes et buffers des clients. Le test court n'établit pas la capacité de la machine de production.

## Reproduction et preuves

```sh
bun scripts/benchmark-combat-latency-deterministic.ts --uncompensated
bun scripts/benchmark-combat-latency-deterministic.ts
bun scripts/benchmark-combat-latency.ts
bun scripts/benchmark-combat-load.ts
```

Les sorties détaillées de cette session sont dans `.runtime/lag-compensation-20260922/`. Le script de charge réutilisable écrit par défaut dans `.runtime/combat-load-latest.json` ; `--output=...` permet de conserver un résultat nommé. Le [résumé durable](benchmarks/2026-09-22-lag-compensation.json) conserve paramètres, mesures et empreintes. Les bancs comparent la résolution sans métadonnées et celle utilisant le trio. Le banc déterministe utilise une horloge virtuelle et les vrais mouvements, interpolation, armes, codec, impacts et PV. Le banc WebSocket utilise deux clients réels et le scheduler serveur, avec des délais de transport symétriques ; ses timers Windows doivent être distingués du RTT demandé.

Ces bancs visent au torse depuis une position fixe, sur terrain plat, avec visée stabilisée ; ils échantillonnent les joueurs au moment de générer l'input. Les tests `client-shot-timing` exécutent séparément la vraie fonction `simulate()` du client pour vérifier l'image précédente, les snapshots arrivant entre deux images et les rattrapages. Les tests `remote-players` couvrent des cadences de 30, 60 et 144 images/s. Les tests `lag-compensation` passent par les commandes publiques pour les tirs, les dégâts, la construction, la destruction, les limites d'historique et les changements de vie/manche.

TypeScript et build client passent. Les **568 tests sélectionnés dans 49 fichiers** passent : 567 directement, puis le seul test `client-build` relancé inchangé avec les permissions d'exécution adaptées après un blocage `EPERM` de son sous-processus Bun. Les 41 tests de compensation serveur totalisent 297 assertions. `bun run check` intégral n'est pas exécuté : les deux suites `release-prepare` et `release-vercel` utilisent Git et sont exclues conformément à la demande. Aucune commande Git n'est utilisée.

Les sensations avec plusieurs joueurs humains, les machines distinctes, le WAN, les navigateurs/GPU et la charge prolongée restent à valider. Une publication devra associer client et serveur du protocole 8 ; les empreintes `ops/` conservent l'état de production enregistré.

## Fichiers concernés

La publication est préparée dans un checkout isolé issu de la version publique, sans le chantier d'import/rotation des cartes. Ce checkout passe `bun run check` intégral : **563 tests, 23 221 assertions**, TypeScript et build. Les 41 tests serveur conservent leurs 297 assertions. Le banc déterministe y repasse ses **1 152 essais**, sans violation ; les tirs centrés à 50 ms restent à 24/24 par arme et vitesse. Les fixtures utilisent désormais `VoxelWorld.set` pour préparer le sol, sans dépendance aux cartes importées. Le script de charge réutilisable emploie le terrain généré et les apparitions normales ; les chiffres à 100 joueurs ci-dessus restent ceux du banc initial sur terrain plat et ne sont pas attribués à ce nouveau scénario.

- `src/shared/game.ts` : validation, historiques et résolution autoritaire ; `src/shared/voxel.ts` : raycast acceptant une vue du terrain en lecture seule ; `src/shared/protocol.ts` : trio de métadonnées et protocole 8.
- `src/client/remote-players.ts` : expose les ticks de l'image échantillonnée ; `src/client/main.ts` : les joint aux commandes multijoueurs.
- `tests/lag-compensation.test.ts`, `tests/client-shot-timing.test.ts`, `tests/remote-players.test.ts` : autorité et correspondance avec l'image affichée.
- `scripts/benchmark-combat-latency-deterministic.ts`, `scripts/benchmark-combat-latency.ts`, `scripts/benchmark-combat-load.ts` : reproduction et charge locale.
- README et guides démarrage/réseau/gameplay/validation, rapport initial annoté, ce document et son résumé JSON : état local distingué de la publication.
