# Bazooka RPG — 21 septembre 2026

Publié le 21 septembre 2026 avec le protocole 4 ; voir [la preuve de publication](deployment.md#publication-du-bazooka-assaut--21-septembre-2026). Le bazooka est la deuxième arme du kit assaut, après l'AK-47. Le médic garde ses soins, son AK-47, ses grenades et sa pelle ; le sniper reste inchangé. La sélection par molette et les flèches tactiles utilisent le même inventaire validé par le serveur.

## Référence retrouvée

Le RPG a été introduit dans le Java par `ead4c0691e77ff7153687f579ac3f76fb22e50a5` (« Add Rocket Launcher (RPG) »), puis ralenti par `6ac27a9` (« Change RPG fire frequency »). Il a été supprimé lors de `54d2416` (« Updated LWJGL and switched to Maven »). La référence retenue est la dernière version avant cette suppression, `54d2416^`, et ses classes sous `src/fr/veridiangames/` :

- `core/game/entities/weapons/fireWeapons/WeaponRPG.java`, `FireWeapon.java` et `weapons/Weapon.java` : maniement, cadence, compteur et son.
- `core/game/entities/bullets/Bullet.java` : vol et distinction entre impact joueur et terrain.
- `core/network/packets/BulletHitPlayerPacket.java`, `DamageForcePacket.java`, `core/game/world/World.java` et `PhysicsEngine` : dégâts, terrain et souffle.
- `ParticlesSmoke`, `ParticleSystem`, `ModelVoxRenderer` et `res/weapons/AK47.vox` : fumée et ancien modèle voxel.

Ce prototype n'a pas de modèle de lance-roquettes dédié : `WeaponRPG` utilise `Model.AK47` et le son `AK47_SHOOT`. Le premier portage local reprenait ces deux choix. Le Java faisait voler la roquette à 30 blocs/s, infligeait 20 PV sur contact joueur sans explosion et appliquait un souffle sans dégâts radiaux sur contact terrain. Ces trois règles ont été remplacées à la demande de Marc lors de la revue du 21 septembre : vitesse doublée et explosion légèrement moins puissante qu'une grenade. Le son AK reste inchangé. Le fichier Java `public/assets/weapons/rpg/AK47.vox` est conservé uniquement comme référence historique.

## Modèle dédié

Le modèle est un maillage polygonal facetté original de RPG-7 : tube métallique continu, ogive olive conique, habillage en bois, deux poignées inclinées, sortie arrière évasée et optique décalée. Il est utilisé en vue FPS et sur les personnages distants. Il remplace le premier essai voxel après la revue de Marc et reprend les tons bois/métal et le rendu de l'AK-47 et de l'AWP. La silhouette et la palette approuvées sont conservées dans la révision suivante : seuls la séparation de l'ogive, l'intérieur de la lunette et le placement des vues changent.

`bun scripts/model-rpg.ts` régénère exactement `public/assets/weapons/rpg/RPG.obj` et `RPG.mtl` : 1 176 triangles, 656 sommets OBJ indexés et neuf matériaux. Il construit des surfaces planes, des cylindres à dix faces et une ogive conique, sans grille voxel. La palette et les normales passent par le même shader que l'AK-47 et l'AWP ; le chemin de rendu spécifique `legacyVox` a été retiré. Les 280 triangles de l'ogive approuvée forment désormais le sous-maillage `RPG_rocket`, sans changement de forme ni de couleur. Ce même maillage est affiché en vol à l'échelle `1/8`, avec son origine à la pointe ; la fumée sort 0,75 bloc derrière celle-ci.

Les capsules opaques qui fermaient la lunette sont ouvertes et munies d'une paroi intérieure. Le sous-maillage `RPG_lens` conserve une teinte légère avec 12 % d'opacité, sans écriture dans la profondeur. Le guidon `RPG_sights` reste présent sur le modèle et les autres joueurs ; il est masqué uniquement pendant la visée FPS pour dégager l'ouverture optique.

Les quatre références visuelles consultées à l'écran pour la silhouette et les proportions sont :

- [RPG chargé de profil — PRC68](https://www.prc68.com/I/Images/RPG7-13b.jpg).
- [Corps et ogive séparée — PRC68](https://www.prc68.com/I/Images/RPG7-07b.jpg).
- [Corps nu — ministère tchèque de la Défense](https://doarmady.mo.gov.cz/file/edee/o-armade/armypedia/vyzbroj/protitankove-zbrane/rpg-7/rpg-7-002.png).
- [RPG complet avec optique — IMA](https://www.ima-usa.com/cdn/shop/files/ONSV24OID016A__06.jpg?v=1738944754).

Aucune photo ni géométrie externe n'est copiée dans les ressources du jeu. Le recul et le point de départ brut `(0 ; -1,6 ; -24)` sont conservés. L'échelle de pose reste `(2 ; 2 ; -2)`, avant le facteur commun `1/16` : le modèle mesure 2,375 blocs, entre les longueurs de l'AK et de l'AWP. La pose FPS de visée aligne maintenant l'axe de la lentille avec la caméra ; le point de tir suit toujours l'échelle et la translation de la géométrie. En visée stabilisée, sa coordonnée locale est `(0,09 ; -0,145 ; 2)`, à la pointe du modèle. Le modèle et les règles ci-dessous sont publiés depuis le 21 septembre 2026 avec le protocole 4.

## Règles actuelles

| Élément | Comportement |
|---|---|
| Tir | Maintenir pour tirer tous les 62 ticks à 60 Hz ; une pause ou un changement d'arme ne remet pas le compteur à zéro. |
| Munitions | 30 au départ, indépendantes de l'AK ; retour immédiat à 30 après passage sous zéro. Pas de touche ni de délai de rechargement ajouté. |
| Roquette | 1 bloc par tick, soit 60 blocs/s, sans gravité ni rebond ; même ogive olive que sur le lanceur, avec fumée grise à l'arrière. L'ogive portée disparaît au tir et revient au terme des 62 ticks, sans ajouter de délai de tir. |
| Impact joueur | Déclenche une explosion ; 80 PV sur la cible directe, sans bonus tête ni ajout des dégâts radiaux. Le propriétaire est exclu du contact direct mais peut subir le souffle. |
| Dégâts radiaux | Même décroissance que la grenade jusqu'à 10 blocs : `floor((10-distance) × 8)`, contre `floor((10-distance) × 10)` pour la grenade. Les alliés et le tireur sont inclus. |
| Impact terrain | Rayon déterministe de 3,5 blocs, contre 4 pour la grenade ; atténuation des dégâts aux blocs `(1-distance/rayon) × 3` plafonnée à 1. Les impacts joueur détruisent aussi le terrain environnant. |
| Souffle | Impulsion des joueurs à 80 % de celle d'une grenade : composante horizontale dégressive et ajout vertical de 3,2. La déviation historique des grenades en vol est conservée ; les autres roquettes ne sont pas déviées. |
| Visée | Axe de la caméra à travers la lentille transparente, zoom et réticule de l'AWP : `zoomAmount = 150`, FOV stabilisé d'environ 11,655° et sensibilité de visée multipliée par 0,15. Le point blanc reste utilisé hors visée. |
| Maniement | Positions idle `(0,3 ; -0,18 ; -1,1)`, visée `(0,09 ; 0,055 ; -1)` et arme masquée `(0,3 ; -1,18 ; -1,1)` ; recul linéaire 0,2, recul angulaire 0,1 et dispersion de hanche ±0,02. |

## Intégration et limites

La simulation partagée assure le même comportement en multijoueur et dans le worker solo. Le serveur décide du tir, du stock, des collisions, des dégâts, du souffle et des mutations. Les événements et snapshots servent au rendu ; le client ne peut envoyer ni explosion, ni position de projectile, ni dégâts. Les commandes du médic et du sniper demandant le RPG sont refusées.

Les collisions continues contre les voxels et les boîtes de joueurs reprennent les frontières du moteur actuel. Le trajet entre l'œil et le canon est également contrôlé pour empêcher un lancement derrière une paroi. Le plafond et les limites de carte suivent le monde actuel ; une durée maximale liée à sa diagonale et le budget de projectiles bornent les tirs. Les fins de projectile, impacts, déconnexions prolongées et resets nettoient l'affichage. Les morts et changements d'arme ne retirent pas une roquette déjà tirée.

Le rendu distant porte l'arme abaissée sur les avant-bras au repos et au-dessus de l'épaule droite en visée, avec les deux mains aux poignées. Cette pose anatomique est distincte de la pose FPS. `PlayerVisuals.getRpgMuzzle` fournit sa pointe affichée au système d'effets : le départ de la roquette distante s'y raccorde puis rejoint sa trajectoire autoritaire en 100 ms. Ce décalage purement visuel est ignoré au-delà de 3 blocs ; aucune collision ni règle de tir serveur n'est déplacée. Les événements `shot` retirent seulement l'ogive portée pendant `62/60` seconde, sans masquer le tube ni la lunette.

Les dégâts et le souffle utilisent la distance aux pieds du joueur, comme les grenades du jeu actuel ; l'impulsion cosmétique du cadavre agit au torse et plafonne à 16, contre 20 pour une grenade. La fumée est bornée pour les scènes chargées et ses particules transparentes sont triées de loin vers près. Le shader commun aux armes conserve leurs palettes et leur éclairage facetté ; le reflet cubemap historique n'est pas reproduit. Les cadavres restent cosmétiques dans le système actuel. La révision de présentation ne change ni la vitesse, ni la cadence, ni les dégâts du RPG.

Le protocole passe de 3 à 4 : un ancien client ne sait pas interpréter l'arme RPG. Le code d'arme est ajouté à la fin de la table binaire ; la structure des enregistrements ne change pas, donc la version du format binaire reste 1. Le client et le serveur ont été mis à jour ensemble lors de la publication du 21 septembre 2026.

La référence Java a été inspectée en lecture seule, sans lancement ni compilation. Les tests automatisés et le contrôle GPU sont récapitulés dans [la validation](validation.md). Le modèle, la vitesse et les dégâts sont désormais des adaptations demandées par Marc ; la comparaison des autres sensations avec une session humaine du Java reste à faire.
