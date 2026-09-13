# Terrain Java et bâtiments — 13 septembre 2026

Cette version est publiée sur le serveur Hetzner et le client Vercel depuis le 13 septembre 2026. Le dépôt Java voisin a été utilisé en lecture seule. Les preuves de publication figurent dans [la procédure de déploiement](deployment.md#publication-du-terrain-java-et-des-bâtiments--13-septembre-2026).

## Référence et adaptations

Le chemin actif `Game.createWorld` du Java choisit `SNOWY`. Le relief reprend ses trois passes de bruit, leur combinaison par maximum et leur décalage de hauteur. Les opérations en précision float et le générateur `java.util.Random` sont reproduits ; des valeurs calculées par les classes Java compilées servent de références aux tests. La hauteur reste bornée au monde configuré.

Le sol reprend la roche grise, le dégradé d'herbe selon l'altitude et la transition probabiliste vers la neige. `OakTree` et `BigOakTree` fournissent les dimensions des troncs, les couronnes sphériques, les groupes de feuilles et les branches. Les chênes ordinaires ont un tronc de 2 × 2 sur 10 blocs ; les grands chênes, 3 × 3 sur 20 blocs. Les règles de candidature, d'altitude, de rareté dans le biome enneigé et de proportion des grands chênes sont reprises.

Le Java consomme un aléatoire global dépendant de l'ordre de génération. Ici, les candidats et la forme de chaque arbre sont déterminés par la graine et leur chunk d'origine ; les variations de couleur dépendent des coordonnées. La forme et les palettes sont reprises, mais une même graine ne promet pas les mêmes emplacements d'arbres ni chaque nuance du Java. Serveur, navigateur, solo et workers doivent reconstruire le même monde quel que soit l'ordre de lecture. Les arbres traversent les limites de chunks ; ceux dont le tronc tomberait sur un bâtiment ou son accès sont supprimés entièrement.

## Bâtiments

Deux variantes occupent des sites déterministes espacés de 64 blocs, lorsque la pente et les limites du monde le permettent. Les abords des deux zones d'arrivée TDM restent libres. Les cartes de moins de 96 blocs de côté ne reçoivent pas de bâtiment.

- **Ruine** : conversion du modèle historique `res/structs/Bat1.vox`, conservant ses 1 800 voxels et couleurs dans les données sources compactes. À la pose, le socle est enterré, deux entrées sont ouvertes et un escalier rejoint l'étage pour rendre le modèle praticable.
- **Hangar** : volume bas à ossature bois, deux sorties opposées, fenêtres latérales et toit enneigé. L'intérieur reste dégagé.

Les orientations varient, les fondations suivent le relief et les abords limitent les changements de hauteur à un bloc. Murs, toits, escaliers et arbres sont des voxels ordinaires : les tirs, grenades, outils, synchronisation des destructions et resets utilisent les mécanismes existants. Aucun objet décoratif doté d'une collision séparée n'a été ajouté.

## Stockage et compatibilité

`VoxelWorld` conserve trois caches bornés à 256 entrées chacun : hauteurs compactes, plans de bâtiments et colonnes générées avec végétation clairsemée. Le monde complet n'est pas alloué par avance. Les modifications de la manche restent séparées du monde de base et survivent à l'éviction des caches. Les apparitions cherchent un support et un volume libre à partir du sol naturel, pour éviter de placer les joueurs sur les couronnes ou les toits.

Le protocole de connexion passe à **2** : une ancienne version reconstruirait un terrain différent tout en recevant seulement les modifications. Les clients incompatibles sont refusés avant l'envoi du monde. **Le serveur Hetzner et le client Vercel ont été publiés ensemble** ; le redémarrage du serveur a réinitialisé la partie. Une page restée ouverte sur l'ancienne version doit être rechargée. Le format binaire des snapshots reste inchangé.

## Vérification

Les 281 tests passent, avec 12 524 assertions ; TypeScript strict et compilation client passent également. Les références Java couvrent 32 hauteurs sur quatre graines et deux formes complètes d'arbres. Les tests protègent les quatre orientations des accès, les escaliers, les destructions, l'arrivée tardive, le reset, l'indépendance à l'ordre de génération et 100 apparitions praticables dans chacun des modes TDM et FFA.

Un banc navigateur utilisant le vrai `VoxelWorld`, les workers de maillage, le matériau et les ombres a produit six captures inspectées : panorama, chêne, ruine, extérieur et intérieur du hangar, profil mobile. Aucun échec JavaScript ou rendu relevé. Sur 24 472 voxels échantillonnés, Bun et les deux profils Edge produisent la même empreinte. Preuves locales : `.runtime/terrain-review/`, dont `comparison.json` et les captures PNG. Ce contrôle ne remplace pas une partie humaine ni un téléphone physique.

Un essai local TDM de 16 secondes a maintenu 100 clients WebSocket actifs, avec déplacements, tirs, grenades et outils : aucun input perdu, tick abandonné ou erreur client ; tick p95 2,41 ms, p99 3,77 ms, maximum 8,66 ms. RSS finale 211 Mo ; trafic reçu agrégé des 100 clients environ 295 Mbit/s. Serveur et clients partageaient la machine de développement : cette courte régression ne certifie pas la charge Internet, Hetzner, les grandes cartes ni 100 navigateurs. [Rapport](benchmarks/2026-09-13-terrain-tdm-100.json).
