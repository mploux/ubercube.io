# Reprise de l'interface Java

Ajouts locaux du 21 septembre 2026, non publiés : réticule standard présent sur toutes les armes hors lunette (le RPG conserve son point), death cam de 3 s suivie d'une kill cam de 3 s avec titre, nom du tueur et compte à rebours. Les informations de vie, scores, minicarte et munitions en direct sont masquées pendant le replay. [Règles et limites](gameplay-client.md#ajouts-locaux-du-21-septembre-2026).

Les références ci-dessous sont dans `../ubercube/src/main/java/fr/veridiangames`. Le projet original est utilisé en lecture seule. La présentation a été relevée dans les chemins actifs du code Java ; aucune capture d'une session Java exécutée n'est disponible pour certifier une identité pixel par pixel.

| Élément | Référence | Reprise navigateur |
|---|---|---|
| Police | `client/rendering/guis/StaticFont.java` | RifficFree-Bold, réellement chargée par les trois méthodes de police Java malgré leurs noms différents ; fichier original copié |
| Boutons / saisie | `GuiButton`, `GuiTextBox` dans `client/rendering/guis/components` | Hauteur 30 px, boutons 24 px, texte blanc, fonds translucides, survol, clic et ombre d'origine |
| Accueil | `client/main/screens/LoadingScreen.java` | Composants d'origine autour du pseudo ; panorama 3D conservé à la demande produit |
| Lobby | `client/main/screens/SpawnScreen.java`, `GuiRotatingWeapon` | LoadingBG.png, carte 1920 × 1080 à l'échelle 4, trois aperçus 400 × 300 et boutons 200 × 30 ; apparition au clic sur le kit |
| HUD | `client/main/screens/PlayerHudScreen.java`, `gamemode/TDMHudScreen.java` | Vie rouge 300 × 30 en bas à gauche, munitions, vignette, coordonnées, FPS, scores rouge/bleu, message HEADSHOT et réticules PNG originaux |
| Menu / options | `client/main/screens/gamemenu` | Quatre boutons, panneaux, sensibilités normale/zoom, volume, cases graphiques |
| Scores | `client/main/screens/gamemode/TDMPlayerListScreen.java` | Deux colonnes de 300 × 350, nom, éliminations, morts et ping, police 20 px |
| Minicarte | `client/main/minimap`, `GuiMinimap` | Surface 300 × 200, échelle entière 3, rotation avec le joueur, sommets voxel en RGB brut, PNG originaux, alliés et bases colorés, points cardinaux et limitation des marqueurs au bord |

La carte n'ajoute ni grille, ni altitude colorée, ni cadre décoratif. Son cache borné de tuiles est invalidé lors des changements de voxel ; le rendu n'alloue pas une image de toute la carte maximale.

## Matériaux des armes

Le sixième modèle, publié le 21 septembre 2026 pour [le bazooka](bazooka.md), est un lance-roquettes polygonal facetté original, dans le style de l'AK-47 et de l'AWP : tube sombre à dix faces, ogive olive conique, bois, deux poignées et optique décalée. La silhouette et la palette approuvées sont conservées. `bun scripts/model-rpg.ts` régénère son OBJ/MTL : 1 176 triangles, 656 sommets OBJ indexés et neuf matériaux. Le modèle utilise le shader commun aux armes, sans le chemin `legacyVox` du premier essai. Sa longueur reste 2,375 blocs. L'ogive de 280 triangles est séparée du tube : elle disparaît du modèle au tir, devient le projectile visible en vol, puis revient après les 62 ticks de cadence.

La visée FPS traverse maintenant la lentille du modèle, dont le verre est à 12 % d'opacité et les fermetures opaques ont été ouvertes. Elle reprend le réticule, le zoom (`zoomAmount = 150`, FOV stabilisé d'environ 11,655°) et la sensibilité ×0,15 de l'AWP. Le guidon avant est masqué uniquement en visée FPS pour dégager l'ouverture ; le réticule ponctuel reste affiché hors visée. Sur les autres joueurs, l'arme passe des avant-bras à l'épaule et les mains rejoignent les deux poignées. Les trois aperçus de classes restent AK-47, AWP et sac de soins. Ce changement est publié avec le protocole 4 ; voir [la preuve du 21 septembre 2026](deployment.md#publication-du-bazooka-assaut--21-septembre-2026).

Les cinq autres modèles actifs sont ceux des sous-dossiers `res/weapons`, et non les anciennes versions à la racine. Les tests contrôlent toutes leurs faces, normales et couleurs `Kd` par rapport aux fichiers OBJ/MTL. La présentation utilise un shader dédié reprenant le calcul de lumière du Java ; les lampes du monde, Phong et le tone mapping du terrain ne recolorent plus les armes.

La disparition de couleurs venait des surfaces superposées : l'AK possède 496 triangles identiques avec des palettes différentes ; la trousse de soin en possède 212, dont les faces rouges et la croix blanche, suivies de faces grises. Le test de profondeur `LessEqualDepth` par défaut de Three.js laissait les dernières faces remplacer les premières. `LessDepth` reprend le comportement OpenGL par défaut du Java, sans supprimer ni recolorer la géométrie. Une sonde temporaire a confirmé que le GPU recevait déjà toutes les bonnes couleurs avant cette correction ; elle a été retirée.

## Adaptations et limites

- La rangée des trois kits se réduit uniformément sur les fenêtres de moins de 1200 px de large. Les boutons restent aux mêmes emplacements relatifs.
- Au premier accès au lobby, la carte est centrée sur le monde tant que le serveur n'a pas fait apparaître le joueur. Après une mort, elle utilise sa position.
- Le FFA utilise les mêmes composants de tableau, dans une seule colonne. Le Java fourni possède TDM et QG, sans écran FFA distinct à copier.
- Les tableaux défilent pour accueillir jusqu'à 100 joueurs ; le ping distant reste `—` tant que le protocole ne transmet pas cette mesure.
- Neige, ombres et SSAA sont actifs et persistés localement. Le SSAA double chaque dimension du buffer, dans les limites du GPU. La neige reprend les cubes, couleurs, émission, durée et collisions du Java dans un pool de 10 000 instances maximum.
- Les ombres utilisent le CSM de Three.js : quatre cartes 4096 × 4096 (bornées par la limite de texture du GPU), avec coupures à 10, 30, 72 et 144 blocs de profondeur pour la distance d'affichage par défaut. La précision linéaire est doublée par rapport aux cascades 2048, à couverture identique, au prix de quatre fois plus de texels. La première cascade concentre la précision près du joueur ; la dernière rejoint le brouillard. BasicShadowMap conserve des contours francs sans PCF ni flou. Three stabilise les projections sur la grille des texels en espace lumière ; le zoom et le redimensionnement reconstruisent leurs limites. Les faces externes du terrain projettent les ombres, avec un biais adapté à chaque résolution. Chaque pixel consulte une seule cascade, qui masque seulement la lumière directe du soleil. Les ressources GPU sont libérées à la désactivation. Ce choix privilégie la netteté et coûte quatre passes de profondeur ; les frontières peuvent présenter un changement de résolution. L'éclairage des avatars reste indépendant.
- La vSync dépend du navigateur ; la case reste verrouillée avec une explication visible. Aucune boucle de rendu artificiellement « déverrouillée » n'est présentée comme une désactivation de la synchronisation d'affichage.
- Le reflet cubemap mélangé à 2 % par le shader Java n'est pas reproduit. L'identité des palettes n'implique donc pas une identité de chaque pixel éclairé.
- Le rendu des glyphes peut légèrement différer entre le rasteriseur Java et celui du navigateur, avec le même fichier de police.

La vérification navigateur couvre l'accueil, le lobby, l'apparition et les menus. Le navigateur intégré refuse le verrouillage du pointeur : les sensations de visée et le HUD pendant un combat humain restent à vérifier dans un navigateur de bureau.

## Couleurs du terrain et des particules

La palette provient de `core/game/world/Chunk.java` (herbe selon la hauteur, pierre grise) et des couleurs du chêne dans `core/game/world/Block.java`. Le bruit est déterministe par coordonnée pour que serveur et clients génèrent la même couleur indépendamment de l'ordre de chargement. L'occupation des voxels et la géométrie ne changent pas.

Le mesher conserve le RGB brut et l'occlusion de `ChunkRenderer` (0,87 par voisin). Les anciens coefficients fixes par axe ont été retirés pour éviter un double ombrage. Le shader calcule désormais `RGB × 1,2 × (0,5 + 0,5 × max(normale · directionSoleil, 0) × visibilitéSoleil)`. Les normales et la direction du soleil sont en espace monde : tourner la caméra ne change pas l'éclairage. Les faces opposées au soleil et celles masquées par un obstacle ne reçoivent que la contribution ambiante, sans la réduire une seconde fois. Désactiver les ombres portées conserve l'éclairage directionnel des faces. La direction vers le soleil `(-2,3,-2)` normalisée est partagée entre le shader terrain, les projections CSM et la lumière des avatars dans `src/client/lighting.ts`. Les couleurs restent en flottants sans conversion sRGB ni ACES, et le brouillard horizontal reste celui de `world.frag`.

Le serveur ajoute `blockColor` RGB24 aux impacts de balle et de pelle, en capturant la couleur avant mutation. Le client conserve ainsi la bonne couleur même si le bloc est déjà détruit ou remplacé à la réception. Sang (.8,0,0), explosions (.5,.5,.5), variation scalaire ±.05 et shader RGB ×1,3 suivent `ParticlesBlood`, `ParticlesExplosion`, `Particle` et `entity.frag`. Les particules de soin/construction inventées ont été retirées ; les règles de soin/construction restent inchangées.
