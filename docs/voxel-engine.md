# Moteur voxel : décisions et validation

Statut : cadrage initial du 11 septembre 2026, fondé sur une lecture ciblée du Java. Certains mécanismes décrits ici restent prévus. L'implémentation livrée et ses mesures sont décrites dans le [README](../README.md) et la [validation](validation.md). Le Java reste inchangé.

Conserver blocs colorés, construction, destruction progressive, explosions, végétation et silhouettes voxel. Le serveur décide des modifications et utilise les voxels exacts pour les collisions. Premier terrain borné et configurable, réinitialisé entre manches, sans effondrements ; objectif de 100 joueurs dans une même partie. Grande carte et visibilité seront des extensions mesurées, sans promesse de simulation illimitée.

## Ce que fait le Java

Les chemins ci-dessous sont dans `C:/Users/Marc/Documents/Dev/ubercube/src/main/java/fr/veridiangames/`.

| Constat statique | Référence | Conséquence pour la réécriture |
| --- | --- | --- |
| Chunks de 16³, chaque cellule stockée dans un `int[][][]`. | [Chunk.java](../../ubercube/src/main/java/fr/veridiangames/core/game/world/Chunk.java), lignes 36–77 | Garder une petite unité de modification, remplacer les tableaux imbriqués par des tableaux typés aplatis. |
| Le bruit de hauteur est calculé pour toute la carte ; tous les chunks des cinq étages sont ensuite créés, puis les arbres. | [WorldGen.java](../../ubercube/src/main/java/fr/veridiangames/core/game/data/world/WorldGen.java), lignes 63–68 et 95–133 ; [World.java](../../ubercube/src/main/java/fr/veridiangames/core/game/world/World.java), lignes 87–123 | Générer uniquement les régions nécessaires, avec un cache de hauteur par colonne de chunks. |
| Les couleurs utilisent à la fois un générateur aléatoire partagé et `Mathf.random`, qui appelle `Math.random`. | [Chunk.java](../../ubercube/src/main/java/fr/veridiangames/core/game/world/Chunk.java), lignes 106–124 ; [WorldGen.java](../../ubercube/src/main/java/fr/veridiangames/core/game/data/world/WorldGen.java), lignes 144–151 ; [Mathf.java](../../ubercube/src/main/java/fr/veridiangames/core/maths/Mathf.java), lignes 136–144 | Ne pas transposer ce flux aléatoire mutable : changer l'ordre de génération doit laisser le résultat identique. |
| Les arbres écrivent dans le monde au-delà de leur chunk d'origine. | [Tree.java](../../ubercube/src/main/java/fr/veridiangames/core/game/world/vegetations/trees/Tree.java), lignes 86–105 et 184–186 | Définir des origines de structures stables et leur recouvrement des chunks voisins. |
| Les modifications sont conservées dans une liste, avec recherche linéaire par position. | [World.java](../../ubercube/src/main/java/fr/veridiangames/core/game/world/World.java), lignes 508–533 | Indexer les modifications par chunk et cellule ; ne pas rechercher dans l'historique complet à chaque lecture. |
| L'« alpha » encode la résistance restante ; les dégâts assombrissent aussi la couleur. L'encodage utilise 127 pour une résistance pleine. | [World.java](../../ubercube/src/main/java/fr/veridiangames/core/game/world/World.java), lignes 541–561 ; [Color4f.java](../../ubercube/src/main/java/fr/veridiangames/core/utils/Color4f.java), lignes 280–287 et 333–343 | Conserver le comportement et la couleur endommagée ; ne pas envoyer cette résistance comme transparence Three.js. |
| L'explosion parcourt une boîte, filtre une sphère, applique une atténuation puis marque les cellules modifiées. | [World.java](../../ubercube/src/main/java/fr/veridiangames/core/game/world/World.java), lignes 564–604 | Borner le travail à l'intersection avec les chunks concernés ; regrouper les écritures et les notifications. |
| Le rendu élimine déjà les faces cachées, mais reconstruit tout le maillage de chaque chunk demandé et le renvoie au GPU. AO calculée avec les voisins, y compris diagonaux. | [ChunkRenderer.java](../../ubercube/src/main/java/fr/veridiangames/client/rendering/renderers/game/world/ChunkRenderer.java), lignes 88–149 et 179–225 ; [WorldRenderer.java](../../ubercube/src/main/java/fr/veridiangames/client/rendering/renderers/game/world/WorldRenderer.java), lignes 57–78 | Les gains viennent aussi de l'ordonnancement, des allocations, des formats GPU et de la fusion compatible des faces. |
| La synchronisation des blocs transmet des quadruplets entiers et les applique un à un. | [SyncBlocksPacket.java](../../ubercube/src/main/java/fr/veridiangames/core/network/packets/SyncBlocksPacket.java), lignes 44–54 et 88–104 | Envoyer des lots versionnés par chunk et organiser l'arrivée en cours de partie. |
| Le monde fabrique des colliders par bloc proche ; les corps réseau évitent leur collision locale. | [World.java](../../ubercube/src/main/java/fr/veridiangames/core/game/world/World.java), lignes 458–481 ; [Rigidbody.java](../../ubercube/src/main/java/fr/veridiangames/core/physics/Rigidbody.java), lignes 177–191 | Le serveur doit résoudre le mouvement, en interrogeant la grille sans allouer un objet par voxel. |

## Représentation et frontières

Garder des chunks de **16 × 16 × 16 cellules** pour borner le travail d'une modification. La taille d'un éventuel lot de rendu reste indépendante de celle du chunk de simulation.

Stockage initial : un `Uint32Array` aplati pour un chunk matérialisé, avec représentation explicite du chunk vide généré. Une cellule vaut zéro pour l'air ; le mot non nul contient RGB et résistance quantifiée. Ce sont des valeurs de simulation nommées, pas une couleur ARGB interprétée automatiquement par le moteur graphique. La sortie de rendu est opaque et tire son RGB de l'état endommagé. Le format Java 0..127 est décodé explicitement pour la référence ; les arrondis de dégâts doivent être fixés par des cas de compatibilité.

Pas d'objet par bloc, d'octree ou de registre de matières spéculatif. Après histogrammes et mesures des écritures, envisager un état uniforme ou une palette locale avec indices 8/16 bits uniquement si le coût complet diminue. Garder le tableau direct comme repli ; couleurs et dommages peuvent annuler le gain d'une palette. Aucune quantification des couleurs pour améliorer artificiellement les chiffres.

Un chunk direct représente **16 Kio** de cellules. Une carte de 1 024 × 128 × 1 024 voxels entièrement matérialisée représente **512 Mio**, avant historique, copies workers et rendu. La génération et la résidence à la demande restent nécessaires pour agrandir la carte. Un chunk absent du cache n'est **pas** de l'air : il peut être non généré, demandé ou évincé. Le serveur attend les données exactes avant de valider déplacement, apparition ou tir dans cette région.

Frontières proposées, sans couche d'interfaces supplémentaire :

- `src/shared/voxel` : coordonnées et limites, lecture des cellules, génération déterministe, règles de requêtes voxel. Aucune dépendance Three.js, Bun, DOM ou socket.
- `src/shared/simulation` : déplacement et règles de dégâts/construction utilisant le voxel. La prédiction cliente réutilise les règles nécessaires ; seul le serveur valide et publie le résultat.
- `src/shared/protocol` : représentation réseau des régions, versions et lots de modifications. Le format mémoire interne n'est pas exposé comme contrat réseau implicite.
- `src/server` : propriétaire du monde mutable, ordre du tick, chargement, révisions, journal récent et synchronisation des abonnés.
- `src/client` : cache des copies autoritaires, prédiction temporaire séparée, workers de génération/maillage, ressources Three.js et priorités visuelles.

## Génération cohérente à la demande

L'identité du terrain est `(roundId, seed, generatorVersion, paramètres)`. La version couvre aussi les structures, la distribution des couleurs et les zones réservées au mode de jeu. Les coordonnées absolues et un hash entier stable déterminent chaque bruit et chaque variation : aucun `Math.random`, ordre global ou temps courant dans le générateur. Les seuils de hauteur et les conversions numériques sont explicitement déterminés et testés entre Bun et les navigateurs.

Pour chaque chunk demandé : calculer la hauteur locale, remplir la matière, appliquer les structures déterministes qui l'intersectent, puis appliquer ses modifications autoritaires. Chaque structure possède une origine stable et une portée bornée ; les chunks produisent leur intersection dans un ordre fixé. Un arbre n'écrit pas dans un voisin en cours de génération. Les zones réservées au TDM/FFA font partie des paramètres.

Le client peut régénérer le terrain de base pour économiser du réseau seulement après validation de la concordance des empreintes. Au premier jalon, les snapshots serveur peuvent rester complets et bornés ; ce chemin sert aussi au rattrapage en cas de divergence. Les modifications autoritaires s'appliquent après la génération, y compris si elles arrivent avant la fin d'un travail worker. Un résultat tardif ne doit jamais faire repousser un bloc détruit.

Pools et files de workers obligatoirement bornés et configurables. Commencer par les workers client ; déplacer la génération serveur seulement si les mesures le justifient. Un seul propriétaire écrit le monde serveur ; les workers rendent des résultats purs, identifiés et versionnés.

## Destruction, construction et collisions

Le serveur valide portée, visibilité, cadence, ressources, cible et règles de placement depuis le joueur autoritaire. Conserver les limites de carte et le sol protégé observé dans `World.removeBlock`. L'apparition doit utiliser le **terrain actuel**, avec construction et destruction, et vérifier le volume libre : `World.getHeightAt` (ligne 610) renvoie la hauteur du générateur, qui ne suffit pas après modification.

Les rayons interrogent les cellules exactes par parcours de grille ; les volumes mobiles interrogent le volume balayé des cellules candidates. Pas de collision avec les triangles du rendu ni avec le LOD. Le périmètre collision inclut la vitesse et les projectiles, pas seulement une distance visuelle autour de la caméra.

Pour une explosion, visiter les chunks intersectant la sphère, ignorer ceux connus vides et tester les cellules concernées. Appliquer les dégâts dans l'ordre du tick, puis produire un lot final par chunk, incrémenter sa révision et dédupliquer les invalidations. Plusieurs coups sur une cellule sont résolus avant de transmettre sa valeur finale.

Reconstruire le maillage des **petits chunks touchés** est acceptable au premier palier. Reconstruire le monde ou tous les chunks visibles ne l'est pas. Les voisins sont invalidés lorsque leurs faces/AO dépendent d'une cellule modifiée ; avec un halo d'une cellule, cela inclut les diagonales aux coins et arêtes. Aucun calcul de connectivité structurelle pour le moment.

Les explosions simultanées font partie de la charge à mesurer. Les files peuvent différer maillage et paysage, sans oublier des modifications ni masquer une accumulation de retard logique.

## Maillage et rendu

Première référence correcte : suppression des faces internes, positions locales au chunk, sommets indexés par face, couleurs par sommet et un matériau terrain partagé. Pas un `Mesh` ou un matériau par bloc. Three.js prend en charge les attributs et les indices dans `BufferGeometry` ; séparer un maillage en groupes multiplie les appels de dessin. [Documentation BufferGeometry](https://threejs.org/docs/pages/BufferGeometry.html).

Comparer ensuite le greedy meshing à cette référence. Fusionner les faces coplanaires de couleur, orientation, matériau et éclairage compatibles. Préserver l'interpolation sur toute la surface : commencer par couleur identique et AO uniforme identique, puis garder les faces unitaires ailleurs. Les variantes colorées peuvent limiter le gain ; ne pas changer l'identité visuelle pour favoriser la fusion.

Le worker de maillage reçoit un snapshot du chunk et un halo d'une cellule, avec révisions des voisins. Le résultat référence ces dépendances ; le client le rejette si l'une a changé. Ne pas transférer à un worker l'unique buffer vivant dont la simulation a encore besoin : le transfert d'un `ArrayBuffer` retire son accès à l'émetteur. Utiliser un snapshot temporaire ou une propriété de buffer bien définie, et compter cette mémoire. [Documentation des objets transférables](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects).

La file contient au plus le travail utile pour chaque chunk. Si une explosion arrive pendant son maillage, demander sa dernière version plutôt qu'empiler chaque état intermédiaire. Priorités : terrain immédiat, zone visée, trajectoire de déplacement, puis paysage. Remplacer la géométrie de façon atomique et libérer l'ancienne avec `dispose()`. Budgéter aussi les uploads GPU sur le thread principal. [Libération des géométries Three.js](https://threejs.org/docs/pages/BufferGeometry.html#dispose).

## Arrivée tardive, caches et réinitialisation

Un snapshot décrit `roundId`, l'identité du générateur, les coordonnées, la révision et les cellules du chunk à cette révision. Un delta indique `fromRevision`, `toRevision` et les changements. Le client applique un delta seulement sur la version attendue ; il ignore un doublon et demande un snapshot s'il manque une continuité. Ne pas supposer que le transport résout à lui seul les changements d'abonnement, les reconnexions ou les tâches asynchrones.

À l'abonnement, le serveur capture un snapshot à la révision R et ordonne les modifications suivantes pour cet abonné. L'envoi fractionné conserve la même identité de snapshot et une taille maximale validée. Si le journal récent ne permet plus le rattrapage, recommencer depuis un snapshot récent. La synchronisation doit converger même lorsqu'un joueur rejoint pendant plusieurs explosions.

Le cache client est évictable, avec priorité au mouvement et au combat. Une éviction serveur ne peut perdre ni construction, ni trou, ni dommage : conserver les écarts au terrain de base par chunk. Le journal réseau récent est borné, distinct de l'état à conserver jusqu'à la fin de manche. Cet état peut grandir avec la carte modifiée ; le mesurer sans le considérer comme un cache librement effaçable.

Au changement de manche, changer `roundId`, abandonner les travaux et messages de l'ancien monde, puis vider les états et ressources associés. Un numéro de révision seul ne distingue pas deux incarnations du même chunk.

## Grande visibilité et sniper

Premier jalon : carte bornée avec terrain exact. Mesurer résidence, rendu et région de combat séparément. Le LOD lointain viendra après : une heightmap perd tunnels et surplombs ; simplifier un mur ou un trou peut fausser la lecture des couvertures. Il faudra valider raccords et propagation des modifications, conserver les régions utiles au tir exactes et précharger la visée sniper avant le clic. Tant que ces conditions ne tiennent pas, la configuration reste dans les distances exactes validées, sans réduire silencieusement la portée des armes.

La compensation de latence des joueurs doit être coordonnée avec l'historique des modifications du terrain : rembobiner une cible tout en utilisant arbitrairement un autre état de son couvert est incorrect. Le contrat de temps et la fenêtre retenue appartiennent au serveur ; le moteur voxel expose les changements nécessaires, avec une mémoire bornée et mesurée.

## Mesures et budgets à fixer au benchmark

Enregistrer matériel, système, navigateur, résolution, version Bun, graine, dimensions et réseau. Les scénarios à 100 joueurs incluent mouvement, tirs, construction et explosions, avec joueurs groupés puis dispersés. Les budgets RAM, GPU, bande passante et latence visuelle seront fixés sur ces mesures. Les files et plafonds d'envoi par client et globaux doivent déjà être bornés et configurables.

| Ressource | Mesure | Critère utile |
| --- | --- | --- |
| Simulation serveur à 60 Hz | Travail du tick p50/p95/p99, maximum, dépassements et part terrain/collisions. | p99 du travail du tick < 16,67 ms, avec marge recherchée et aucune accumulation de retard. |
| Mémoire serveur | Cellules, modifications conservées, journal récent, copies et files, séparément du RSS total. | Budget fixé au benchmark ; aucune perte d'état pour rester sous un seuil. |
| CPU/GPU client | Temps de frame p95/p99, maillage, uploads et retard réception → affichage correct d'une destruction. | Budgets fixés sur matériel de référence ; les couvertures proches priment sur le paysage. Aucune régression de version. |
| Maillages et mémoire client | Quads, octets CPU/GPU, copies en attente, ratio de fusion et temps par type de chunk. | Comparer faces unitaires et greedy sur terrain, arbres, damier, multicolore et dommages. Libérer les anciens buffers. |
| Réseau et arrivée tardive | Octets initiaux, débits moyen/pointe par client et agrégés, files, durée de rattrapage et snapshots recommencés. | Convergence pendant destructions continues ; jeu prioritaire, files bornées et aucun joueur actif sur terrain inconnu. |

La géométrie peut dominer la mémoire : suivre les octets des buffers et copies, en complément des compteurs `renderer.info`, qui ne mesurent pas toute la VRAM. [Documentation WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html#info).

## Étapes et critères de sortie

1. **Référence fonctionnelle compacte.** Chunk aplati, air explicite, générateur local versionné, accès collision exact, modification serveur et snapshot complet. Cas obligatoires : coordonnées négatives si autorisées, bords de carte/chunks, placement/destruction, dommages successifs, sol protégé, arbre traversant un chunk. Destruction/reconstruction/rechargement donnent le même état final.
2. **Chemin jouable et workers.** Maillage de faces, AO locale, invalidations avec halo, résultats versionnés et file bornée. Une rafale et une explosion en bord de chunk ne laissent ni face manquante permanente, ni ancienne couleur, ni résultat de manche précédente. Contrôler le nombre de chunks remeshing ; il dépend des zones touchées.
3. **Synchronisation sous changements.** Arrivée tardive, delta manquant, doublon, snapshot découpé, éviction, reconnexion et reset pendant travail worker. Les empreintes des chunks convergent vers le serveur ; le journal et les files restent bornés.
4. **Optimisations mesurées.** Comparer greedy et formats palette au stockage et maillage de référence. Retenir seulement les gains établis sur le coût complet, incluant écritures, conversions et copies. Mesurer 100 joueurs avec construction, tirs et explosions simultanés dans un lieu, puis répartis sur la carte.
5. **Extension de carte et visibilité.** Agrandir progressivement avec le même scénario reproductible. Ajouter le LOD lorsque les données identifient son besoin ; valider les couvertures sniper et le coût des modifications lointaines avant de publier une distance supportée.

Le premier succès est un terrain correct et cohérent entre plusieurs clients et un serveur indépendant. La capacité à 100 joueurs et les dimensions maximales ne sont acquises qu'après les étapes de charge correspondantes.
