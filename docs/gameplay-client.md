# UBERCUBE — référence gameplay et responsabilités client

Ajout du 21 septembre 2026 : [le bazooka RPG](bazooka.md) reprend le maniement d'une version Java antérieure à celle de l'inventaire ci-dessous. Il s'ajoute au kit assaut. Après revue de Marc, son modèle devient polygonal facetté, sa vitesse passe à 60 blocs/s et tout impact déclenche une explosion : maximum 80 PV, dégâts dégressifs jusqu'à 10 blocs, rayon terrain de 3,5 blocs. L'impact direct inflige 80 PV sans ajouter une seconde fois les dégâts radiaux. La révision suivante conserve ces règles et le modèle approuvé ; elle détache l'ogive au tir, aligne la caméra à travers la lunette avec le zoom AWP et adapte le port sur les personnages. Les règles AK/AWP, grenade, pelle et médic décrites ici sont conservées. Publié le 21 septembre 2026 avec le protocole 4 ; voir [la preuve de publication](deployment.md#publication-du-bazooka-assaut--21-septembre-2026).

État du 11 septembre 2026. Inspection statique ciblée du Java dans `C:\Users\Marc\Documents\Dev\ubercube`. Aucun lancement du jeu, aucune compilation, aucune modification Java. Les chemins actifs ci-dessous constituent une référence à vérifier en jeu ; une présence dans le code ne prouve pas une expérience fonctionnelle sans défaut.

## Ajouts du 21 septembre 2026

Publiés ensemble le 21 septembre 2026. Protocole 6 côté client, serveur et worker solo ; codec binaire inchangé. Ces décisions étendent volontairement la référence Java historique décrite plus bas.

- Maj maintenu active le sneak à 3 blocs/s. Ctrl conserve la course à 9 blocs/s. Le support sous les pieds est vérifié pendant les déplacements horizontaux au sol, y compris en diagonale et avec de l'élan ; le saut et la destruction du support permettent toujours de tomber. Pas de nouvelle hauteur de collision ni de posture accroupie : il s'agit du sneak pour les bords. La prédiction client et le serveur appellent la même simulation.
- Les chutes sont mesurées depuis le sommet de la trajectoire jusqu'au premier atterrissage. Aucun dégât jusqu'à 6 blocs ; progression linéaire vers 100 PV à 20 blocs, arrondie vers le bas au PV entier, avec tolérance du solveur de contact. Une chute de 13 blocs retire 50 PV. Le suivi est effacé à la mort, à l'apparition et au reset ; le client ne transmet ni distance de chute ni dégâts.
- Sac médic sélectionné : clic droit, +10 PV sur soi-même plafonnés à 100, une fois par appui. Le clic droit a priorité si les deux boutons sont pressés. Clic gauche et portée des soins sur autrui sont conservés. Annulation, pause et changement d'arme ne créent pas de soin supplémentaire.
- Chaque arme et outil affiche un réticule. L'AWP et le RPG remplacent le réticule normal par celui de la lunette en visée.

À la mort, le client suit son ragdoll pendant 3 s, avec caméra décalée et rapprochée devant les voxels qui l'obstruent. La mise à jour publiée le 22 septembre porte ensuite la kill cam de 3 à 5 s depuis les yeux du tueur : 2,7 s avant la mort, 2 s de continuation à vitesse réelle, puis 0,3 s de maintien final. Positions, visées, projectiles, tirs et impacts sont reconstruits depuis les messages reçus. Le serveur ajoute seulement une copie de la pose du tueur à l'événement de mort existant ; aucun enregistrement vidéo ni historique serveur. Les tirs rejoués déclenchent uniquement rendu et audio, sans envoyer de commandes ni appliquer de dégâts.

L'historique conserve au plus 100 snapshots sur 4 s, 100 joueurs et 512 projectiles par snapshot, 4 096 événements. Pendant la death cam, le clip collecte aussi les snapshots et événements jusqu'à 2 s après la mort, puis se fige au début de sa lecture : au plus 220 snapshots (environ 120 au rythme réseau de 20 Hz), toujours 4 096 événements, avec la mort fatale conservée. Les snapshots copiés sont partagés en lecture. Si le tueur meurt ou disparaît, la caméra conserve sa dernière pose sans suivre sa réapparition. La lecture est nettoyée sur fin, reset, nouvelle apparition et déconnexion. Après une chute, un suicide ou sans pose du tueur exploitable, les 3 s de death cam mènent directement au lobby.

Limites : la kill cam est une reconstruction des états autoritaires reçus, pas la capture exacte de l'écran adverse. Le terrain reste dans son état courant, les animations et le recul sont cosmétiques, et un historique trop court conserve la première pose disponible. Elle n'ajoute aucune compensation de latence au combat. Au-delà de 100 joueurs, l'historique complet de tous les joueurs n'est pas garanti.

Sur mobile, Sneak se bascule par appui pour conserver les deux pouces disponibles pour déplacement et regard. Le secondaire du sac affiche « Se soigner ». Les actions sont désactivées pendant les deux caméras.

La mise à jour publiée le 22 septembre conserve la capture souris entre jeu, death cam et kill cam ; retour au lobby, Échap ou perte de focus la libèrent. Le clic droit et la molette ne déclenchent pas d'action navigateur pendant les caméras. Ajustement local suivant : choisir le kit, réapparaître ou reprendre capture seulement la souris en mode fenêtre. Le plein écran s'active ou se quitte volontairement par le bouton **Fullscreen** / **Exit fullscreen** dans **Options**, sans préférence mémorisée ni bascule automatique. La capture clavier est demandée à l'entrée/reprise uniquement si ce plein écran est déjà actif. Ctrl reste la course et Tab affiche les scores. Échap libère les captures et ouvre le menu en jeu. Le lobby et les champs de réglage conservent leurs entrées normales. La capture clavier est libérée à la pause, à la perte de focus/pointeur, à la sortie du plein écran et au retour au lobby. Les commandes tactiles sont conservées.

En fenêtre, Ctrl+Tab et les autres raccourcis réservés peuvent rester gérés par le navigateur ; aucune demande de capture clavier ni alerte répétée n'est déclenchée. En plein écran volontaire, le navigateur peut refuser Keyboard Lock ou ne pas le proposer ; un message indique alors que certains raccourcis restent actifs. La capture des combinaisons réservées demande le plein écran via l'API, et les raccourcis système restent soumis aux limites du navigateur/OS : [documentation Chrome](https://developer.chrome.com/docs/capabilities/web-apis/keyboard-lock). Ces corrections restent côté client, sans changement du protocole 6.

## Reprise du maniement implémentée

`src/shared/weapon-pose.ts` reprend les updates à 60 Hz de `Weapon`, `FireWeapon`, `MeleeWeapon`, `WeaponGrenade` et `WeaponMedicBag`. La vue FPS et le serveur utilisent ces mêmes poses et compteurs. Les positions, échelles et pivots des armes historiques restent définis à partir des OBJ bruts. Les points de sortie sont mesurés au centre des extrémités de canon OBJ ; le même facteur 1/16 et la même échelle de pose s'appliquent au modèle et à ces coordonnées. Le RPG garde l'échelle `(2 ; 2 ; -2)` pour une longueur de 2,375 blocs. Sa pose de repos est `(0,3 ; 0 ; -1,1)` et sa visée `(0,09 ; 0,055 ; -1)` aligne la lentille avec la caméra ; le point de tir local stabilisé devient `(0,09 ; -0,145 ; 2)`, toujours à la pointe du modèle. Le repos FPS a été relevé de 0,18 bloc puis publié le 21 septembre après validation de Marc, sans changer la visée ni le port à la troisième personne. Ce réglage partagé conserve le départ de la roquette à la pointe du modèle. Les gestes n'avancent pas pendant le rendu. L'arme inactive conserve sa pose et sa cadence.

| Comportement | Implémentation vérifiée |
|---|---|
| AK-47 / AWP | Un tir tous les 8 / 62 ticks sélectionnés, selon l'ordre et les comparaisons strictes de `FireWeapon.update`. Compteur décrémenté, puis renouvelé à 30 / 5 lorsque négatif. |
| RPG | Un tir physique tous les 62 ticks sélectionnés, compteur renouvelé à 30 lorsque négatif. L'ogive portée disparaît jusqu'au terme de cette cadence, sans délai supplémentaire. Vol à 60 blocs/s, explosion sur joueur ou terrain, dégâts maximum 80 contre 100 pour la grenade ; le tireur subit aussi les dégâts radiaux. |
| Visée | FOV de base 70°, filtre Java donnant environ 54,44° pour l'AK et 11,655° pour l'AWP et le RPG (`zoomAmount = 150`). Le RPG reprend aussi la sensibilité de visée ×0,15 et le réticule AWP, avec caméra alignée à travers sa lentille transparente. Les modèles restent rendus sous le réticule. |
| Inertie et recul | Filtre de position 0,4, rotation 0,7, balancement et posture de sprint, dépendance aux mouvements de souris. L'aléatoire de hanche modifie la pose ; aucun cône de tir supplémentaire. |
| Pelle / soins | Clics distincts, sans cooldown global ajouté ; pelle 20 dégâts et animation sur cinq ticks, soins +10 plafonnés à 100. |
| Grenade | Charge `(charge + 0,3) × 0,9`, force de relâchement `charge × 0,9`, sans vitesse héritée du joueur. Gravité cumulée et traînée calculées sur dix sous-pas par tick. |
| Entrées | Sensibilités et sens de molette Java convertis aux événements navigateur ; les clics plus courts qu'un tick sont conservés. Pause/perte de focus annulent les actions et la charge. |
| Tirs AK-47 / AWP | Raycasts instantanés autoritaires. L'événement `shot` transmet l'identifiant, l'origine et `endPosition`, y compris pour un tir manqué. Trace jaune de section 0,08 × 0,08 sur le segment complet, visible 60 ms et au moins une image, sans déplacement ni durée liée à la distance. |

Adaptations conservées : le serveur décide des trajectoires et empêche un canon de traverser un mur ; les collisions de grenade utilisent son raycast voxel, pas la boîte Java de demi-taille 0,2. Le stock initial AWP reste à 5, sans reprendre le défaut de constructeur Java qui hérite initialement des 30 cartouches de `FireWeapon`. L'aléatoire cosmétique client n'est pas synchronisé avec celui du serveur ; les impacts visibles et dégâts suivent toujours les événements autoritaires. L'animation et le son locaux sont anticipés, les traces apparaissent à la confirmation serveur.

Décision du 14 septembre 2026, publiée le 15 septembre avec le protocole 3 : les armes rapides passent en hitscan. Les tirs acceptés sont résolus après les déplacements de tous les joueurs du tick ; le premier contact œil–canon est traité avant le rayon du canon. La portée explicite reprend les huit secondes de vol précédentes, soit 2 400 blocs pour l'AK et 4 800 pour l'AWP, avec arrêt aux limites horizontales du monde, au sol inférieur et au plafond `height + 64`. Aucun projectile AK/AWP ne subsiste dans les snapshots. La direction du canon, le recul, la dispersion, les AABB et les seuils de headshot sont conservés ; aucun recentrage automatique sur le viseur ni historique de compensation réseau n'est ajouté. Le ragdoll reçoit le point confirmé et une impulsion dans la direction effective du rayon.

Les tests Bun contrôlent les règles et transformations, et le harness WebGL charge les cinq modèles OBJ/MTL historiques ainsi que le RPG polygonal original pour vérifier les six armes et leurs actions. Les six modèles partagent le shader d'armes. La comparaison interactive du maniement historique avec le Java reste à faire ; voir [la validation exécutée](validation.md).

La calibration des canons corrige un décalage hérité des points de tir Java : ils se trouvaient environ 1,80 bloc derrière l'extrémité du modèle AK et 1,53 derrière celle de l'AWP. Les coordonnées corrigées sont `(0, -5.278345, 98.273787)` et `(0, -3.1084115, 64.970720)` dans les OBJ bruts. Le serveur réduit le trajet œil–canon à la première obstruction de terrain ou de joueur, afin de ne pas créer une balle derrière une cible très proche.

Les grenades lancées utilisent le même OBJ/MTL que la grenade tenue, à l'échelle 1/16, avec ses trois couleurs et son origine préservées. Le rendu emploie une seule géométrie instanciée et le shader des armes, avec brouillard actif dans le monde. Pour les autres joueurs, `GrenadeVisuals` interpole les positions confirmées sur leur tick serveur avec 100 ms de tampon et conserve le dernier point en cas de manque de données.

Le tireur voit sa grenade dès le tick de relâchement, sans attendre ce tampon ni une réponse réseau. `src/shared/grenade.ts` partage l'origine de lancer, la force et les dix sous-pas de vol/collision avec le serveur. La prédiction est uniquement visuelle : aucune mutation de terrain, aucun dégât ni explosion locale. L'événement de tir associe la commande du joueur au projectile serveur ; les snapshots corrigent sa trajectoire en amortissant l'écart d'affichage. Une confirmation ne crée pas de deuxième modèle. L'entrée de relâchement est envoyée immédiatement avec les commandes déjà en attente ; les stocks encore non acquittés sont réservés localement. Un refus, une explosion, une fin de projectile ou un reset retirent le modèle. La mort annule les lancers non confirmés ; les grenades déjà confirmées continuent leur vol. Une seconde sans confirmation ni snapshot borne la durée des prédictions en cas de coupure. Le serveur reste seul responsable du stock, des collisions définitives et de la détonation.

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

- **Rechargement :** `FireWeapon` restaure immédiatement le compteur lorsque celui-ci devient négatif ([163–179][reload]). Aucun délai de rechargement ni réserve de munitions n'est présent dans ce chemin. La demande de reprendre exactement le maniement a conduit à conserver cet ordre de décrément/renouvellement, sans touche R, délai tactique ni réserve.
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
