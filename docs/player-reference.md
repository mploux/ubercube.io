# Personnages Java

Le renderer actif est `GameRenderer → PlayerRenderer → PlayerSkeleton`, dans `C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames`. `PlayerRendererOld` n'est pas instancié. Aucun modèle OBJ de personnage n'est utilisé : le personnage est constitué de dix cuboïdes articulés. Le Java reste en lecture seule.

## Modèle et rendu repris

| Partie | Dimensions | Couleur RGB brute |
| --- | --- | --- |
| Torse | 0,65 × 1,10 × 0,30 | 6, 46, 6 |
| Tête | 0,50 × 0,50 × 0,50 | 208, 164, 134 |
| Bras | 0,25 × 0,50 × 0,25 | 3, 34, 3 |
| Avant-bras | 0,20 × 0,50 × 0,20 | 208, 164, 134 |
| Cuisses et jambes | 0,30 × 0,65 × 0,30 | 3, 34, 3 |

`skeleton/PlayerSkeleton.java` définit les volumes et la palette. Les autres classes de ce dossier définissent les articulations. La taille d'un volume ne redimensionne jamais ses enfants. `PlayerRenderer.cubeVertices()` place les cubes entre Y=0 et Y=1 et `player.frag` applique les coefficients de faces 1 / 0,6 / 0,7 / 0,8. Le shader Three conserve ces couleurs de sortie brutes, sans interprétation sRGB supplémentaire, ainsi que le brouillard de distance original. Les corps projettent des ombres.

Les corps restent verts dans toutes les équipes du Java actif. La distinction TDM provient des pseudos rouges et bleus : `PlayerNameRenderer`, `TDMGameMode`, `Color4f`. La police `StaticFont.Kroftsmann` charge en réalité le même `RifficFree-Bold.ttf` que l'interface. La version FFA conserve ces corps et utilise des pseudos blancs ; aucun renderer FFA distinct n'existe dans la référence. Les noms sont masqués au-delà de la distance de rendu.

Le centre du personnage Java correspond à la position aux pieds TypeScript + `PLAYER_HEIGHT / 2` (1,4). La géométrie n'est pas redimensionnée pour modifier les règles de collision existantes. Le modèle descend ainsi d'environ 0,05 sous les pieds et monte à 2,9 au repos, comme le squelette Java relatif au collider de 2,8 du joueur local. Le repère Java regarde vers +Z ; le client Three utilise −Z. Les transforms et les modèles d'armes sont convertis explicitement. `Quat.deuler(x,y,z)` correspond à l'ordre YZX de Three avec les deuxième et troisième arguments échangés ; appliquer un Euler XYZ donnerait des bras incorrects.

## Animations et armes

Les formules de `HeadBone`, `*ArmBone`, `*ForeArmBone`, `*UpLegBone` et `*LegBone` sont reprises : tête en `sin(pitch) × 90°`, oscillations des bras, genoux articulés, cadence lente/rapide, poses fusil/outils et visée. La visée distante est alimentée par `PlayerState.aiming`, validé par le serveur pour AK/AWP. Le Java n'a pas d'animation séparée de saut, de mort, de tir ou de rechargement du squelette distant : le saut déplace ce même corps, la mort le masque. L'arme tenue suit les mains calculées dans la même image.

La vitesse d'animation utilise la vitesse horizontale autoritaire multipliée par `5 / 60 × 1,5`. C'est l'équivalent de `Player.getMovementVelocity()` avec l'envoi Java d'une position toutes les cinq mises à jour 60 Hz (`ClientPlayer.update`). La phase dépend du temps écoulé à 60 Hz. Le code Java incrémentait les compteurs du squelette partagé une fois par joueur : sa cadence variait donc avec le nombre de joueurs. Ce défaut n'est pas reproduit. Aucun lissage ou délai de position réseau n'est ajouté par `PlayerVisuals`.

`EntityWeaponRenderer` utilise les mêmes OBJ/MTL que la vue FPS, déjà présents dans `public/assets/weapons` :

| Arme | Échelle | Translation Java après échelle | Orientation |
| --- | --- | --- | --- |
| AK47 | 0,02 | 0 / 10 / −34 | main droite vers main gauche |
| AWP | 0,04 | 0 / 5 / −17 | main droite vers main gauche |
| Pelle, grenade, soins | 0,08 | 0 / −5 / 0 | axes du monde, comme le Java |

Les palettes, faces et normales locales sont conservées. La grenade tenue disparaît lorsque le stock est nul, conformément à `WeaponGrenade.update`. Le shader d'armes existant est réutilisé ; sa réflexion d'environnement à 2 % n'est pas celle du cubemap dynamique Java. Le reste de la vue FPS n'est pas modifié ici.

## Validation

- `bun test tests/player-visuals.test.ts` : 12 tests, 538 assertions. Dimensions, palette des deux équipes et FFA, pivots continus, pitch, ADS, changement d'arme, saut sans pose inventée, absence de lissage, 100 instances, cinq vrais modèles d'armes, attache des armes aux mains, nettoyage et brouillard.
- Une pose complète émise par les classes Java compilées est conservée comme référence numérique dans le test. Elle protège notamment l'ordre non standard des quaternions et la conversion de repère.
- Comparaison complémentaire exécutée dans `.runtime/player-reference/` : 20 sources Java originales copiées sans modification et compilées avec seulement les dépendances gameplay remplacées par des valeurs d'entrée. 135 poses, 1 350 os et 25 650 valeurs de matrices/couleurs comparées. Écart maximal `2,831 × 10⁻⁷`, compatible avec le calcul Java en float32. Phases 1/15/30/60/120, amplitudes 0/0,6/1,125, pitch 0/0,6/−0,8 et poses fusil, visée et outil. `setup.py`, `compare.ts` et `comparison.json` restent hors production.
- Vérification TypeScript réussie. La comparaison Java valide les transforms et palettes ; elle ne constitue pas une comparaison d'images avec un jeu Java exécuté sur GPU.
- `tests/browser/player-check.ts`, intégré au harness GPU : huit contrôles passent sur le véritable framebuffer WebGL, avec peau RGB 166/131/107 sur la face avant, cinq armes visibles, course/visée et brouillard. Les six captures de personnages ont été inspectées. Aucun diagnostic de shader.

Le corps complet utilise un seul draw instancié pour ses dix parties par joueur. Les armes sont regroupées par modèle. Les matrices et vecteurs de pose sont réutilisés à chaque image. Aucune ressource supplémentaire n'est copiée depuis le dépôt original.

## Ragdolls

Ajout local du 14 septembre 2026, non publié : une mort confirmée crée un cadavre composé des dix volumes existants, simulés par cannon-es dans `src/client/ragdolls.ts`. Les neuf articulations conservent leurs pivots dans la pose affichée. La vitesse de déplacement est reprise, puis une impulsion est appliquée sur le volume orienté le plus proche du point touché. Le décalage entre ce contact et son centre produit un couple ; le mouvement ne se limite donc pas à une translation du torse.

Le serveur joint à l'événement JSON `death` une copie indépendante de l'état fatal, le point de collision et l'impulsion en coordonnées monde. Les tirs AK/AWP utilisent désormais la direction du rayon autoritaire, jamais une direction reconstruite depuis la position ultérieure du tireur. Les amplitudes cosmétiques sont 12 pour l'AK47, 20 pour l'AWP et 8 pour la pelle, pour une masse totale de 17,8. Les grenades appliquent au torse une impulsion radiale décroissante, plafonnée à 20 ; les morts environnementales n'ajoutent aucune impulsion. Ces réglages visuels ne représentent pas des masses balistiques réelles.

`PlayerVisuals` conserve la dernière pose interpolée pour éviter un saut à la mort. Le point touché est ramené dans cette pose, tandis que la direction de l'impulsion reste celle du monde. En l'absence de pose affichée, l'état inclus dans l'événement permet de construire le corps. Une même mort ne crée qu'un cadavre ; le snapshot vivant précédent est masqué et une réapparition ultérieure reste indépendante. Les snapshots de joueurs déjà morts à l'arrivée ne recréent pas leurs anciens corps. Le reset et la déconnexion nettoient les corps et les caches.

La simulation utilise un pas de 1/120 s, au plus huit pas par image, avec interpolation du rendu et mise en sommeil au repos. Elle conserve au plus seize cadavres pendant douze secondes, puis retire les corps et les contraintes. Le rendu réutilise le même maillage instancié, la palette, le brouillard et les ombres. L'arme tenue et le pseudo sont retirés à la mort. Le parcours du joueur tué revient toujours au lobby.

`RagdollTerrain` construit des boîtes autour des membres à partir des voxels actuels. Il fusionne seulement des volumes entièrement solides et actualise la collision après construction/destruction, indépendamment des maillages asynchrones. Retirer un support réveille tous les membres reliés du cadavre concerné. Les cellules et colliders hors de ces zones sont libérés.

Limites retenues : les hitboxes de combat restent les AABB historiques ; le membre physique le plus proche du point confirmé est donc une approximation du membre visuel touché. Les articulations ont des limites coniques, sans butées anatomiques strictes de genou. Les membres et les cadavres ne se percutent pas entre eux et ne bloquent ni les joueurs ni les tirs. Chaque client simule sa propre pose finale ; aucun état persistant de cadavre n'est répliqué. L'ajout seul du champ optionnel `death` n'exigeait pas de changement de version ; le passage AK/AWP en hitscan porte ensuite le protocole local à 3, sans changer le format binaire des snapshots.

Validation dédiée : `tests/death-events.test.ts`, `tests/player-death-visuals.test.ts`, `tests/ragdolls.test.ts`, `tests/ragdoll-terrain.test.ts` et `tests/browser/ragdoll-check.ts`. Résultats et limites des mesures dans [validation.md](validation.md#ragdolls--14-septembre-2026).
