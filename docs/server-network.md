# Serveur et réseau

Statut : cadrage initial issu d'une lecture statique du Java le 11 septembre 2026. Certains mécanismes décrits ici restent prévus. L'implémentation livrée et ses mesures sont décrites dans le [README](../README.md) et la [validation](validation.md). Le Java est une référence de comportement, pas une architecture à porter.

## Correction du retard entre joueurs — 12 septembre 2026

Le client envoie désormais les intentions générées pendant chaque image, sans lot minimum de trois. Le serveur élimine uniquement les commandes en tête de file dont les boutons, l'arme et l'annulation sont identiques à l'état déjà appliqué et à la commande suivante. Les axes et l'orientation les plus récents remplacent ainsi les intentions de mouvement périmées ; le premier appui/relâchement/changement conserve sa séquence. Ce regroupement reste désactivé avant le premier input et après le délai de neutralisation. Déplacement, cadences, charge et actions sont évalués une seule fois par tick. Une pointe réseau ne laisse plus un nombre constant de commandes en retard lorsque l'envoi retrouve sa cadence normale.

`RemotePlayers` utilise les ticks des snapshots et une fenêtre bornée de 40 états pour mesurer la gigue. Il interpole à un intervalle de snapshot de la réception estimée, soit environ 50 ms supplémentaires en régime stable, contre 100 ms auparavant. Le temps affiché ne recule pas ; une interruption ne provoque aucune extrapolation à travers le terrain. Mort, réapparition, déconnexion, téléportation et reset interrompent correctement les anciennes trajectoires. Les états discrets d'arme et de visée suivent le même échantillon que la pose. La visée validée par le serveur occupe un bit libre du champ de flags binaire, sans ajouter d'octets ; les anciens snapshots la décodent à `false`.

Les mesures avant/après, essais à 100 joueurs et limites figurent dans la [validation](validation.md). Il n'y a toujours pas de compensation historique des impacts.

## Périmètre décidé

Un serveur Bun héberge une partie TDM ou FFA, choisie au lancement. La capacité est configurable, initialement 100 joueurs. Admission immédiate tant qu'une place existe ; aucune attente d'un nombre minimum de joueurs. En TDM, chaque entrant rejoint l'équipe la moins nombreuse ; en FFA, aucune équipe. Pseudo, lobby d'équipement puis entrée en jeu, sans compte ni base de données. Construction et destruction sont conservées. Chaque nouvelle manche réinitialise le terrain. Les effondrements et la distribution de la simulation sont hors de la première version.

## Autorité et limites de modules

Un seul package Bun au départ :

| Zone | Responsabilité |
| --- | --- |
| `src/shared` | Types du protocole, paramètres de gameplay, simulation du déplacement et requêtes voxel pures ; aucune dépendance DOM, Three.js ou Bun. |
| `src/server` | Connexions, validation des commandes, horloge, simulation autoritaire, terrain, équipement, projectiles, vie, scores, équipes et manches. |
| `src/client` | Entrées, prédiction, interpolation, rendu Three.js, sons et interface. |

Le serveur décide de toute conséquence de gameplay. Aucun message client ne peut fixer une position, une vitesse, des dégâts, un impact, une explosion, un inventaire ou une modification du terrain. La simulation expose ses résultats à la couche réseau ; elle ne manipule pas de sockets. Un seul propriétaire écrit l'état de la partie. Les futurs workers de génération rendent des résultats identifiés par manche et tâche ; leur achèvement ne modifie pas directement la simulation.

## Session et protocole minimal

Le serveur attribue `playerId` et lie cette identité à la connexion. Le pseudo est une étiquette d'affichage, jamais une preuve d'identité. Le serveur valide version et pseudo avant de créer le joueur. L'admission et l'affectation d'équipe sont atomiques : les arrivants simultanés voient les places et affectations déjà réservées, y compris pendant le lobby. Une déconnexion libère ces ressources. Proposition initiale : une nouvelle connexion crée une nouvelle session ; une reprise de session nécessiterait un jeton serveur temporaire, jamais le seul pseudo.

Les noms suivants décrivent les échanges, sans imposer un framework ni un schéma complet :

| Sens | Message | Rôle |
| --- | --- | --- |
| Client → serveur | `Hello(protocolVersion, nickname)` | Demander l'admission. |
| Serveur → client | `Welcome(playerId, roundId, mode, tickRate, worldManifest)` | Donner l'identité et les paramètres effectifs. |
| Client → serveur | `SelectLoadout`, `Ready` | Choisir un équipement autorisé puis demander l'apparition. |
| Client → serveur | `Input(seq, axes, yaw, pitch, buttons, actions)` | Envoyer les intentions ; séquence propre pour chaque action ponctuelle. |
| Serveur → client | `Snapshot(roundId, serverTick, lastProcessedInputSeq, entities)` | Corriger le joueur local et représenter les autres entités pertinentes. |
| Serveur → client | Événements de gameplay | Tirs acceptés, impacts, dégâts, morts, apparitions, scores et transitions de manche. |
| Serveur ↔ client | Synchronisation des chunks | États, changements, accusés d'application et demandes de reprise bornées. |

Après l'accueil, toute commande de gameplay porte sa manche ; un message d'une ancienne manche est ignoré des deux côtés. Un tir ou une construction possède un identifiant permettant de rapprocher l'effet anticipé du résultat serveur et d'éviter une double exécution. Le client ne choisit ni son auteur, ni son équipe, ni les entités à lui répliquer. Un refus d'admission, d'équipement ou d'action a une raison exploitable par l'interface.

## Boucle de simulation et transport

Proposition de départ à mesurer : simulation fixe à 60 Hz, soit 16,67 ms par tick, et états envoyés à 20 Hz. Le débit d'envoi et le rendu sont indépendants du pas de simulation. Le serveur consomme un nombre borné de commandes par joueur ; le client ne fournit pas un delta de temps permettant d'accélérer sa simulation. Horloge monotone, traitement des commandes dans un ordre explicite, simulation puis publication des résultats. Un retard n'autorise ni rattrapage illimité ni accélération d'un joueur. Toute surcharge durable est mesurée et remontée.

Utiliser initialement WebSocket/WSS avec Bun, avec messages binaires pour entrées, états fréquents et terrain. Bun prend en charge les données attachées aux connexions, les envois binaires et le suivi de la saturation d'envoi. [Documentation Bun](https://bun.sh/docs/runtime/http/websockets).

Limiter taille des messages, fréquences, commandes en attente et octets sortants par client. Prioriser les états de combat ; fragmenter et cadencer le chargement initial du terrain. Remplacer les snapshots obsolètes encore dans la file applicative, sans perdre les actions ponctuelles ni la continuité du terrain. Un message déjà remis au transport ne peut plus être remplacé. Ajouter un crédit d'application pour les transferts volumineux : le navigateur ne régule pas automatiquement les messages reçus. La saturation d'un client ne doit pas suspendre le tick des autres. [Documentation MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket).

WebSocket est un choix initial soumis aux essais de réseau dégradé ; aucune capacité à 100 joueurs ne découle des seuls benchmarks du transport. La sélection spatiale doit inclure les interactions lointaines pertinentes, notamment le sniper, et pas uniquement un petit rayon autour du joueur.

## Mouvement et fidélité des tirs

Le client simule immédiatement ses commandes avec les mêmes règles de déplacement et collisions voxel que le serveur. À réception d'un état, il repart de l'état autoritaire, élimine les commandes acquittées et rejoue les suivantes. La correction visuelle est lissée séparément des collisions. Les autres joueurs sont interpolés entre états datés ; l'extrapolation éventuelle est courte et bornée. Les changements de terrain nécessaires à une correction doivent être appliqués avant son rejeu, ou déclencher une resynchronisation locale explicite.

Depuis la décision du 14 septembre 2026, l'AK-47 et l'AWP utilisent des raycasts instantanés, en remplacement des balles Java à vitesse finie. Le serveur capture l'origine et la direction du canon lors du tir, puis résout tous les tirs acceptés après les déplacements du tick. Il teste le premier obstacle œil–canon, puis le terrain voxel et les AABB des joueurs sur toute la portée ; seul le premier contact reçoit les dégâts. Cadence, munitions, dispersion, dégâts et impulsions ragdoll restent autoritaires. Les grenades gardent leur charge, vol, rebonds et explosion.

Le protocole publié le 15 septembre 2026 passe à 3 : un événement JSON `shot` AK/AWP contient `position` et `endPosition`, y compris en cas de tir manqué, avec `projectileId` conservé comme identifiant de corrélation et `inputSeq`. Il n'a plus de vitesse et ne crée aucune balle persistante dans les snapshots. Le client affiche une trace cosmétique de 60 ms ; dégâts, destruction et décès suivent les événements confirmés. Les grenades conservent leurs événements et snapshots. Le format binaire des snapshots reste en version 1. Client et serveur ont été publiés ensemble ; voir les preuves dans docs/deployment.md.

Les paramètres Java sont parfois exprimés par mise à jour. La condition de cadence et le remplissage instantané du chargeur sont conservés ; aucun rechargement temporisé n'est ajouté. La conversion en hitscan a été explicitement demandée pour l'AK-47 et l'AWP.

La compensation de latence reste à développer : timestamps clients contraints par l'horloge serveur, historique court et vérification des couvertures dans le même état temporel que les joueurs. Reculer uniquement les joueurs dans un terrain actuel produirait des impacts incohérents. Le hitscan supprime le temps de vol, mais résout encore au temps serveur sans rewind ; le ping et l'interpolation des joueurs affichés restent perceptibles.

## Terrain versionné et arrivée en cours de partie

Identité d'un monde : `roundId`, graine et version de générateur. Identité d'une portion : coordonnées du chunk et révision monotone. Les dégâts partiels de blocs font partie de l'état autoritaire lorsqu'ils influencent la destruction suivante.

1. À une frontière de tick, capturer un état de chunk à la révision R et enregistrer immédiatement les changements suivants destinés à cet arrivant, sans fenêtre entre capture et abonnement.
2. Envoyer `ChunkSnapshot(roundId, chunkId, revision=R, data)`, puis les changements contigus `ChunkDelta(fromRevision, toRevision, edits)`. La représentation peut être un chunk compact ou une base générée avec ses différences.
3. Le client acquitte l'application, rejette les anciennes révisions et demande une reprise s'il manque un intervalle. Si l'historique borné ne suffit plus, le serveur fournit un nouvel état complet.
4. Autoriser l'apparition seulement lorsque la zone de collision autour du point choisi est synchronisée. Le reste du terrain arrive par priorité ; aucune obligation de télécharger toute une immense carte avant de jouer.
5. À la nouvelle manche, invalider états, événements, commandes, historiques et travaux asynchrones de la précédente. Un ancien résultat ne peut pas repeupler le nouveau terrain.

Construction et destruction suivent le même chemin de mutation, quel que soit leur auteur : validation de portée, visibilité, cadence, bloc autorisé et placement libre, application serveur, révision, diffusion. Les explosions regroupent leurs modifications par chunk. Le stockage conserve l'état courant et un historique réseau borné, pas une liste infinie de toutes les actions de la manche.

## Validation et objectif 100 joueurs

Avant traitement : nombres finis, champs et longueurs bornés, séquences valides, action autorisée par l'état vivant/mort/lobby, fréquence et portée conformes. Une commande ancienne, répétée ou forgée ne doit jamais doubler une action ni affecter un autre joueur. Un manque d'inputs remet les commandes continues à un état neutre après un délai borné.

Les tests automatisés utiles protègent l'autorité, le rejeu, les collisions, les cadences, l'admission simultanée, l'équilibrage TDM et les transitions de manche. La comparaison de terrain couvre une arrivée pendant une explosion, une reprise de chunk, des modifications de bord et des messages de la manche précédente.

Le passage à 100 exige des clients de charge actifs par le vrai protocole, sur une machine distincte du serveur. Monter 10 → 50 → 100 joueurs, puis tester au moins 30 minutes avec déplacements, tirs soutenus, grenades, construction, morts, départs et arrivées. Inclure 100 joueurs concentrés dans une zone et une carte durablement modifiée. Vérifier aussi le refus explicite du 101e puis la réouverture immédiate d'une place.

Mesures obligatoires : temps de tick p50/p95/p99/max, retard de simulation, nombre de commandes en attente, CPU, mémoire résidente, pauses GC, projectiles actifs, chunks résidents, octets/s par connexion et agrégés, files d'envoi, durée d'arrivée et erreurs de convergence. Proposition de seuil initial : p99 du travail d'un tick sous 16,67 ms et aucune accumulation durable de retard ou de files à 100. Définir et publier le matériel, les profils de latence/perte et le scénario avec chaque résultat ; les budgets mémoire, bande passante et temps de chargement restent à fixer sur matériel cible. Les bots réseau ne valident pas le rendu : conserver des navigateurs réels pendant ces essais.

## Références Java vérifiées

Toutes les références ci-dessous sont dans `C:\Users\Marc\Documents\Dev\ubercube\src\main\java\fr\veridiangames`.

| Fichier et lignes | Constat statique |
| --- | --- |
| `core/network/packets/EntityMovementPacket.java:87–130` | Recherche du joueur par identifiant reçu, application de sa position ; prévention du speed hack laissée en TODO. |
| `core/network/packets/BulletShootPacket.java:105–129` | Origine, rotation, force, dégâts et auteur reçus du client ; le serveur réattribue l'identifiant puis diffuse. |
| `core/network/packets/BulletHitPlayerPacket.java:73–113` | Cible, hauteur d'impact et dégâts fournis par le client ; dégâts de tête calculés à partir de cette hauteur. |
| `core/network/packets/BulletHitBlockPacket.java:78–94` | Dégâts terrain appliqués depuis les coordonnées et dégâts reçus. |
| `core/network/packets/ConnectPacket.java:114–183` | Identité reçue du client ; graine, liste de blocs modifiés et joueurs existants envoyés à la connexion. |
| `core/network/packets/SyncBlocksPacket.java:44–54,88–103` | Liste de coordonnées/valeurs de blocs, sans révision de chunk dans ce message. |
| `core/game/entities/bullets/Bullet.java:79–151` | Progression à vitesse finie et déclaration des impacts par le client. |
| `core/game/entities/weapons/fireWeapons/FireWeapon.java:93–128,163–178` | Cadence comptée en mises à jour, création de projectile et remplissage instantané du chargeur. |
| `core/game/entities/grenades/Grenade.java:60–105` | Physique avec gravité/rebond, explosion après plus de 120 mises à jour, demande d'explosion par le détenteur. |
| `core/network/packets/DamageForcePacket.java:77–100` | Position et force d'explosion reçues ; dégâts joueurs calculés selon la distance. |
| `core/game/gamemodes/TDMGameMode.java:174–214` | Équipe la moins nombreuse à la connexion, suppression au départ et score à la mort. |

Restent des décisions produit : conditions de fin de manche, matériel et réseau cibles, puis sens du scaling futur — multiplier les parties ou partager une seule simulation. Le présent design n'exige ni base de données ni système distribué pour avancer.
