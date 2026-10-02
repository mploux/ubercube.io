# Ressources de référence

## Cartes Ace of Spades intégrées le 2 octobre 2026

Hallway C.1 à C.9 et Breakthrough C.0 sont de CorellanStoma (Daniel Klingel), Copyright (c) 2021 Daniel Klingel, sous MIT. Source : [Hallway-C, révision 366dcd4](https://github.com/CorellanStoma/Hallway-C/tree/366dcd445b964d46b13e93d38cd87f9435624c55). La [notice MIT complète](public/map-credits/licenses/Hallway-C-MIT.txt) est distribuée avec les cartes. Hallway C reprend le concept de Hallway d'Izzy.

Triangle Hell et Empty Ocean sont de Lancilloty, sous GPL-3.0, avec permissions explicites dans les [PR 6](https://github.com/SpadesX/Maps/pull/6) et [8](https://github.com/SpadesX/Maps/pull/8). Source : [SpadesX/Maps, révision 1dc37fd](https://github.com/SpadesX/Maps/tree/1dc37fd59ad274aa6dd5eaf60086bd799e69e430). Triangle Hell est inspirée de Hallway 2.0. La [GPL complète](public/map-credits/licenses/SpadesX-GPL-3.0.txt), les VXL originaux, les métadonnées auteur et les sources du convertisseur sont distribués dans `public/map-credits/`. Les cartes adaptées restent sous GPL-3.0.

Les adaptations du 2 octobre 2026 conservent géométrie et couleurs de surface, inversent l'axe vertical et attribuent aux solides cachés la couleur de la surface verticale la plus proche. Les scripts, objectifs CTF et dégâts d'eau ne sont pas portés. Les zones d'apparition du catalogue utilisent les bases ou rectangles des auteurs, avec des hauteurs de sol vérifiées dans les voxels convertis. Le catalogue conserve les sources exactes, licences, révisions et empreintes. Les mentions sont accessibles dans le jeu depuis l'accueil et la pause : [page distribuée](public/map-credits/index.html).

## Ressources Ubercube et dépendances

Les modèles OBJ/MTL historiques, les sons WAV, la police `RifficFree-Bold.ttf` et les textures d'interface et de minicarte dans `public/assets` proviennent du projet UBERCUBE de Team Ubercube, fourni par Marc dans le dossier voisin `ubercube`. Le modèle RPG dédié décrit ci-dessous est une création pour ce portage.

Le fichier de licence fourni avec ce projet est conservé dans `public/assets/LICENSE.txt`. Les ressources ont été copiées ; aucun fichier du projet Java original n'a été modifié.

Le prototype Java `WeaponRPG`, dans la révision `54d2416^`, utilisait `res/weapons/AK47.vox`. Ce fichier est conservé dans `public/assets/weapons/rpg/AK47.vox` uniquement comme référence historique ; il n'est plus le modèle affiché du bazooka. `RPG.obj` et `RPG.mtl` sont une création polygonale originale pour ce portage, générée par `scripts/model-rpg.ts` et refaite après la revue de Marc le 21 septembre 2026. La révision suivante préserve la silhouette et la palette approuvées ; l'ogive originale est séparée en `RPG_rocket` et réutilisée en vol, et la lunette reçoit une ouverture intérieure et un verre transparent. Les tons bois/métal et le shader reprennent le style des armes UBERCUBE. Quatre photographies de RPG-7 ont été consultées à l'écran pour la silhouette et les proportions ; leurs liens sont consignés dans [la référence bazooka](docs/bazooka.md#modèle-dédié). Aucune photo ni géométrie externe n'a été copiée dans les ressources du jeu. Aucune nouvelle ressource sonore n'est ajoutée.

Three.js est utilisé sous sa licence MIT, présente dans la dépendance installée. Les versions exactes des dépendances sont enregistrées dans `bun.lock`.

cannon-es 0.20.0 simule les cadavres côté client. Sa licence MIT est conservée et distribuée dans [public/assets/cannon-es-LICENSE.txt](public/assets/cannon-es-LICENSE.txt).

Les algorithmes de relief et de chênes dans `src/shared/terrain-generation.ts` et `src/shared/vegetation.ts` sont adaptés des classes Java `Noise`, `NoisePass`, `Tree`, `OakTree` et `BigOakTree` du même projet. `src/shared/ruin-model.ts` contient une conversion compacte des 1 800 voxels de `res/structs/Bat1.vox`, avec ses couleurs. Ces références Team Ubercube sont couvertes par la licence GPL-3.0 fournie dans `public/assets/LICENSE.txt`. Les adaptations sont détaillées dans [la génération du terrain](docs/terrain-generation.md).

Le visuel `public/assets/social/ubercube-classic.png` est la capture historique liée dans le README du Java fourni par Marc : `https://i.imgur.com/D7qmGQP.png`. Il est réutilisé à sa demande pour la présentation et les aperçus de partage. PNG original inchangé, 1280 × 718, SHA256 `9eda5ef65e87ebe52b5b40e4f5e4b324c65ae244cd538c94183b63ae6d5341e9`.
