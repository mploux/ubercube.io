# Ressources de référence

Les modèles OBJ/MTL historiques, les sons WAV, la police `RifficFree-Bold.ttf` et les textures d'interface et de minicarte dans `public/assets` proviennent du projet UBERCUBE de Team Ubercube, fourni par Marc dans le dossier voisin `ubercube`. Le modèle RPG dédié décrit ci-dessous est une création pour ce portage.

Le fichier de licence fourni avec ce projet est conservé dans `public/assets/LICENSE.txt`. Les ressources ont été copiées ; aucun fichier du projet Java original n'a été modifié.

Le prototype Java `WeaponRPG`, dans la révision `54d2416^`, utilisait `res/weapons/AK47.vox`. Ce fichier est conservé dans `public/assets/weapons/rpg/AK47.vox` uniquement comme référence historique ; il n'est plus le modèle affiché du bazooka. `RPG.obj` et `RPG.mtl` sont une création polygonale originale pour ce portage, générée par `scripts/model-rpg.ts` et refaite après la revue de Marc le 21 septembre 2026. La révision suivante préserve la silhouette et la palette approuvées ; l'ogive originale est séparée en `RPG_rocket` et réutilisée en vol, et la lunette reçoit une ouverture intérieure et un verre transparent. Les tons bois/métal et le shader reprennent le style des armes UBERCUBE. Quatre photographies de RPG-7 ont été consultées à l'écran pour la silhouette et les proportions ; leurs liens sont consignés dans [la référence bazooka](docs/bazooka.md#modèle-dédié). Aucune photo ni géométrie externe n'a été copiée dans les ressources du jeu. Aucune nouvelle ressource sonore n'est ajoutée.

Three.js est utilisé sous sa licence MIT, présente dans la dépendance installée. Les versions exactes des dépendances sont enregistrées dans `bun.lock`.

cannon-es 0.20.0 simule les cadavres côté client. Sa licence MIT est conservée et distribuée dans [public/assets/cannon-es-LICENSE.txt](public/assets/cannon-es-LICENSE.txt).

Les algorithmes de relief et de chênes dans `src/shared/terrain-generation.ts` et `src/shared/vegetation.ts` sont adaptés des classes Java `Noise`, `NoisePass`, `Tree`, `OakTree` et `BigOakTree` du même projet. `src/shared/ruin-model.ts` contient une conversion compacte des 1 800 voxels de `res/structs/Bat1.vox`, avec ses couleurs. Ces références Team Ubercube sont couvertes par la licence GPL-3.0 fournie dans `public/assets/LICENSE.txt`. Les adaptations sont détaillées dans [la génération du terrain](docs/terrain-generation.md).

Le visuel `public/assets/social/ubercube-classic.png` est la capture historique liée dans le README du Java fourni par Marc : `https://i.imgur.com/D7qmGQP.png`. Il est réutilisé à sa demande pour la présentation et les aperçus de partage. PNG original inchangé, 1280 × 718, SHA256 `9eda5ef65e87ebe52b5b40e4f5e4b324c65ae244cd538c94183b63ae6d5341e9`.
