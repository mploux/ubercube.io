# Ressources de référence

Les modèles OBJ/MTL, les sons WAV, la police `RifficFree-Bold.ttf` et les textures d'interface et de minicarte dans `public/assets` proviennent du projet UBERCUBE de Team Ubercube, fourni par Marc dans le dossier voisin `ubercube`.

Le fichier de licence fourni avec ce projet est conservé dans `public/assets/LICENSE.txt`. Les ressources ont été copiées ; aucun fichier du projet Java original n'a été modifié.

Three.js est utilisé sous sa licence MIT, présente dans la dépendance installée. Les versions exactes des dépendances sont enregistrées dans `bun.lock`.

Les algorithmes de relief et de chênes dans `src/shared/terrain-generation.ts` et `src/shared/vegetation.ts` sont adaptés des classes Java `Noise`, `NoisePass`, `Tree`, `OakTree` et `BigOakTree` du même projet. `src/shared/ruin-model.ts` contient une conversion compacte des 1 800 voxels de `res/structs/Bat1.vox`, avec ses couleurs. Ces références Team Ubercube sont couvertes par la licence GPL-3.0 fournie dans `public/assets/LICENSE.txt`. Les adaptations sont détaillées dans [la génération du terrain](docs/terrain-generation.md).

Le visuel `public/assets/social/ubercube-classic.png` est la capture historique liée dans le README du Java fourni par Marc : `https://i.imgur.com/D7qmGQP.png`. Il est réutilisé à sa demande pour la présentation et les aperçus de partage. PNG original inchangé, 1280 × 718, SHA256 `9eda5ef65e87ebe52b5b40e4f5e4b324c65ae244cd538c94183b63ae6d5341e9`.
