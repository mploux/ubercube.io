# Validation du 11 au 22 septembre 2026

Le jeu est publié sur Vercel et Hetzner. Cette page distingue les vérifications locales et celles de production ; la parité des sensations avec le Java, la tenue prolongée sur Internet et les grandes distances d'affichage ne sont pas encore entièrement validées.

## Captures souris/clavier et continuation de kill cam — 22 septembre 2026

Publication client vérifiée : commit `b25b90356092d3612debe28bca8572b8c79f91ee`, protocole 6, sans redémarrage du serveur. Dans le checkout isolé, excluant le chantier de cartes, **`bun run check` complet réussit : 510 tests / 21 866 assertions**, TypeScript et 11 sorties de build. Le SHA GitHub et Vercel, les trois domaines et **54 ressources publiques** sont vérifiés. Smoke Internet réussi avec deux joueurs et fermeture des connexions ; parcours public pseudo → lobby → assaut → jeu/menu → déconnexion, HUD/arme/minicarte inspectés et aucun diagnostic console. Le navigateur intégré refuse toujours la capture souris : l'interception native de Ctrl+Tab reste à confirmer dans Chrome/Edge. [Preuves de publication](deployment.md#publication-des-captures-et-de-la-kill-cam-prolongée--22-septembre-2026).

Les contrôles ci-dessous décrivent la phase locale précédente, avant autorisation de publication.

Le pointeur reste capturé entre jeu, death cam et kill cam. Le clic droit et la molette sont neutralisés pendant les caméras. La kill cam dure 5 s : 2,7 s avant la mort, 2 s d'action enregistrée après celle-ci, 0,3 s de maintien final ; la death cam reste à 3 s. Sur ordinateur, le choix du kit et la reprise demandent le plein écran et Keyboard Lock afin de recevoir Ctrl+Tab. Échap, les pertes de focus/capture et le retour au lobby libèrent le clavier. Le mobile conserve son parcours.

`bun run doctor`, TypeScript et build réussis (11 sorties). Suite locale hors `release-prepare.test.ts` et `release-vercel.test.ts` : **513 tests / 22 089 assertions**, aucun échec, journal `.runtime/controls-check-20260922.log`. Ces deux fichiers exécutent Git et sont exclus pour respecter l'interdiction de cette session ; ce résultat n'est donc pas un `bun run check` complet. Le blocage `EPERM` du sous-processus de compilation a disparu avec les permissions d'exécution adaptées, sans modification de son test.

Après la dernière correction du timing de reprise, les **28 tests de contrôles / 177 assertions** et TypeScript repassent. Ils exécutent les fonctions et événements de production dans un DOM simulé : Ctrl maintenu pendant Tab, actions neutralisées dans les caméras, champs éditables, sortie des captures, API absentes/refusées et autorisations asynchrones. La revue a corrigé une capture clavier reçue après Échap et une capture clavier reçue avant la souris lors d'une reprise. Les **18 tests de replay / 216 assertions** couvrent la continuation, les événements uniques, le décès/départ du tueur, les mutations, budgets et resets.

Parcours navigateur local vérifié : pseudo → lobby → assaut → jeu/menu → déconnexion, retour à zéro joueur. Le navigateur intégré refuse la capture souris ; la capture native de Ctrl+Tab en Chrome/Edge n'a donc pas été vérifiée. Les tests de DOM ne prouvent pas l'interception des raccourcis du navigateur. Aucune commande Git, publication ou charge de production. Serveur et onglet temporaires fermés.

## Caméras de mort, sneak, chutes et auto-soin — 21 septembre 2026

Préparation de publication : les changements antérieurs d'import/rotation de cartes sont exclus dans un checkout isolé, sans altérer le chantier local. Sur ce périmètre exact, `bun run check` repasse : **478 tests / 21 658 assertions**, TypeScript et 11 sorties de build. Les 505 tests ci-dessous décrivent le dossier de développement avec ce chantier de cartes présent. L'archive Linux inclut maintenant les tests `gameplay-actions` et `gameplay-network`.

Publication client et serveur vérifiée, protocole 6, codec binaire inchangé. Maj maintenu pour sneak, Ctrl pour courir, dégâts de chute entre 6 et 20 blocs, soin personnel du sac médic au clic droit, réticules pour toutes les armes. Death cam de 3 s suivie d'une kill cam de 3 s ; chute/suicide/sans tueur exploitable : death cam seule. [Règles, budgets et limites](gameplay-client.md#ajouts-du-21-septembre-2026).

`bun run doctor` réussit avec Bun 1.3.11. `bun run check` final passe : **505 tests / 22 053 assertions**, TypeScript et 11 sorties de compilation. Les sous-processus bloqués par `EPERM` dans le bac à sable passent avec les permissions adaptées, sans désactiver de test. Journal : `.runtime/gameplay-check-final.log`. Les tests protègent les bords droits/diagonaux, l'élan, le saut, les supports détruits, les seuils de chute, l'atterrissage mortel, le reset, les fronts de soins et la priorité clic droit. Quatre nouveaux tests WebSocket vérifient les acquittements et effets autoritaires, les messages périmés après reset et la fermeture effective des connexions.

Le contrôle navigateur local utilise le client et le serveur réels, avec un pilote d'entrées de test et un adversaire WebSocket. **20 contrôles réussis**, sans erreur JavaScript : soins confirmés, réticules des six équipements, placement tactile en 390 × 844, death cam puis kill cam de 3 s chacune, aucune intention pendant la mort, retour au lobby, réapparition, chute létale, interruption par reset et nettoyage à la déconnexion. Captures du corps et de la vue du tueur inspectées. Le sneak tactile se bascule pour conserver deux pouces sur mouvement et regard. Preuves et pilote dans `.runtime/gameplay-qa/`, `.runtime/gameplay-qa.ts` et `.runtime/gameplay-qa-client.txt`. Le banc vidéo existant compile également avec `bun scripts/qa-video.ts --local-sources` après adaptation de ses points d'injection.

La revue a reproduit puis corrigé la disparition d'un projectile lancé entre deux snapshots : le replay complète désormais les roquettes/grenades depuis leurs événements de lancement avant le snapshot suivant. Les tests utilisent les vrais renderers, vérifient les positions et empêchent la réapparition après explosion. La grenade rejouée n'ajoute pas le tampon réseau de 100 ms ; les grenades distantes en partie conservent ce tampon.

Charge locale : **100 joueurs actifs pendant 30 s sur une carte TDM de 64 × 64**, deux resets, 173 931 intentions. Tick p95 **2,80 ms**, p99 **5,58 ms**, maximum **15,42 ms** ; zéro commande perdue, tick abandonné ou erreur. Retour à zéro connexion vérifié et serveurs temporaires arrêtés. Rapports `.runtime/gameplay-load/loadtest.json` et `verification.json`. Les bots se concentrent sur cette petite carte et ses bases, sans placement forcé au centre ; leur script ne commande pas explicitement sneak/médic, couverts par les tests réseau ciblés.

Microbenchmark CPU du seul historique client : 100 joueurs, snapshots 20 Hz, 750 tirs et 750 impacts par seconde, lecture 60 Hz ; enregistrement + lecture par frame **0,487 ms p95**. Historique + clip représentent environ **6,39 Mo sérialisés en JSON**, estimation conservative qui compte deux fois les snapshots partagés, pas une mesure du tas JavaScript. Preuve `.runtime/death-replay/benchmark-100-players.json`. Ces mesures locales ne démontrent ni les FPS de 100 navigateurs, ni le ressenti humain, ni les performances sur téléphone physique. La kill cam conserve le terrain courant et reconstruit le point de vue adverse ; elle ne constitue pas une capture vidéo exacte. La publication décrite ci-dessous actualise les empreintes `ops/`.

La version isolée est publiée après **181 tests / 3 910 assertions** Linux réussis. Ses **20 contrôles navigateur** repassent, avec zéro erreur JavaScript : death cam 3,011 s, kill cam 2,994 s. Treize empreintes serveur, protocole 6, trois domaines et **54 ressources publiques** sont vérifiés. Le smoke Internet passe, puis le navigateur public rejoint le lobby et apparaît en Medic : terrain, sac, réticule, HUD et minicarte visibles, aucun diagnostic console. Déconnexion et retour à zéro joueur confirmés. La capture souris est refusée par le navigateur intégré ; le ressenti humain n’est pas validé par ce parcours. [Publication et preuves](deployment.md#publication-des-caméras-et-commandes-de-survie--21-septembre-2026).

## RPG relevé au repos en première personne — 21 septembre 2026

Réglage publié après validation de Marc : la coordonnée verticale du repos FPS passe de −0,18 à 0 bloc, après un premier essai à −0,10. L'origine de tir suit la pose partagée ; modèle, visée et poses distantes sont conservés. La capture `.runtime/rpg-idle-raised/final.png` a été inspectée face à `before.png` et `intermediate.png`. Les PNG de visée FPS, repos TP et visée TP sont identiques aux captures précédentes. `bun run check` passe : **410 tests / 20 472 assertions**, TypeScript et build client. Journal : `.runtime/rpg-idle-raised/check-final.log`.

La release `20260921-212035`, commit applicatif `5ea1639`, passe **148 tests / 3 270 assertions** sur Linux avant activation. Treize empreintes serveur, trois domaines et 54 ressources client vérifiés ; smoke Internet réussi et parcours public jusqu'à l'apparition puis déconnexion sans diagnostic console. Retour à zéro joueur confirmé. [Preuve de publication](deployment.md#publication-du-cadrage-rpg-relevé--21-septembre-2026).

## Publication du RPG validé — 21 septembre 2026

Après validation visuelle de Marc, la version applicative `c159cd5` est poussée sur `main` et publiée côté client et serveur en protocole 4. **`bun run check` passe : 410 tests / 20 478 assertions**, TypeScript et 11 sorties de build. L'archive de staging inclut les tests RPG et RPG réseau ; **148 tests / 3 270 assertions** passent sur Linux avant activation. Les vérifications de préparation d'archive et de génération des assets repassent après les seuls ajustements d'emballage et de fin de fichier.

Les empreintes des treize fichiers serveur/partagés actifs, les trois domaines et 54 ressources client sont conformes. Le smoke Internet à deux joueurs passe, y compris le refus du protocole 3. Le parcours public pseudo → lobby → Assault → jeu atteint le HUD, sans erreur console. Le navigateur intégré refuse la souris et ses captures sont indisponibles pendant ce contrôle ; sa session de test a expiré avant le retour à l'accueil. Les captures GPU et la vidéo de la révision précédente restent les preuves visuelles approuvées. Aucun tir de contrôle ni test de charge n'a été lancé sur la production. [Publication et preuves](deployment.md#publication-du-bazooka-assaut--21-septembre-2026).

## Ogive, lunette et prises en main du RPG — 21 septembre 2026

Après validation du modèle par Marc, sa silhouette et sa palette sont conservées. Les 280 triangles de l'ogive verte deviennent une pièce séparée, masquée sur le lanceur après le tir et réutilisée pour le projectile en vol. Le tube se recharge visuellement à la cadence existante. L'intérieur de l'optique est ouvert et la lentille devient transparente ; la visée reprend le zoom et le réticule de l'AWP. Le personnage porte le lanceur sur les avant-bras au repos et à l'épaule en visée, avec les mains sur les poignées. La géométrie finale compte **1 176 triangles, 656 sommets indexés et neuf matériaux**.

TypeScript, le build client et **388 tests / 20 317 assertions dans 39 fichiers** passent. Les tests protègent notamment le détachement/rechargement en FPS et sur les joueurs, le dégagement de la lentille, les contacts mains/poignées et les intersections avec tête/torse sur les angles testés. Les deux suites de publication exécutant Git restent exclues ; aucun succès de `bun run check` complet n'est revendiqué. Preuve : `.runtime/rpg-attachment-final-tests.log`.

Le contrôle GPU final affiche **RÉSULTAT : SUCCÈS** : ogive verte en vol à 60 blocs/s, départ du lanceur, fumée derrière l'ogive, disparition du mesh à l'impact puis dissipation des particules, poses FPS/TP et régressions existantes. Les planches `.runtime/rpg-review/quatre-vues-quarter.png`, `quatre-vues-profile.png` et `quatre-vues-front.png` ont été inspectées : repos et visée, en première et troisième personne. Les captures `third-shot20.png` et `third-shot45.png` montrent la séparation. Ce banc fixe utilise les vrais renderers avec des événements préparés, sans serveur.

La vidéo `.runtime/qa-video/bazooka-review-v3.mp4` vérifie séparément le vrai client et le vrai serveur via WebSocket : **20,13 s**, **1280 × 720 à 30 images/s**, son du jeu, **604 images décodées sans erreur**. Les deux scènes contiennent chacune deux tirs et deux explosions autoritaires, avec 170 puis 176 modifications voxel. Les 40 empreintes du rapport `rpg-report.json` correspondent aux sources et assets filmés. La planche `rpg-v3-contact-sheet.png` a été inspectée. Les commandes et caméras sont automatisées ; aucune nouvelle partie humaine ou mesure Internet n'est revendiquée. Travail local, sans Git ni publication.

## Revue du bazooka : modèle polygonal, explosion et particules — 21 septembre 2026

Cette révision locale remplace le premier modèle voxel et les paramètres du premier portage ci-dessous. Le RPG-7 original compte **1 106 triangles, 607 sommets indexés et neuf matériaux**, à partir de quatre références visuelles citées dans [bazooka](bazooka.md#modèle-dédié). Il emploie le shader et la palette bois/métal des autres armes, avec une pose à l'épaule et un départ de roquette à la pointe du modèle. L'assaut conserve son AK et reçoit le RPG ; le médic garde son kit de soins.

La roquette passe de 30 à **60 blocs/s**. Ses explosions infligent jusqu'à **80 PV**, contre 100 pour une grenade, avec dégâts dégressifs jusqu'à dix blocs et sans cumul direct + radial sur la cible touchée. Les buffers des particules alpha sont triés par profondeur de caméra, de loin vers près, avant chaque rendu ; matrices, couleurs et opacités restent associées sans modifier la simulation.

TypeScript, le build client et **378 tests / 19 894 assertions dans 39 fichiers** passent. Ils incluent les échanges WebSocket réels, l'impact direct et radial, la conservation des grenades, les classes, les resets, la pose et la génération reproductible du modèle. Les deux suites de publication qui exécutent Git restent exclues ; aucun succès de `bun run check` complet n'est revendiqué. Preuve : `.runtime/rpg-review-tests.log`.

Le contrôle GPU reconstruit depuis les sources finales affiche **RÉSULTAT : SUCCÈS**, sans erreur ni avertissement console. Le tri alpha est contrôlé au premier rendu après inversion de caméra (RGB 60,66,0 puis 100,26,0), avec occlusion opaque conservée (RGB 0,66,153). Les vues RPG repos/visée/recul, la fumée, les autres armes, personnages, ragdolls, terrain et ombres passent aussi. Les aperçus `.runtime/rpg-model-revised.png` et `.runtime/rpg-weapons-comparison.png` ont été inspectés.

La vidéo `.runtime/qa-video/bazooka-review-v2.mp4` dure **20 s**, en **1280 × 720 à 30 images/s**, avec son du jeu. Deux tirs et deux explosions autoritaires par scène, 179 puis 173 modifications voxel, vues FPS et extérieure inspectées ; les 600 images se décodent sans erreur. Les 40 empreintes du rapport archivé `rpg-report-v2.json` correspondaient aux sources et assets de cette prise. Marc a ensuite validé le modèle et demandé les corrections d'ogive, de lunette et de poses décrites ci-dessus. Cadrage et commandes automatisés.

Mesure locale de 100 joueurs concentrés, 600 ticks actifs : 1 081 tirs, 60 explosions, 545 éditions, 247 projectiles simultanés au maximum, 81 réapparitions après les dégâts de zone et aucun input perdu. Simulation + encodage : p50 **0,623 ms**, p95 **1,391 ms**, p99 **2,423 ms**, maximum **13,028 ms**. Preuve : `.runtime/rpg-concentrated-load.json`. Ce contrôle ne représente ni 100 navigateurs ni une session Internet. Aucun Git ni déploiement effectué pour cette révision.

## Première vidéo du bazooka — 21 septembre 2026 (avant revue)

Capture locale du vrai client et du vrai serveur, en première puis troisième personne, sans modification du gameplay. Deux tirs et deux explosions par prise sont présents dans les événements du client et du serveur ; les prises enregistrées produisent respectivement 70 et 104 modifications voxel. Le mur est restauré entre les prises. Le personnage en vue extérieure utilise le renderer des joueurs du jeu. Les commandes et le cadrage sont automatisés.

Le MP4 `.runtime/qa-video/bazooka-premiere-troisieme-personne.mp4` dure **20,17 s**, en **1280 × 720, 30 images/s**, avec son du jeu et gain conservé. Les images des deux scènes sont inspectées et les 605 images décodées sans erreur. Le rapport archivé `rpg-report-before-review.json` conserve les intentions, événements, états serveur et empreintes des sources locales de cette prise. Procédure reproductible dans [le guide vidéo](qa-video.md#bazooka-en-première-et-troisième-personne).

Les trois tests du banc vidéo passent : **610 assertions**, dont vol réel en WebSocket, explosions, mutations et restauration. TypeScript et build client passent. Pas de Git, de publication, de modification du gain audio ni d'essai humain revendiqué.

## Premier modèle de lance-roquettes — 21 septembre 2026 (remplacé après revue)

À la demande de Marc, le RPG remplace son ancien visuel AK par un modèle voxel original, partagé entre vue FPS et personnages distants. Le modèle comporte 2 276 triangles et 39 matériaux ; tube creux, ogive olive, manchon bois, deux poignées et viseur décalé. Son point de lancement, ses poses et toutes les règles du bazooka restent inchangés. Travail local, non publié.

`bun run doctor`, TypeScript et le build client passent. Les quatre fichiers ciblés (`rpg-model`, `materials`, `weapon-view`, `player-visuals`) passent : **45 tests / 8 939 assertions**. Ils vérifient la génération reproductible, le nez au point de lancement, la marge devant la caméra pendant le recul, l'orientation des faces, les matériaux et les poses. Preuve : `.runtime/rpg-model-tests.log`.

Le contrôle GPU local affiche **RÉSULTAT : SUCCÈS**, sans erreur ni avertissement console. Les captures du modèle complet, du repos, de la visée et du recul ont été inspectées ; les personnages distants chargent le même asset. L'aperçu final est enregistré dans `.runtime/rpg-model-preview.png`. Aucun nouvel essai humain ou sur téléphone physique. La suite de publication utilisant Git n'a pas été relancée ; les vérifications du gameplay ci-dessous restent celles du premier portage.

## Bazooka de l'assaut — 21 septembre 2026

Travail local, non publié, protocole 4. Le [RPG historique](bazooka.md) est ajouté après l'AK dans le seul kit assaut ; le médic conserve son kit. Source Java inspectée en lecture seule dans la dernière révision avant suppression du RPG, `543efa27c158f119725ebbf3d1984a93789bf11c`, sans compiler ni exécuter le Java.

`bun run doctor`, TypeScript et la compilation du client passent. **369 tests de jeu / 15 864 assertions dans 37 fichiers** passent, plus le test isolé de compilation (**1 test / 16 assertions**). Ils couvrent règles et poses du RPG, conversion des 253 voxels, vitesse/cadence, dégâts directs sans bonus tête, destruction, souffle sur joueurs et grenades, refus de l'arme aux autres classes, indépendance des munitions, protocole, événements, reset, fumée et régressions des armes existantes. Preuve : `.runtime/bazooka-gameplay-tests.log`.

`bun run check` a été tenté : les sous-processus Bun et Git de l'outillage ont rencontré `EPERM` dans le bac à sable Windows. Le test de compilation repasse avec la permission d'exécution adaptée. Les deux fichiers de tests de publication qui lancent Git (`release-prepare` et `release-vercel`) n'ont pas été relancés, pour respecter la restriction Git hors consultation demandée du Java ; aucun succès de `check` complet n'est annoncé. Ces tests ne concernent pas les règles du bazooka. Le dépôt du jeu n'a été ni committé ni publié.

Les **trois tests WebSocket réels** de `rpg-network.test.ts` confirment le tir et son acquittement, le stock, le même projectile pour tireur et témoin, l'explosion unique, les mutations reçues, l'arrivée pendant un transfert initial de plus de 12 000 éditions et la convergence avec le serveur. Ils confirment aussi le refus du RPG au médic suivi d'un soin de 10 PV, et le reset pendant un vol avec rejet d'une ancienne commande. Toutes les connexions de test sont fermées et vérifiées.

Le contrôle GPU dans le navigateur affiche **RÉSULTAT : SUCCÈS**, sans erreur ni avertissement console. Les six armes chargent ; les pixels du RPG au repos, en visée et avec recul, le vol jaune à 30 blocs/s, la fumée transparente, le brouillard, les impacts et le reset sont vérifiés. Les captures FPS du bazooka ont été inspectées. Les contrôles existants des grenades, AK/AWP, personnages, ragdolls, terrain, neige et ombres passent. Le parcours réel pseudo → lobby → assaut → déconnexion est vérifié sur le serveur local ; la capture de souris est refusée par le navigateur intégré, donc aucun ressenti clavier/souris n'est revendiqué.

Mesure locale avec 100 joueurs concentrés dans 18 × 18 blocs, 600 ticks actifs : 1 000 tirs RPG de 100 tireurs, 66 explosions, 505 éditions terrain, 400 projectiles au maximum, aucun input perdu. Temps de simulation et encodage p50 **0,765 ms**, p95 **1,326 ms**, p99 **2,139 ms**, maximum **8,237 ms**. Preuve : `.runtime/rpg-concentrated-load.json`. Ce test mesure le serveur simulé, pas 100 navigateurs ni une session Internet. La comparaison humaine avec le Java et le téléphone physique restent à faire.

## Impacts sur cadavres ×4 — 20 septembre 2026

Marc a choisi ×4 après le comparatif de huit prises : AK puis AWP, chacune en ×1/×2/×3/×4, trois impacts par prise. Les tirs AK/AWP confirmés font réagir le premier membre touché avec une impulsion de 48/80 au point d'impact et huit particules de sang. Les tirs mortels restent à 48/80.

La publication est préparée sur la base de production `e596fef`, avec les seuls changements ragdoll issus de `9a6816c` et `8df15b6`, adaptés aux types existants. Le serveur et le code partagé sont inchangés : protocole 3 conservé, sans les évolutions réseau stable-100.

Publication vérifiée le 20 septembre à 20:51 UTC : commit `d263001`, trois domaines et 51 ressources publics conformes, smoke Internet à deux joueurs réussi et parcours navigateur jusqu'à l'apparition puis la déconnexion. Aucun redémarrage serveur. Voir [la preuve de publication](deployment.md#publication-des-impacts-sur-cadavres-4--20-septembre-2026).

Sur ce portage, `bun run check` passe avec Bun 1.3.11 : TypeScript, **361 tests / 14 902 assertions dans 36 fichiers**, puis 11 sorties client. Le contrôle GPU affiche **RÉSULTAT : SUCCÈS**, sans avertissement ni erreur console : déplacements AK/AWP de 0,525 / 1,321 blocs à 0,2 s, huit particules au contact et sang rouge confirmé dans le framebuffer. Les tirs manqués ou arrêtés avant le corps restent exclus. Le journal est dans `.runtime/corpse-x4-release/.runtime/corpse-x4-release-check.log` depuis le dépôt principal. Ces contrôles automatisés complètent le choix visuel de Marc ; ils ne qualifient pas les performances sur téléphone physique.

## Ragdolls — 14 septembre 2026

Travail local, non publié. `bun run doctor`, TypeScript et `bun run build` passent (11 sorties de compilation). Les 312 tests hors outillage de publication passent, dont 28 nouveaux tests couvrant événements fatals, impulsion et couple, pose/interpolation, réapparition, collisions voxel et nettoyage. Le test `client-build.test.ts` a d'abord rencontré `EPERM` au lancement de Bun dans le bac à sable ; sa réexécution autorisée passe. Les deux fichiers `release-prepare.test.ts` et `release-vercel.test.ts` exécutent Git et sont exclus pour respecter la consigne de cette session ; `bun run check` complet n'est donc pas annoncé comme exécuté. Aucun Git ni déploiement.

Le harness GPU reconstruit depuis les sources finales affiche « RÉSULTAT : SUCCÈS » dans le navigateur. Les huit captures de `ragdoll-check.ts` montrent les deux directions d'impact à 0 / 0,1 / 0,3 / 1,5 seconde, avec les dix parties visibles puis le corps au sol. À 0,1 seconde, les centres des têtes se déplacent respectivement de −0,339 et +0,357 bloc sur X. Les contrôles existants de personnages, armes, projectiles, brouillard, neige et ombres passent aussi.

Mesure CPU locale Bun 1.3.11, sans rendu : seize ragdolls de dix parties issus de la pose réelle, impulsion de 20, six secondes simulées à 60 images/s. Dispersés de huit blocs : p50 3,65 ms/image, p95 5,57 ms ; concentrés à 0,15 bloc : p50 3,34 ms, p95 5,14 ms. La fusion des voxels pleins a été retenue après mesure d'une fixture de 160 boîtes : 928 corps Cannon et 6,83 ms/pas médian avant fusion, 176 corps et 1,85 ms après. Ce sont des mesures de calcul local, pas des résultats GPU, mobile, Internet ou de charge serveur à 100 joueurs.

Les tests physiques vérifient notamment une chute complète de six secondes sans coin de membre sous le sol au-delà de la tolérance de contact, des pivots séparés de moins de 0,025 bloc, la destruction du support sous des membres endormis, les escaliers, murs, voûtes, constructions et budgets. Les limites anatomiques et réseau sont décrites dans [personnages](player-reference.md#ragdolls). Les sensations dans une partie humaine multijoueur et le coût sur téléphone physique restent à vérifier.

## Reprise par de nouveaux agents et outillage — 13 septembre

`bun install --frozen-lockfile` confirme les dépendances sans modification ; `bun run doctor` confirme l'environnement de développement. **300 tests / 12 640 assertions**, TypeScript et compilation passent. Les nouveaux contrôles protègent les chemins/archives de release, l'immuabilité des snapshots, la gestion privée des identifiants, les cibles API et baselines Vercel. Le smoke générique traverse deux serveurs locaux TDM et FFA et ferme ses sessions.

Une préparation réelle produit 84 fichiers sources figés puis 11 sorties de build, relues avec leurs empreintes. Par rapport à la dernière production enregistrée, seul `package.json` diffère dans le manifeste client ; les sources serveur sont identiques. Les documents et outils ne font pas partie du bundle de jeu. Le nouveau `release:vercel status` a interrogé Vercel en lecture seule : les trois domaines correspondent à `dpl_46LahA4vFkaZ7uDxNmpqezN2KzM7`, READY.

Le banc `tests/release-server.sh` s'exécute sous WSL Debian dans un dossier temporaire avec Bun/systemd/curl simulés et de vrais fichiers, archives et empreintes. Il valide activation/rollback et leurs récupérations d'échec. Ces vérifications n'ont effectué ni nouveau déploiement, ni commande Git, ni modification du Java. Les identifiants restent externes au dépôt ; la publication complète par les nouvelles commandes reste à vérifier lors de leur première utilisation réelle. Guide : [reprise d'une session](agent-start.md), [publication](releasing.md). Preuve locale de préparation : `.runtime/agent-handoff/rehearsal.json`.

## Terrain Java et bâtiments — 13 septembre

Validation locale avant publication : TypeScript, build et **281 tests / 12 524 assertions** passent. Les hauteurs et formes des deux chênes sont comparées aux classes Java compilées. Les accès des ruines et hangars, escaliers, destructions, reset, compatibilité des versions et 100 apparitions au sol dans chaque mode sont couverts. Le banc de rendu réel a produit six captures inspectées, sans erreur navigateur ; 24 472 voxels échantillonnés sont identiques entre Bun, Edge desktop et le profil mobile. Aucun essai sur téléphone physique.

Une régression locale TDM de 16 secondes avec 100 clients WebSocket actifs mesure un tick p95 de 2,41 ms, p99 de 3,77 ms et maximum de 8,66 ms, sans erreur, tick abandonné ou input perdu. RSS finale 211 Mo ; débit reçu agrégé environ 295 Mbit/s. Elle ne remplace pas une nouvelle qualification Hetzner, un essai concentré prolongé ou 100 navigateurs. [Rapport](benchmarks/2026-09-13-terrain-tdm-100.json), [références et adaptations](terrain-generation.md). Le protocole 2 impose une publication coordonnée du serveur et du client.

La publication coordonnée a ensuite été effectuée. Sur Hetzner, **112 tests / 2 949 assertions** passent et l'empreinte des 24 472 voxels est identique aux profils locaux. Les 13 fichiers serveur/partagés actifs correspondent aux sources validées. Deux clients publics WSS ont partagé le monde et la manche, rejoint les équipes opposées et confirmé déplacement, visée et annulation. HTTPS/CORS et le refus du protocole 1 avant l'envoi du monde sont vérifiés. Les sessions de test sont fermées ; le service est actif sans redémarrage automatique relevé. Preuves : `.runtime/terrain-release/` et [publication](deployment.md#publication-du-terrain-java-et-des-bâtiments--13-septembre-2026).

Après publication, 50 ressources Vercel contrôlées correspondent au build local. Le vrai site public traverse pseudo → lobby → Assault dans Edge avec viewport tactile 844 × 390 ; relief enneigé, HUD, arme et minicarte sont inspectés. 52 snapshots et 119 intentions passent par le WebSocket Hetzner, sans erreur ni requête échouée. Joueur déconnecté et navigateur de test fermé. Preuves : `.runtime/terrain-release/browser/results.json` et `production-game.png`. Aucun essai supplémentaire sur téléphone physique.

## Arc compact mobile — 13 septembre

TypeScript, les 43 tests tactiles (192 assertions) et le build passent. La disposition du pouce droit a été inspectée sur 390 × 844, 844 × 390, 320 × 568 et 568 × 320. Les 136 vérifications navigateur passent sans avertissement ni erreur JavaScript, avec des contacts tactiles transmis par CDP et une capture gérée par Edge : boutons, glissement pendant le tir, visée, saut, libellés d'équipement et zones libres entre les boutons. Un test A/B confirme le correctif CSS de ciblage Chromium. Aucun essai sur téléphone physique n'a été réalisé pour cet arc. Détails et preuves : [contrôles mobiles](mobile-controls.md).

## Mobile — 12 septembre

### Itération à deux pouces

TypeScript, build et 265 tests passent (10 663 assertions ; le test de sous-processus du build a été repris séparément après `EPERM` du bac à sable). Les 43 tests tactiles comprennent la reconnaissance du double appui maintenu, l'ADS basculé, la conservation du joystick au changement d'arme et les annulations sans lancer de grenade.

Une suite navigateur Edge headless passe 27 contrôles sur le vrai client et le Worker solo avec deux contacts au maximum. Les intentions et événements réels confirment déplacement/caméra/tir simultanés, visée après relâchement, une grenade lancée et les annulations. Quatre formats mobiles ont été inspectés, sans erreur JavaScript. Il s'agit de gestes synthétiques avec capture émulée, pas d'un essai sur téléphone physique. Le tir automatique reste reporté. Détails et preuves : [contrôles à deux pouces](mobile-controls.md).

### Validation mobile initiale

`bun run check` passe avec 191 tests et 8908 assertions. Les dix tests tactiles couvrent joystick analogique, deadzone, sprint, captures indépendantes, visée et tir simultanés, pressions brèves, boutons désactivés, libération après changement d'arme et annulation sans relâchement artificiel.

Le navigateur a affiché l'accueil, le lobby et la partie aux formats 390 × 844 et 844 × 390, ainsi que les réglages à 320 × 568 et 568 × 320. Les trois choix d'équipement mesurent chacun 93 × 48 pixels à 320 pixels de large. Le retour des réglages est atteignable par défilement en paysage court. Un appui natif bref sur Tirer a consommé une munition. Le parcours desktop reste accessible avec les commandes tactiles masquées.

Un banc de test local émule le pointeur principal tactile et l'absence de l'API Pointer Lock, puis pilote le vrai client et son Worker solo. Ses 16 contrôles passent : déplacement autoritaire, déplacement/visée/tir simultanés, balles, saut/visée, changement d'arme, grenade annulée sans lancer, commande d'annulation transmise, grenade relâchée exactement une fois, commande de construction, scores, pause/reprise et perte de focus. Les gestes multi-doigts de ce banc utilisent des événements synthétiques et une capture simulée ; le rendu et les échanges avec la simulation sont réels. Aucun diagnostic JavaScript dans ces essais. Aucun code du banc de test n'est inclus dans la publication.

Limite : pas de téléphone iOS/Android physique disponible pour mesurer les performances, le clavier virtuel et le ressenti tactile. Les essais à dimensions mobiles sur la machine de développement ne remplacent pas cette validation matérielle.

## Maniement des armes et balles

Validation finale : `bun run check` passe avec TypeScript strict, 122 tests (7652 assertions) et compilation du client. Les transitions de boutons lors d'un changement d'arme sont testées côté serveur et vue FPS, notamment le relâchement de l'AK au moment de sélectionner la grenade.

Les règles de pose/cadence sont maintenant partagées entre client et serveur et issues des updates Java à 60 Hz. Les tests couvrent cadence AK8/AWP62, ordre du recul et du renouvellement des chargeurs, zoom, mouvement/souris, transitions entre armes, clics rapides, annulation de charge, soins et pelle. Les tirs transportent une origine/vitesse et un identifiant autoritaires ; des régressions vérifient le tir suivi d'un impact dans le même tick, l'expiration et la protection contre un canon traversant un mur. La trajectoire libre des grenades est comparée à 600 sous-pas de la formule Java.

Le harness WebGL passe 64 contrôles : il inclut désormais les balles jaunes (312 pixels RGB 255,255,0 pour un tir touchant avant la première image), leur disparition et leur déplacement sans nouveau snapshot. Les cinq modèles originaux ont été chargés, leurs pixels inspectés au repos, en visée/recul ou pendant l'action de l'outil ; les trois aperçus tournants et le retour à la vue FPS passent également. Les dix OBJ/MTL ont le même SHA256 que les assets Java. Le parcours accueil → lobby → Assault et le modèle en jeu ont été observés sans diagnostic JavaScript/WebGL. Les 385 fichiers du jeu original restent intacts.

Deux tests de 30 s avec 100 clients actifs sur une carte concentrée de 64 × 64 × 64 ont réussi, avec déplacements, tirs, outils, destructions et réapparitions. Le serveur FFA réinitialise la manche toutes les 10 s. Aucun client perdu, aucune erreur, aucun tick abandonné ni commande perdue ; TDM p95 1,53 ms / p99 1,76 ms / maximum 10,45 ms, FFA p95 3,00 ms / p99 4,31 ms / maximum 10,78 ms. RSS finale 187 Mo / 179 Mo. Les mesures partagent la même machine ; elles ne mesurent pas 100 rendus navigateur ni Internet. Rapports : [armes TDM](benchmarks/2026-09-11-weapons-tdm-100.json), [armes FFA et resets](benchmarks/2026-09-11-weapons-ffa-100.json).

La capture du pointeur reste refusée dans le navigateur intégré ; la sensation en contrôle libre n'est donc pas validée. La collision des grenades conserve le raycast voxel serveur plutôt que la boîte Java. L'animation et le son du tireur sont prédits ; les balles et leurs impacts sont affichés à partir des événements serveur. Les écarts explicites sont détaillés dans [la référence gameplay](gameplay-client.md).

## Vérifications exécutées

Correction du build Vercel et ajout du solo : `bun run check` passe avec 181 tests et 8849 assertions. Le build réel est testé dans un répertoire isolé avec adresse absente, vide, HTTPS, HTTP et chemin invalide. L'absence d'adresse sur Vercel active maintenant le solo ; une adresse fournie invalide reste refusée. Un vrai Worker Bun vérifie pseudo → lobby → apparition, mouvement, tirs AK47 et destruction d'un bloc, monde neuf à la session suivante et suspension/reprise des ticks. Le nettoyage de l'adaptateur et les anciens callbacks sont également testés. La simulation déplacée dans `src/shared/game.ts` est identique à l'ancienne, à l'exception des chemins d'import.

Dans un navigateur réel, le build Vercel sans serveur a permis d'entrer en solo, d'afficher le HUD/arme/minicarte et de revenir au lobby d'une nouvelle partie, sans requête `/api/status` ni WebSocket. Les trois pannes HTTP indisponible, WebSocket refusé et WebSocket ouvert mais muet conduisent au lobby solo. Avec le vrai serveur Bun disponible, le même client a rejoint le lobby puis une partie TDM avec équipement Sniper, sans diagnostic JavaScript. Le navigateur intégré refuse toujours la capture du pointeur : les tirs et déplacements sont validés par le test Worker, pas par un contrôle FPS libre dans ce navigateur. Le build local a été restauré après ces essais.

Préparation initiale Vercel + serveur Bun séparé : 176 tests et 8804 assertions validaient les adresses client HTTP/WSS, les origines autorisées et refusées, HTTP et les upgrades WebSocket. Un navigateur réel avait rejoint le lobby depuis un client statique sur le port 3013 vers le serveur Bun sur le port 3012 sans erreur CORS/JavaScript. Les 385 fichiers Java avaient été vérifiés intacts. Le Dockerfile est fourni, mais l'image n'a pas été construite faute de Docker local ; l'hébergement multijoueur permanent reste à fournir.

Après suppression du délai de lancer local : `bun run check` passe avec 151 tests, 8594 assertions et compilation du client. La grenade est prédite dès le tick de relâchement avec les règles de lancement et de vol désormais partagées avec le serveur. Les tests vérifient des confirmations à 0/50/150/300 ms, l'absence de duplication et de saut lors des corrections, les murs, le refus d'un lancer, la mort/réapparition, les réservations de stock, la saturation du rendu et le reset. Le vol reste indépendant du rendu à 30/60/144 Hz. Les règles de collision, de charge et de détonation serveur sont préservées ; aucun champ réseau supplémentaire n'est nécessaire.

Le harness passe 81 contrôles GPU, dont cinq nouveaux : modèle visible sans aucun message réseau, mouvement avant la réponse à 120 ms, même matrice et mêmes pixels au moment de la confirmation malgré une correction d'origine/vitesse, reset et refus. Captures inspectées sans diagnostic JavaScript/WebGL. Les 385 fichiers Java restent intacts. La vérification couvre le code de rendu et une latence simulée ; aucun nouvel essai Internet ni contrôle FPS libre dans le navigateur intégré n'est revendiqué.

La simulation serveur partagée a également tenu 100 clients actifs pendant 30 s en TDM sur 64 × 64 × 64 : aucune erreur, déconnexion, commande perdue ou tick abandonné. Temps de tick p95 1,81 ms / p99 2,31 ms / maximum 20,56 ms, RSS finale 194 Mio. Serveur et bots partagent la machine ; ce test ne mesure pas 100 rendus navigateur. Rapport : [prédiction de grenade, 100 clients](benchmarks/2026-09-11-grenade-prediction-tdm-100.json).

Après remplacement du bloc de grenade et interpolation du vol : `bun run check` passe avec 137 tests et 7795 assertions. Les onze tests de présentation grenade couvrent la géométrie/palette originale, l'échelle 1/16, le mouvement entre snapshots, l'équivalence à 30/60/144 Hz, la gigue, les rebonds, l'identité des projectiles, l'explosion, le reset et le chargement différé. Un cas exerce 100 grenades dans une seule géométrie instanciée. La récupération après une pause serveur de 200 ms évite de perdre définitivement l'interpolation ; les données reprenant après une interruption plus longue peuvent aussi restaurer les grenades encore présentes côté serveur.

Le harness passe 76 contrôles GPU, dont six pour les grenades : vrais OBJ/MTL, 352 pixels verts et 121 gris, instances séparées, explosion/reset, brouillard RGB 221/232/255 et centres X 50,7 → 76,3 → 101,9 sur trois images à 60 Hz sans nouveau snapshot. Captures inspectées, aucun diagnostic WebGL/JavaScript. Les 385 fichiers Java sont intacts. Physique et protocole serveur inchangés ; le cas de 100 instances ne constitue pas un nouveau test réseau de 100 joueurs. Le tampon de 100 ms retarde l'affichage pour interpoler les positions confirmées ; une interruption prolongée suspend ce mouvement. Aucun nouvel essai Internet ou pilotage FPS libre n'est revendiqué.

Après calibration des points de tir sur les extrémités de canon OBJ : `bun run check` passe avec 126 tests et 7716 assertions. Les quatre nouveaux tests d'alignement échouaient avant correction (écarts mesurés AK 1,79996 / AWP 1,53460 blocs) et passent après correction, avec rotations caméra, visée, déplacement et recul. Deux régressions supplémentaires protègent le joueur situé entre l'œil et le canon ; les impacts contre un mur proche restent validés. Le harness GPU passe 70 contrôles, dont six comparaisons de balles contre le centre du canon dérivé des vrais OBJ : aucun pixel de différence pour AK/AWP au repos, en visée ou pendant le recul. Les captures composites ont été inspectées, sans diagnostic JavaScript/WebGL. Les 385 fichiers Java sont intacts. Le contrôle ne mesure pas le ressenti sous latence réseau.

La même version a maintenu 100 clients TDM actifs pendant 30 s sur une carte 64 × 64 × 64 : aucune erreur ni déconnexion, aucun tick abandonné ni commande perdue, p95 1,47 ms / p99 1,81 ms / maximum 11,76 ms, RSS finale 170 Mo. Serveur et bots partagent la machine ; aucun rendu de 100 navigateurs ni trajet Internet n'est mesuré. Rapport : [calibration du canon, 100 clients](benchmarks/2026-09-11-muzzle-tdm-100.json).

- Après correction des couleurs et options graphiques : TypeScript strict, 77 tests automatisés (6632 assertions) et compilation du client via `bun run check` : tout passe.
- Après remplacement des ombres par le CSM Three.js : `bun run check` passe avec 83 tests (7285 assertions). Les six nouveaux tests couvrent les quatre tranches de caméra sous plusieurs FOV/formats, la précision près du joueur, la limite de texture du GPU, la stabilisation en espace lumière et la libération/réactivation des cartes.
- Après doublement de la résolution et éclairage directionnel des faces : `bun run check` passe avec 83 tests (7334 assertions). Chaque cascade gagne un facteur deux de précision linéaire, sans changer sa couverture ; les limites de texture 1024/2048/4096/8192 sont exercées. Le test du mesher vérifie un RGB identique sur les six normales avant éclairage, et la conservation de l'occlusion ambiante.
- Tests de mouvement, collisions, raycast, génération déterministe, éviction de cache, dégâts, maillages et rejet des résultats worker périmés.
- Tests d'autorité, admission de 100 joueurs et refus du 101e, équipes, FFA, kits, cadence, impacts, grenades, soins, construction, mort et réapparition.
- Tests des commandes invalides, séquences, réception du terrain pendant ses mutations, reset et commandes d'anciennes manches.
- Tests de transport HTTP/WebSocket réels, snapshots binaires, plusieurs clients, abonnement aux diffusions après reset et limites d'envoi.
- Vérification dans le navigateur intégré : panorama voxel, pseudo, connexion, lobby, changement de kit avec modèles OBJ/MTL, apparition, HUD et menu. Aucun avertissement ni erreur JavaScript relevé sur ce parcours.
- Démarrage du mode développement et réponse HTTP de son serveur.
- Comparaison SHA256 de 385 fichiers source et ressources du Java : aucun changement.

La reprise de l'interface ajoute les tests des palettes OBJ/MTL, des faces colorées superposées et de la projection/RGB de la minicarte. Le parcours navigateur a été refait avec la police Riffic originale, les boutons Java, le fond du lobby, ses trois aperçus tournants, l'apparition directe Assault/Medic, le HUD et les panneaux Options/Graphics. Les couleurs rétablies ont été observées sur les aperçus et sur la trousse en jeu. La case SSAA a bien doublé la largeur du buffer de rendu (1284 → 2568 pixels pour une fenêtre de 856 pixels CSS), puis a été rétablie. Aucun avertissement ni erreur JavaScript relevé après correction. Voir [les références et adaptations de l'interface](ui-reference.md).

Neuf contrôles GPU supplémentaires ont passé via `bun scripts/visual-check.ts` : RGB terrain (31,153,31 pour (.1,.5,.1) ×1,2), indépendance des lampes, brouillard (221,232,255), particules (83,166,249 pour (.25,.5,.75) ×1,3), brouillard particules, 432 pixels d'ombre atténués de moitié, rétablissement exact à la désactivation, shader neige et activation/désactivation de son pool. Ces contrôles lisent les pixels WebGL et sont distincts des tests Bun.

Dans le jeu, les motifs parasites d'auto-ombrage observés sur les faces verticales ont disparu après adaptation du biais à la résolution de la shadowmap. Neige visible, disparition à la désactivation, SSAA (largeur 1372 → 2745 pour 915 pixels CSS, arrondi du DPR 1,5) et persistance des trois cases après rechargement ont été vérifiés. Aucun avertissement ni erreur JavaScript relevé après correction. La case vSync explique la limitation du navigateur.

Le contrôle GPU a ensuite été étendu à 20 vérifications, toutes réussies avec les ombres CSM. Une dalle et un cube utilisent le shader terrain et les mêmes quatre projections que le jeu. Lecture des pixels sans antialiasing : uniquement 122 (éclairé) ou 61 (ombre), aucune valeur de flou ou de double assombrissement. Les quatre cascades produisent respectivement 457, 816, 867 et 860 pixels ombragés dans les vues témoins ; la dalle seule reste éclairée sans acné. Les témoins passent de part et d'autre des coupures 10/30/72, à la fin de portée 144, après déplacement du cube et de la caméra, après changement de FOV/format et après désactivation/réactivation (image strictement identique). Les contrôles de couleur, brouillard et neige restent valides.

Dans le navigateur du jeu : accueil, lobby, apparition et activation/désactivation des ombres vérifiés. Aucun nouveau diagnostic JavaScript/WebGL après correction du shader. La première cascade couvre un texel de 0,01556 bloc à FOV 76° et format 16:9, contre 0,09375 auparavant, soit environ six fois plus de précision linéaire. La stabilisation sous déplacements inférieurs au texel est vérifiée sur les matrices ; le pilotage FPS libre reste limité par le refus de capture du pointeur du navigateur intégré. Les quatre passes de profondeur augmentent le coût GPU ; aucune mesure de charge graphique avec 100 avatars n'a été réalisée. La comparaison des 385 fichiers Java a été répétée : aucun changement.

La version suivante passe à quatre cartes 4096 × 4096 : le texel de proximité mesure désormais 0,00778 bloc au même FOV/format. Les contrôles GPU ont été adaptés au nouvel éclairage et passent tous, soit 30 vérifications. Pour un RGB brut gris de 0,4 : face normale au soleil 122, dessus du bloc 106, face latérale exposée 91, face opposée ou rasante 61. Ces valeurs sont vérifiées sans aucun objet projetant une ombre, avec caméra oblique et inversion de la direction solaire. Une face dos au soleil reste à 61 avec les ombres portées activées comme désactivées : l'ambiant n'est jamais assombri deux fois. Les quatre cascades, raccords, déplacement du bloc, changement de projection et réactivation restent valides ; la dalle seule ne présente pas d'acné. Palette, brouillard, particules et neige passent également. Le jeu a été rechargé, rejoint et contrôlé avec les ombres OFF/ON, sans diagnostic JavaScript/WebGL. Les 385 fichiers Java sont toujours intacts. Les cartes demandent quatre fois plus de texels que les cascades 2048 ; ce contrôle ne constitue pas une mesure de performance graphique en partie chargée.

Un nouveau test TDM sur un serveur de test séparé, avec la palette et les impacts corrigés, a maintenu 100 clients actifs pendant 30 s : zéro erreur, zéro tick abandonné, zéro commande perdue, tick p95 1,83 ms / p99 2,90 ms / maximum 12,02 ms, RSS finale 180 Mo. Le navigateur du jeu était utilisé en parallèle sur cette machine. Rapport : [couleurs et événements, 100 clients](benchmarks/2026-09-11-colors-tdm-100.json). Les comparaisons TDM/FFA ci-dessous restent celles de la première livraison.

La capture du pointeur a été refusée par le navigateur intégré, y compris après un clic sur Reprendre. Le pilotage libre et les sensations FPS doivent donc encore être essayés dans Chrome, Firefox ou Edge. L'interface explique désormais ce refus. Les combats et déplacements ont été exercés par les clients de charge et les tests serveur, ce qui ne remplace pas cette validation humaine.

## Machine et protocole de mesure

Windows, version système 10.0.22631 ; AMD Ryzen 7 5800X, 8 cœurs / 16 processeurs logiques ; environ 32 Gio de RAM ; Bun 1.3.11.

Le serveur et les 100 clients de charge partagent cette machine. Les échanges passent réellement par HTTP/WebSocket sur localhost. Les clients se déplacent, tirent, creusent/construisent, lancent des grenades et réapparaissent après leur mort. Un navigateur réel affichait parallèlement une autre instance locale.

Les percentiles concernent les 1024 derniers ticks à la fin du test, soit environ 17 secondes à 60 Hz. Le maximum et les retards sont cumulés depuis le démarrage du processus. Les durées ci-dessous correspondent à la phase active demandée ; les rapports incluent aussi environ 1,6 seconde de connexion/initialisation des clients. Ce protocole est un premier contrôle de capacité, pas un essai de stabilité de 30 minutes.

## Résultats après optimisation

| Mesure | TDM, 256 × 64 × 256 | FFA concentré, 64 × 48 × 64 |
|---|---:|---:|
| Clients connectés en fin d'essai | 100 / 100 | 100 / 100 |
| Durée active demandée | 30 s | 60 s |
| Temps de tick p50 | 0,81 ms | 0,53 ms |
| Temps de tick p95 | 2,26 ms | 1,79 ms |
| Temps de tick p99 | 3,21 ms | 2,31 ms |
| Temps de tick maximal | 10,03 ms | 9,01 ms |
| Ticks abandonnés pour retard | 0 | 0 |
| Commandes perdues par saturation | 0 | 0 |
| Erreurs des clients | 0 | 0 |
| RSS serveur à la fin | 187 Mo | 166 Mo |
| Données reçues cumulées par les clients | 1,040 Go | 1,544 Go |
| Politique de reset | Désactivé | Toutes les 20 s, manche 4 atteinte |

Le test TDM inclut le profilage CPU ; le test FFA est exécuté sans profileur. Les valeurs mémoire et trafic utilisent les unités décimales. Les instantanés de files d'inputs sont respectivement 0 et 270 commandes ; dans le second cas, cela représente environ un lot de trois commandes par joueur vivant, sans perte ni retard observés.

Rapports complets : [TDM](benchmarks/2026-09-11-tdm-100.json), [FFA](benchmarks/2026-09-11-ffa-100.json).

Le budget de 16,67 ms par tick est respecté dans ces deux essais. Le débit reste élevé : environ 263 Mbit/s agrégés pour le TDM et 201 Mbit/s pour le FFA, calculés sur les durées totales des rapports, hors en-têtes transport. La diffusion de toutes les entités à tous les joueurs et les événements JSON sont des axes de réduction avant une mise en ligne large.

## Corrections guidées par les mesures

Le premier protocole JSON avait transféré environ 4,5 Go en 30 secondes avec 100 clients. Les snapshots fréquents ont été convertis en binaire et les snapshots de réapparition envoyés uniquement au joueur concerné.

Le profilage suivant a attribué environ 44,8 % du temps CPU échantillonné aux appels natifs d'envoi. Le serveur répétait les mêmes événements par connexion. La diffusion native Bun remplace ces appels répétés ; l'abonnement est activé après synchronisation du terrain et retiré au reset ou au départ. Le même scénario profilé est passé d'un tick p99 de 32,12 ms à 3,21 ms, avec suppression des retards observés.

Les fonctions voxel représentaient une faible part de ce profil ; leur code n'a pas été modifié pour cette optimisation réseau.

## Limites restantes

- Pas de validation avec 100 navigateurs, de mesure GPU fiable, de test prolongé sur machines distinctes ou de réseau dégradé.
- Pas encore de compensation historique des tirs. La correction visuelle du déplacement et l'interpolation sont implémentées, mais la qualité ressentie sous latence reste à évaluer.
- Cartes configurables jusqu'à 2048 blocs de côté ; ces dimensions maximales n'ont pas été soumises à cette charge ni validées graphiquement. La distance d'affichage actuelle est limitée à 256 blocs, sans niveau de détail lointain.
- Révision globale du terrain, différences conservées en mémoire pendant la manche et synchronisation complète des différences avant l'apparition. Le coût d'un terrain longtemps modifié reste à mesurer.
- Serveur permanent Hetzner installé le 12 septembre 2026 (validation ci-dessous) ; aucune simulation distribuée ni effondrement structurel.

Les trois arbitrages produit déjà ouverts restent la fin de manche, le matériel cible et le sens du scaling futur. Ils n'empêchent pas l'utilisation de cette version locale.

## Hôte Hetzner — 12 septembre 2026

Debian 13, deux vCPU AMD EPYC Rome, 3,7 Gio de RAM utilisable, Bun 1.3.11. Les 65 tests existants de simulation serveur, cycle de partie, transport, origines, protocole binaire et déplacement passent sur cet hôte : 450 assertions, zéro échec. Le démarrage et le redémarrage du service système ont été vérifiés ; il tourne sous l'utilisateur `ubercube`, écoute uniquement sur `127.0.0.1:3000` et est activé au démarrage. Caddy 2.11.4 expose les ports publics 80/443 ; la redirection HTTP vers HTTPS a été vérifiée depuis une autre machine.

Après ajout du DNS chez OVH, `game.ubercube.io` résout vers `2.29.30.129`. Le contrôle public HTTPS/WSS passe avec vérification du certificat, CORS exact et refus des origines inconnues. Deux clients distincts ont reçu le même monde et la même manche, rejoint les équipes TDM opposées et vu les deux avatars dans leurs snapshots. Le serveur a acquitté 36 commandes de déplacement (4,37 blocs horizontaux) et le ping, sans erreur. La fermeture des clients rétablit le compteur de joueurs à zéro. Ce contrôle traverse Internet et Caddy ; il ne remplace pas les mesures de charge ni un essai de sensations sous latence.

Le parcours public `www.ubercube.io` a également été exécuté dans le navigateur : pseudo → lobby → kit Assault → partie TDM. Le compteur distant passe de zéro à un joueur puis revient à zéro après déconnexion ; il s'agit bien du serveur Hetzner. Terrain, arme, minimap, HUD rouge/bleu, 100 HP et 30/30 munitions sont visibles, sans erreur JavaScript relevée. Le navigateur intégré refuse toujours la capture de la souris ; ce contrôle valide l'arrivée en jeu et le rendu, pas le pilotage FPS libre.

Deux tests actifs utilisent une instance temporaire sur `127.0.0.1:3001`, distincte du monde public. Le générateur de charge fonctionne sur le même VPS. Les instances temporaires ont été arrêtées après mesure.

| Mesure | TDM, 256 × 64 × 256 | FFA concentré, 64 × 48 × 64 |
|---|---:|---:|
| Clients connectés en fin d'essai | 100 / 100 | 100 / 100 |
| Durée active | 30 s | 60 s |
| Tick p95 / p99 | 3,74 / 5,56 ms | 2,43 / 3,67 ms |
| Tick maximal | 44,44 ms | 26,49 ms |
| Ticks abandonnés / commandes perdues | 0 / 0 | 0 / 0 |
| Erreurs clients | 0 | 0 |
| RSS finale | 103 Mo | 100 Mo |
| Données reçues cumulées | 1,12 Go | 2,09 Go |
| Manche finale | 1 | 4, reset toutes les 20 s |

Rapports : [Hetzner TDM](benchmarks/2026-09-12-hetzner-tdm-100.json), [Hetzner FFA](benchmarks/2026-09-12-hetzner-ffa-100.json). Déplacements, tirs, grenades, modifications du terrain et réapparitions sont actifs. Le FFA traverse trois resets. Les percentiles passent sous 16,67 ms, mais les maxima dépassent ponctuellement ce budget ; aucun tick n'a été abandonné. Le débit agrégé reste élevé, environ 293 et 276 Mbit/s hors en-têtes. Ces essais courts sur loopback ne valident ni le débit Internet disponible, ni 100 appareils mobiles, ni une stabilité prolongée.

## Retard entre joueurs et personnages Java — 12 septembre 2026

Diagnostic Internet sur le serveur existant : deux clients WSS, RTT médian 42,4 ms, snapshots espacés d'environ 50,6 ms, aucun tick abandonné ni saturation CPU. Un essai contrôlé de 1 200 intentions sur 20 s par variante mesure la génération locale → réception par l'observateur : médiane 124,83 ms en lots de trois, 93,36 ms en envoi immédiat ; p95 148,31 → 117,43 ms. Cette comparaison traverse Internet mais exclut le rendu navigateur. Les sessions successives, phases des snapshots et timers Windows empêchent d'en déduire un gain universel exact. Le code public n'a pas été modifié pendant ces mesures.

La simulation réelle a ensuite reproduit la file de commandes sous un transport ordonné : 25 ms de latence aller, 60 intentions/s et une pointe unique de 100 ms. Avant correction, six intentions restaient en attente et l'âge de l'intention appliquée restait à 133,33 ms, même 17 s après la pointe. Après regroupement des intentions identiques déjà maintenues, la file revient à zéro et l'âge à 33,33 ms. Les pointes de 50 et 150 ms sont également résorbées, sans rejet. Il s'agit d'un transport simulé déterministe autour du vrai `GameServer`, pas d'une nouvelle mesure du serveur déployé.

Le client envoie maintenant les commandes dès l'image qui les produit. Dix tests d'interpolation couvrent les cadences 30/60/144 Hz, gigue, reprise, rotations, état discret des poses, mort, réapparition et reset : tampon stable réduit de 100 à 50 ms, 70 ms dans le scénario alternant 20 ms de gigue, sans recul du temps ni extrapolation. Dix-sept tests de file serveur protègent les transitions, séquences de lancer, annulations, charge, cadences, saut, soins et construction. La visée distante est validée côté serveur et transmise dans un bit existant des snapshots.

Les personnages utilisent le squelette actif Java, sa palette et les cinq OBJ/MTL originaux. Douze tests de présentation et une comparaison exécutée sur les classes Java compilées valident 135 poses et 25 650 coefficients : erreur maximale `2,831 × 10⁻⁷`. Huit contrôles GPU supplémentaires passent, avec six captures inspectées et aucun diagnostic WebGL. Références et limites du rendu : [personnages Java](player-reference.md). Les 385 fichiers Java comparés par SHA256 sont inchangés.

`bun run check` passe : **232 tests, 10 530 assertions**, TypeScript et compilation client réussis. Le contrôle mobile dans le navigateur repasse ses 16 étapes, y compris déplacement/tir simultanés, visée, annulation sans lancer, lancer unique, construction et pause. Pas d'erreur JavaScript ; ce contrôle émule les gestes tactiles et ne remplace pas un téléphone physique.

Le générateur de charge utilise désormais le temps écoulé pour produire réellement 60 intentions/s et les envoie immédiatement ; son ancien intervalle fixe de 50 ms pouvait sous-alimenter le serveur sous Windows. Deux essais locaux distincts de 30 s, 100 joueurs actifs sur une carte 64 × 64 × 64, ont été exécutés après correction :

| Mesure | TDM | FFA, reset toutes les 10 s |
|---|---:|---:|
| Intentions/s par joueur vivant | 59,89 | 59,84 |
| Messages d'entrée/s cumulés | 5 368 | 5 191 |
| Tick p95 / p99 | 1,54 / 2,03 ms | 2,96 / 4,37 ms |
| Tick maximal | 11,33 ms | 11,79 ms |
| Ticks abandonnés / commandes rejetées / erreurs | 0 / 0 / 0 | 0 / 0 / 0 |
| Débit sortant cumulé | 269 Mbit/s | 336 Mbit/s |

Déplacements, tirs, grenades, terrain et réapparitions actifs ; trois resets traversés en FFA. Rapports : [TDM](benchmarks/2026-09-12-immediate-inputs-tdm-100.json), [FFA](benchmarks/2026-09-12-immediate-inputs-ffa-100.json). Serveur et générateur partagent la machine Windows ; ce n'est ni une mesure Hetzner avec le nouveau code, ni le rendu de 100 navigateurs. Les instances de test ont été arrêtées. Le débit reste élevé et la compensation historique des impacts reste absente. La publication et les vérifications Internet suivantes ont ensuite été effectuées.

## Vérification après publication réseau/personnages

Le serveur corrigé a été déployé sur Hetzner à 09:47:21 UTC et le client local sur Vercel (`dpl_ALaZHSS76TZsitQMbcSHWAVT994Y`, READY, alias `www.ubercube.io`). 84 tests de simulation, cycle de vie, transport, origines, mouvement, files d'input et protocole passent sur Linux : 565 assertions. Les hashes des sources actives correspondent aux fichiers validés localement.

Deux clients Internet ont confirmé HTTPS et CORS, refus des origines inconnues, identités distinctes, équipes opposées, monde partagé, déplacement acquitté et ping. Le nouveau flag de visée et son annulation ont été observés dans les snapshots des deux clients. Leur fermeture restaure le compteur à zéro.

Une nouvelle mesure de 20 s avec 1 199 intentions (59,95/s) donne une médiane génération → réception par l'observateur de **66,66 ms**, p95 **88,12 ms**, contre 124,83/148,31 ms dans l'essai initial en lots de trois. RTT environ 42,3 ms, snapshots environ 50,6 ms et pas de trois ticks, aucune erreur, aucun tick abandonné ni input rejeté. Cette mesure exclut le rendu/interpolation navigateur ; les phases réseau et timers varient entre essais. Ce n'est pas une garantie de latence pour tous les joueurs. [Rapport après déploiement](benchmarks/2026-09-12-production-network-correction.json).

Le client de production rechargé a rejoint le lobby puis la partie TDM, affiché le HUD et les équipements, sans diagnostic JavaScript/WebGL. Le compteur de joueurs Hetzner passe de zéro à un puis revient à zéro à la déconnexion. Le navigateur intégré refuse toujours le verrouillage du pointeur ; cette vérification ne constitue pas une session de jeu libre à la souris. Aucun nouveau test de charge de 100 joueurs Internet n'est revendiqué.

## Reprise du dépôt et provenance Git — 13 septembre 2026

Les fonctionnalités restées locales ont été réparties en commits réseau/personnages, mobile, SEO, audio et terrain, sans réécriture des quatre commits publiés. Les arbres indexés réseau et mobile passent respectivement 232 et 265 tests, TypeScript et le build ; le snapshot SEO compile ; l'arbre terrain complet, incluant la correction audio, passe 281 tests et le build.

Après ajout des guides et outils durables, `bun run check` passe : **305 tests, 12 675 assertions**, TypeScript et build client (11 fichiers). Les 21 tests de publication utilisent des dépôts Git temporaires et une API Vercel simulée ; ils couvrent notamment arbre sale, commit absent du distant, divergence CRLF, empreintes, provenance Git et vérification d'un build automatique sans staging local. `bun run doctor` confirme les prérequis présents. Une première exécution confinée a bloqué les sous-processus Bun/Git (`EPERM`) ; la même suite passe avec les permissions de sous-processus adaptées, sans neutraliser de test.

Le banc Linux isolé de `tests/release-server.sh` a également passé ses sept scénarios sous WSL Debian : staging, archive corrompue, tests en échec, activation, rollback et restauration après échec d'activation ou de rollback. Ces contrôles ne redéploient pas Hetzner et ne constituent pas un nouvel essai de charge ou de rendu. Les preuves détaillées de nettoyage restent dans `.runtime/history-cleanup/`; une publication réelle doit encore être vérifiée par son SHA Vercel et ses ressources publiques.

La vérification réelle du déploiement Git a ensuite exposé une différence limitée au `debugId` final de source map de `main.js` ; les 49 autres ressources publiques sont identiques. Le correctif du vérificateur ignore uniquement cette valeur, conserve les empreintes brutes et rejette les changements exécutables, les URLs différentes, les métadonnées mal placées et les octets invalides divergents. Le contrôle live passe sur les 50 ressources et le smoke WSS à deux joueurs passe. Après ce correctif, **306 tests et 12 693 assertions**, TypeScript et build client passent. Voir [la preuve datée de publication Git](deployment.md#retour-aux-publications-git--13-septembre-2026).

## Hitscan AK-47 / AWP — 14 septembre 2026

Implémentation locale non publiée, protocole 3. Les tirs sont résolus au même tick après les déplacements, avec arrêt au premier joueur ou bloc, protection du canon et impulsions ragdoll conservées. Le client affiche le segment confirmé pendant 60 ms ; les grenades gardent leur simulation. Les paramètres de pose, cadence, dégâts et headshot restent ceux de la version précédente.

`bun run doctor`, `bun run typecheck` et `bun run build` passent (11 sorties client). Les 33 fichiers de tests exécutés passent : **326 tests, 14 227 assertions**. La commande complète `bun run check` n'a pas été lancée : les deux suites de publication `release-prepare.test.ts` et `release-vercel.test.ts` utilisent Git, exclu par la consigne de cette tâche. Tous les autres fichiers `*.test.ts` sont inclus. Le premier passage a rencontré un `EPERM` sur le sous-processus Bun du test de build ; la même sélection complète passe après autorisation des sous-processus, sans modifier les tests.

Les tests protègent les impacts à 100 blocs dans le tick du tir, les tirs manqués bornés, le premier obstacle et le canon proche, les mouvements des cibles dans les deux ordres de connexion, les ripostes mortelles simultanées, les cadences/munitions, le refus des commandes périmées ou invalides, les snapshots sans balles et le transport JSON des extrémités. Les tests de mort valident le point, l'impulsion, la copie de pose et la réapparition indépendante ; les autres tests de ragdoll et de grenade restent inclus.

Le harness WebGL local affiche **RÉSULTAT : SUCCÈS**, sans avertissement ni erreur console. Les contrôles hitscan vérifient le segment complet jaune dès le tir, l'impact du même tick, la disparition après la durée cosmétique et un tir manqué immobile sans snapshot. Les six contrôles de canon ne trouvent aucun pixel différent de la référence au départ du canon OBJ ; leurs captures ont été inspectées. Les contrôles de grenades, personnages et ragdolls passent également.

Deux essais de charge WebSocket locaux de 30 s avec 100 joueurs actifs sur une carte 64 × 64 × 64 :

| Mesure | TDM sans reset | FFA, reset toutes les 10 s |
|---|---:|---:|
| Joueurs connectés | 100 | 100 |
| Intentions/s par joueur vivant | 59,90 | 59,81 |
| Tick p95 / p99 | 1,10 / 1,71 ms | 1,82 / 4,04 ms |
| Tick maximal depuis le lancement | 12,30 ms | 11,92 ms |
| Ticks abandonnés / commandes rejetées / erreurs | 0 / 0 / 0 | 0 / 0 / 0 |

Rapports : [TDM](benchmarks/2026-09-14-hitscan-tdm-100.json), [FFA](benchmarks/2026-09-14-hitscan-ffa-100.json). Déplacements, tirs, dégâts, mutations du terrain et réapparitions ont produit des événements ; le scénario TDM sans reset a aussi conservé 43 grenades actives au relevé final. Les joueurs sont revenus à zéro après fermeture des clients ; les serveurs locaux de jeu et du harness ont été arrêtés. Serveur et générateur partagent la machine Windows ; ces essais courts sur petite carte ne valident ni Internet, ni 100 navigateurs, ni le coût maximal sur les grandes cartes.

Fichiers de code concernés : `src/shared/game.ts`, `src/shared/protocol.ts`, `src/client/bullet-visuals.ts`, `src/client/presentation.ts`. Tests adaptés : `server`, `death-events`, `wire`, `bullets` et les harnesses navigateur `bullets-check` / `muzzle-check`. README et guides gameplay, réseau, démarrage et ragdoll actualisés. Aucune commande Git ni publication ; les empreintes `ops/` restent celles de la production enregistrée.

Limites : le hitscan supprime le temps de vol, sans compensation historique du réseau. Direction du canon, dispersion et AABB existantes conservées ; aucun recentrage automatique sur le viseur. Les sensations en partie avec plusieurs joueurs humains et sur téléphone physique restent à vérifier. La prochaine publication devra associer client et serveur du protocole 3.

## Accès SSH et sudo des agents — 15 septembre 2026

TypeScript passe après ajout de `doctor --server`. Le banc WSL Debian `tests/release-server.sh` passe : contrôle privilégié sans mutation, refus des arguments supplémentaires, d'un appel non root, d'un service inactif ou configuré sous root, vérification de l'empreinte du script installé, staging, archives corrompues, échecs de tests, activation/rollback et restauration après échec. Les actions de service sont simulées dans le banc, les fichiers et permissions sont réels.

Sur le vrai serveur, deux sessions indépendantes, dont un autre agent, confirment la connexion par clé et le sudo limité sans mot de passe. `bun run doctor --server` renvoie `readyToDeployServer: true`. SCP fonctionne et une commande sudo générale reste refusée sans mot de passe. Le PID et la date de démarrage du jeu sont inchangés. Aucun Git, déploiement applicatif, essai de charge ou nouveau test de gameplay n'a été exécuté pour ce correctif d'accès. La suite complète Bun comprend des fixtures Git ; elle n'a pas été relancée dans ce périmètre sans opération Git. Les preuves d'accès locales sont dans `.runtime/server-access/`.

## Publication hitscan et ragdolls — 15 septembre 2026

La publication autorisée a ensuite été réalisée depuis `d7266822b0c5052e94492eb864d3032819a4af76`, incluant les changements de combat et les accès validés. `bun run check` complet passe : TypeScript, **348 tests / 14 388 assertions**, puis build client. Le banc shell WSL passe et le staging réel Hetzner valide **126 tests / 3 026 assertions** avant activation.

Les 13 fichiers serveur actifs correspondent au snapshot et le protocole 3 est confirmé. Le build promu puis le build automatique de `main` passent chacun la vérification du SHA GitHub, des trois domaines et des **51 ressources publiques**. Le smoke distant à deux joueurs passe ; aucun test de charge n'a été lancé sur la production. Le parcours navigateur jusqu'à l'apparition et la déconnexion fonctionne, terrain/arme/HUD/minicarte visibles, console sans erreur ni avertissement. La capture souris refusée par le navigateur intégré limite ce contrôle au parcours et au rendu : aucun nouvel essai de maniement ou de combat humain n'est revendiqué. Les sessions temporaires sont fermées. Voir [les identifiants et preuves de publication](deployment.md#publication-du-hitscan-et-des-ragdolls--15-septembre-2026).

## Revue vidéo et impulsions ×4 — 15 septembre 2026

Marc a approuvé ×4 après douze prises à vitesse réelle : AK au torse, AK à la tête et AWP au torse, chacun en ×1/×2/×4/×8. La comparaison conserve cible immobile, caméra, point touché et direction ; la cible du banc commence à 1 PV pour un seul impact mortel. Le client reçoit de vrais événements du serveur local avec la seule amplitude adaptée. Vidéo : `.runtime/qa-video/ragdoll-impulses-comparison.mp4`, rapport associé : `impulse-report.json`. Le réglage livré est 48/80, équivalent aux prises ×4 ; la comparaison historique reste reproductible par le [banc vidéo](qa-video.md).

Après intégration, `bun run check` passe : TypeScript, **350 tests / 14 795 assertions**, build de 11 fichiers. Les tests WebSocket du banc vérifient les valeurs 48/80 sans modification des événements en mode normal, puis les douze références historiques en comparaison. Les tests de mort conservent dégâts non mortels, point et direction, pelle et impulsions radiales des grenades. Le staging Linux comprend désormais ces tests : **133 tests / 3 131 assertions**, sans échec. La publication vérifie SHA GitHub, trois domaines, 51 ressources et 13 empreintes serveur, puis le smoke Internet et le parcours navigateur. Aucun nouveau test sur téléphone physique ni de charge publique n'est revendiqué.
