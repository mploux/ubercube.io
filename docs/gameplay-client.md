# UBERCUBE — référence gameplay et responsabilités client

État du 11 septembre 2026. Inspection statique ciblée du Java dans `C:\Users\Marc\Documents\Dev\ubercube`. Aucun lancement du jeu, aucune compilation, aucune modification Java. Les chemins actifs ci-dessous constituent une référence à vérifier en jeu ; une présence dans le code ne prouve pas une expérience fonctionnelle sans défaut.

## Périmètre acquis

Reprendre les mécaniques et l'identité actuelles avec TypeScript, Three.js et Bun. Serveur autoritaire ; pseudo sans compte → lobby et choix du kit → partie → choix du kit à la réapparition. Admission en cours de partie jusqu'à 100 joueurs pour le premier serveur, capacité configurable. Mode de démarrage TDM ou FFA ; en TDM, affectation des nouveaux arrivants à l'équipe la moins nombreuse, sans déplacement forcé des joueurs déjà présents. Construction et destruction conservées ; effondrements reportés ; terrain réinitialisé entre les manches.

Le client n'impose pas de nombre minimum de joueurs ni de bouton « prêt » collectif. La règle exacte de fin de manche reste une décision produit ouverte. FFA est une extension demandée, pas un mode retrouvé dans le Java actif.

## Inventaire relié aux chemins actifs

| Fonction | Comportement observé | Référence Java |
| --- | --- | --- |
| Kits | Assaut : AK-47, grenades, pelle. Sniper : AWP, grenades, pelle. Médecin : sac de soins, AK-47, grenades, pelle. | [AssaultKit:12][assault], [SniperKit:12][sniper], [MedicKit:11][medic] |
| Choix et réapparition | Les trois kits sont exposés sur l'écran de spawn. Choisir un kit demande une apparition ; la vie et les grenades sont restaurées côté serveur. | [SpawnScreen:57][spawn-ui], [RespawnPacket:126][respawn] |
| Mouvement | Déplacement horizontal relatif à la vue, marche/course, gravité, saut au sol, collisions. ZQSD, Espace, Maj ; visée souris. | [PlayerHandler:104][input], [ECKeyMovement:75][movement], [ClientPlayer:63][body] |
| Sélection d'arme | Molette cyclique dans les armes du kit ; clic gauche pour l'action, clic droit pour la position de visée. | [PlayerHandler:113][actions] |
| AK-47 et AWP | Tir maintenu avec cadence, recul, visée modifiant la présentation et la précision. AWP plus lent, projectile plus rapide, dégâts plus élevés et lunette. Projectiles à vitesse finie, trajectoire rectiligne, arrêt au terrain/joueur ; aucune gravité dans ce chemin. | [FireWeapon:93][fire], [WeaponAK47:30][ak], [WeaponAWP:32][awp], [Bullet:79][bullet] |
| Dégâts | 100 PV ; dégâts corps liés à l'arme et branche tête à 100 dégâts. La hauteur d'impact Java est comparée à la position du joueur, sans hitboxes anatomiques détaillées. | [Player:40][life], [BulletHitPlayerPacket:101][player-hit] |
| Grenades | Maintenir charge la force de lancer ; relâcher lance. Stock décrémenté par le serveur. Gravité, rebonds, détonation temporisée ; dégâts radiaux joueurs, destruction du terrain et impulsion. | [WeaponGrenade:62][grenade-input], [GrenadeSpawnPacket:103][grenade-stock], [Grenade:60][grenade], [DamageForcePacket:84][explosion] |
| Pelle et construction | Bloc ciblé surligné ; clic gauche endommage le bloc, clic droit place un bloc gris sur la face ciblée si la case est vide. Aucun inventaire de blocs consommé dans ce chemin. Clic gauche sur un autre joueur proche donne un coup de mêlée. | [PlayerHandler:173][build], [PlayerHandler:222][placement] |
| Soins | Sac sélectionné : un clic sur un autre joueur envoie une demande de soin. Application de +10 PV plafonnée à 100 ; pas d'auto-soin câblé dans cette entrée. | [PlayerHandler:161][heal-input], [ApplyHealingPacket:54][heal] |
| TDM | Deux équipes ; entrant dans la moins nombreuse, égalité départagée en faveur des bleus. Scores d'équipe, kills/deaths individuels ; apparition proche de la base de l'équipe à la hauteur de génération + 2, ignorant les constructions et destructions. | [Game:66][game], [TDMGameMode:102][tdm-spawn], [World:610][terrain-height], [TDMGameMode:174][tdm-join], [TDMGameMode:202][tdm-score] |
| Interface | Vie, compteur de munitions/grenades, effet de dégâts, réticule selon arme/visée, minimap, tableau des joueurs et scores. | [PlayerHudScreen:99][hud], [PlayerHudScreen:210][hud-update], [TDMPlayerListScreen:82][scoreboard] |
| Audio/retours | Tirs, pas, saut, réception, impact, creusement, pose et explosion ; particules d'impact et de sang. | [Sound:34][sound], [PlayerHandler:183][build], [Bullet:119][bullet-hit] |

## Écarts à traiter explicitement

- **Rechargement :** `FireWeapon` restaure immédiatement le compteur lorsque celui-ci devient négatif ([163–179][reload]). Aucun délai de rechargement ni réserve de munitions n'est présent dans ce chemin. Préserver provisoirement le tir continu ; ne pas inventer une touche R, un délai tactique ou un nouveau système de réserves. Le passage sous zéro est une anomalie de compteur à corriger, pas une règle à reproduire.
- **Tir ami et soins adverses :** aucun filtre d'équipe dans les chemins actifs de projectile, mêlée, explosion ou soin cités ci-dessus. Le soin Java ne valide pas non plus l'arme, la distance et l'auteur côté serveur. La nouvelle version validera ces conditions ; une restriction aux alliés changerait le gameplay et ne doit pas être introduite silencieusement. Pour FFA, garder provisoirement les mêmes kits et la possibilité de soigner un autre joueur ne bloque pas le socle ; une règle produit différente restera possible.
- **Score et fin de manche :** le TDM crédite l'équipe opposée à chaque mort de la victime, indépendamment de la cause ; le kill individuel n'est ajouté que si auteur et victime diffèrent ([202–211][tdm-score]). `serverUpdate()` est vide ([96][tdm-update]) : aucun timer/seuil de victoire ou cycle de manches constaté dans ce mode. Ne pas déduire des règles de victoire conventionnelles de l'étiquette TDM.
- **Apparition :** `World.getHeightAt()` renvoie le bruit de génération ([610][terrain-height]), pas la surface réellement présente. Le nouveau serveur devra trouver un emplacement libre et supporté dans le terrain courant ; cette sécurité est une exigence de la réécriture, pas un comportement prouvé du Java.
- **Code inactif :** QG a sa classe, mais `Game` construit directement TDM. L'accroupissement reçoit une entrée et possède des accesseurs, sans utilisation du booléen dans le mouvement inspecté ; le vol est désactivé et son raccourci commenté. Le calcul des dégâts de chute est commenté dans [EntityMovementPacket:104][fall]. Ne pas annoncer ces mécaniques comme reprises fonctionnelles.
- **Temps et présentation :** cadence, vitesse de balle, charge de grenade et inerties Java utilisent des compteurs/forces par update. Leur conversion en unités par seconde doit partir de la boucle de simulation et de comparaisons en jeu. Ne pas assimiler arbitrairement ces valeurs aux FPS du navigateur ni conserver l'effet du taux de rendu sur la simulation.
- **Autorité :** positions, impacts, dégâts et positions d'explosion sont largement fournis par les clients Java. Ces mécanismes réseau ne constituent pas une exigence de fidélité. Les conséquences confirmées doivent toutes provenir du serveur ; les effets anticipés du client doivent pouvoir être corrigés.

Ces points sont des constats limités aux chemins inspectés. Friendly fire, soins FFA et scoring des suicides peuvent recevoir des règles explicites pendant la reprise fidèle ; ils ne nécessitent pas de bloquer la fondation technique.

## Ressources et frontières

Les OBJ des cinq armes et du bras FPS sont référencés dans [OBJModel:16][models]. Les variantes VOX restent des références d'apparence possibles ; ne pas importer simultanément toutes les variantes. Le dossier `res/textures` contient notamment les réticules et éléments de minimap ; les WAV utilisés sont listés dans [Sound:34][sound]. Réutiliser les ressources choisies après vérification visuelle de leurs matériaux, orientation et échelle dans Three.js. Les shaders OpenGL, le chargeur Java et les classes de rendu ne sont pas à transposer. Aucune conversion ni copie d'asset réalisée à ce stade.

| Frontière proposée | Responsabilité |
| --- | --- |
| `src/shared` | Types et messages, paramètres gameplay, mouvement/collisions nécessaires à la prédiction, requêtes voxel. Aucune dépendance DOM, Three.js ou Bun ; simulation indépendante du rendu. |
| `src/server` | Admission/session, équipe, kit permis, tick, collisions définitives, cadence, projectiles, grenades, dégâts/soins, mutations voxel, scores et cycle de manche. |
| `src/client` — réseau/simulation | Capturer et séquencer les intentions, prédire le mouvement local, réconcilier sur le serveur, interpoler les autres joueurs, appliquer les versions de terrain. Les tirs et poses prédits restent distincts des résultats confirmés. |
| `src/client` — présentation | Scène Three.js, caméra, arme FPS, modèles tiers, terrain maillé en workers, effets locaux, audio positionnel ; aucune règle de dégâts ou de score cachée dans une animation. |
| `src/client` — interface/entrées | Pseudo, choix du kit, action Jouer, HUD, scores, mort/réapparition, connexion perdue/serveur complet ; clavier/souris et verrouillage du pointeur. HTML/CSS suffit initialement ; Tailwind seulement si utile. |

Le bouton Jouer déclenche le geste utilisateur nécessaire au pointeur et à l'audio ; quitter le verrouillage, perdre le focus ou ouvrir le menu libère les commandes maintenues. L'interface affiche les refus serveur sans laisser un joueur « en jeu » localement après une apparition refusée. Le client conserve un terrain proche exact pour le combat ; un maillage lointain simplifié n'est jamais la source des collisions. La connaissance réseau des joueurs et la minimap doivent suivre les règles du serveur.

## Critères manuels utiles

1. Trois sessions navigateur indépendantes : pseudo → kit → apparition ; TDM entrant affecté à l'équipe minoritaire après connexion et déconnexion ; serveur FFA sans équipes. Aucun compte, attente de groupe ou vote nécessaire.
2. Courir/sauter contre un mur, poser puis détruire la couverture : les autres sessions voient la même position finale et les mêmes blocs. Répéter avec délais réseau et taux de rendu différents ; aucune vitesse, cadence ou force de grenade dépendante des FPS.
3. Tir à distance avec AK-47/AWP : temps de trajet observable, interception par terrain, tête/corps et PV identiques entre tireur/victime/témoin ; pas de dégâts confirmés uniquement par l'animation du tireur.
4. Tirs, grenades, soins et mêlée : stocks et vies autoritaires, mort comptée une seule fois, impossibilité d'agir mort ; tester les règles provisoires de tir ami et soins à un adversaire explicitement.
5. Deux poses sur la même case, explosion pendant une pose et arrivée tardive durant une destruction : état de terrain convergent ; reconnexion sans duplicata de joueur. Au reset, aucune mutation, grenade ou commande de l'ancienne manche ne fuit dans la suivante.
6. Perte de focus, Échap, fermeture d'un onglet et coupure réseau : aucun déplacement/tir maintenu indéfiniment ; menu et retour à la connexion utilisables. Première vérification sur Chromium et Firefox, puis Safari selon les appareils cibles.

Ces essais valident la boucle de jeu, pas les 100 joueurs. La validation de capacité demandera des clients simulant les actions et des mesures serveur/client, y compris joueurs concentrés, destructions simultanées et arrivée tardive. Aucun de ces essais n'a encore été exécuté.

[assault]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/entities/weapons/kits/AssaultKit.java:12
[sniper]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/entities/weapons/kits/SniperKit.java:12
[medic]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/entities/weapons/kits/MedicKit.java:11
[spawn-ui]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/client/main/screens/SpawnScreen.java:57
[respawn]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/network/packets/RespawnPacket.java:126
[input]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/client/main/player/PlayerHandler.java:104
[movement]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/entities/components/ECKeyMovement.java:75
[body]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/entities/player/ClientPlayer.java:63
[actions]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/client/main/player/PlayerHandler.java:113
[fire]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/entities/weapons/fireWeapons/FireWeapon.java:93
[ak]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/entities/weapons/fireWeapons/WeaponAK47.java:30
[awp]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/entities/weapons/fireWeapons/WeaponAWP.java:32
[bullet]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/entities/bullets/Bullet.java:79
[life]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/entities/player/Player.java:40
[player-hit]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/network/packets/BulletHitPlayerPacket.java:101
[grenade-input]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/entities/weapons/explosiveWeapons/WeaponGrenade.java:62
[grenade-stock]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/network/packets/GrenadeSpawnPacket.java:103
[grenade]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/entities/grenades/Grenade.java:60
[explosion]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/network/packets/DamageForcePacket.java:84
[build]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/client/main/player/PlayerHandler.java:173
[placement]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/client/main/player/PlayerHandler.java:222
[heal-input]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/client/main/player/PlayerHandler.java:161
[heal]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/network/packets/ApplyHealingPacket.java:54
[game]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/Game.java:66
[tdm-spawn]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/gamemodes/TDMGameMode.java:102
[terrain-height]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/world/World.java:610
[tdm-join]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/gamemodes/TDMGameMode.java:174
[tdm-score]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/gamemodes/TDMGameMode.java:202
[hud]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/client/main/screens/PlayerHudScreen.java:99
[hud-update]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/client/main/screens/PlayerHudScreen.java:210
[scoreboard]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/client/main/screens/gamemode/TDMPlayerListScreen.java:82
[sound]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/audio/Sound.java:34
[bullet-hit]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/entities/bullets/Bullet.java:119
[reload]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/entities/weapons/fireWeapons/FireWeapon.java:163
[tdm-update]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/game/gamemodes/TDMGameMode.java:96
[fall]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/core/network/packets/EntityMovementPacket.java:104
[models]: C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/client/rendering/renderers/models/OBJModel.java:16
