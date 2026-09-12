# Validation des 11 et 12 septembre 2026

Cette livraison est une première version locale fonctionnelle. La parité des sensations avec le Java, la tenue prolongée sur Internet et les grandes distances d'affichage ne sont pas encore validées.

## Mobile — 12 septembre

`bun run check` passe avec 191 tests et 8908 assertions. Les dix tests tactiles couvrent joystick analogique, deadzone, sprint, captures indépendantes, visée et tir simultanés, pressions brèves, boutons désactivés, libération après changement d'arme et annulation sans relâchement artificiel.

Le navigateur a affiché l'accueil, le lobby et la partie aux formats 390 × 844 et 844 × 390, ainsi que les réglages à 320 × 568 et 568 × 320. Les trois choix d'équipement mesurent chacun 93 × 48 pixels à 320 pixels de large. Le retour des réglages est atteignable par défilement en paysage court. Un appui natif bref sur Tirer a consommé une munition. Le parcours desktop reste accessible avec les commandes tactiles masquées.

Un banc de test local émule le pointeur principal tactile et l'absence de l'API Pointer Lock, puis pilote le vrai client et son Worker solo. Ses 16 contrôles passent : déplacement autoritaire, déplacement/visée/tir simultanés, balles, saut/visée, changement d'arme, grenade annulée sans lancer, commande d'annulation transmise, grenade relâchée exactement une fois, commande de construction, scores, pause/reprise et perte de focus. Les gestes multi-doigts de ce banc utilisent des événements synthétiques et une capture simulée ; le rendu et les échanges avec la simulation sont réels. Aucun diagnostic JavaScript dans ces essais. Aucun code du banc de test n'est inclus dans la publication.

Limite : pas de téléphone iOS/Android physique disponible pour mesurer les performances, le clavier virtuel et le ressenti tactile. Les essais à dimensions mobiles sur la machine de développement ne remplacent pas cette validation matérielle.

## Maniement des armes et balles

Validation finale : `bun run check` passe avec TypeScript strict, 122 tests (7652 assertions) et compilation du client. Les transitions de boutons lors d'un changement d'arme sont testées côté serveur et vue FPS, notamment le relâchement de l'AK au moment de sélectionner la grenade.

Les règles de pose/cadence sont maintenant partagées entre client et serveur et issues des updates Java à 60 Hz. Les tests couvrent cadence AK8/AWP62, ordre du recul et du renouvellement des chargeurs, zoom, mouvement/souris, transitions entre armes, clics rapides, annulation de charge, soins et pelle. Les tirs transportent une origine/vitesse et un identifiant autoritaires ; des régressions vérifient le tir suivi d'un impact dans le même tick, l'expiration et la protection contre un canon traversant un mur. La trajectoire libre des grenades est comparée à 600 sous-pas de la formule Java.

Le harness WebGL passe 64 contrôles : il inclut désormais les balles jaunes (312 pixels RGB 255,255,0 pour un tir touchant avant la première image), leur disparition et leur déplacement sans nouveau snapshot. Les cinq modèles originaux ont été chargés, leurs pixels inspectés au repos, en visée/recul ou pendant l'action de l'outil ; les trois aperçus tournants et le retour à la vue FPS passent également. Les dix OBJ/MTL ont le même SHA256 que les assets Java. Le parcours accueil → lobby → Assault et le modèle en jeu ont été observés sans diagnostic JavaScript/WebGL. Les 385 fichiers du jeu original restent intacts.

Deux tests de 30 s avec 100 clients actifs sur une carte concentrée de 64 × 64 × 64 ont réussi, avec déplacements, tirs, outils, destructions et réapparitions. Le serveur FFA réinitialise la manche toutes les 10 s. Aucun client perdu, aucune erreur, aucun tick abandonné ni commande perdue ; TDM p95 1,53 ms / p99 1,76 ms / maximum 10,45 ms, FFA p95 3,00 ms / p99 4,31 ms / maximum 10,78 ms. RSS finale 187 Mo / 179 Mo. Les mesures partagent la même machine ; elles ne mesurent pas 100 rendus navigateur ni Internet. Rapports : [armes TDM](benchmarks/2026-09-11-weapons-tdm-100.json), [armes FFA et resets](benchmarks/2026-09-11-weapons-ffa-100.json).

La capture du pointeur reste refusée dans le navigateur intégré ; la sensation en contrôle libre n'est donc pas validée. La collision des grenades conserve le raycast voxel serveur plutôt que la boîte Java. L'animation et le son du tireur sont prédits ; les balles et leurs impacts sont affichés à partir des événements serveur. Les écarts explicites sont détaillés dans [la référence gameplay](gameplay-client.md).

## Vérifications exécutées

Correction du build Vercel et ajout du solo : `bun run check` passe avec 181 tests et 8849 assertions. Le build réel est testé dans un répertoire isolé avec adresse absente, vide, HTTPS, HTTP et chemin invalide. L'absence d'adresse sur Vercel active maintenant le solo ; une adresse fournie invalide reste refusée. Un vrai Worker Bun vérifie pseudo → lobby → apparition, mouvement, tirs AK47 et destruction d'un bloc, monde neuf à la session suivante et suspension/reprise des ticks. Le nettoyage de l'adaptateur et les anciens callbacks sont également testés. La simulation déplacée dans `src/shared/game.ts` est identique à l'ancienne, à l'exception des chemins d'import.

Dans un navigateur réel, le build Vercel sans serveur a permis d'entrer en solo, d'afficher le HUD/arme/minicarte et de revenir au lobby d'une nouvelle partie, sans requête `/api/status` ni WebSocket. Les trois pannes HTTP indisponible, WebSocket refusé et WebSocket ouvert mais muet conduisent au lobby solo. Avec le vrai serveur Bun disponible, le même client a rejoint le lobby puis une partie TDM avec équipement Sniper, sans diagnostic JavaScript. Le navigateur intégré refuse toujours la capture du pointeur : les tirs et déplacements sont validés par le test Worker, pas par un contrôle FPS libre dans ce navigateur. Le build local a été restauré après ces essais.

Préparation initiale Vercel + serveur Bun séparé : 176 tests et 8804 assertions validaient les adresses client HTTP/WSS, les origines autorisées et refusées, HTTP et les upgrades WebSocket. Un navigateur réel avait rejoint le lobby depuis un client statique sur le port 3013 vers le serveur Bun sur le port 3012 sans erreur CORS/JavaScript. Les 385 fichiers Java avaient été vérifiés intacts. Le Dockerfile est fourni, mais l'image n'a pas été construite faute de Docker local ; l'hébergement multijoueur permanent reste à fournir.

Après suppression du délai de lancer local : `bun run check` passe avec 151 tests, 8594 assertions et compilation du client. La grenade est prédite dès le tick de relâchement avec les règles de lancement et de vol désormais partagées avec le serveur. Les tests vérifient des confirmations à 0/50/150/300 ms, l'absence de duplication et de saut lors des corrections, les murs, le refus d'un lancer, la mort/réapparition, les réservations de stock, la saturation du rendu et le reset. Le vol reste indépendant du rendu à 30/60/144 Hz. Les règles de collision, de charge et de détonation serveur sont préservées ; aucun champ réseau supplémentaire n'est nécessaire.

Le harness passe 81 contrôles GPU, dont cinq nouveaux : modèle visible sans aucun message réseau, mouvement avant la réponse à 120 ms, même matrice et mêmes pixels au moment de la confirmation malgré une correction d'origine/vitesse, reset et refus. Captures inspectées sans diagnostic JavaScript/WebGL. Les 385 fichiers Java restent intacts. La vérification couvre le code de rendu et une latence simulée ; aucun nouvel essai Internet ni contrôle FPS libre dans le navigateur intégré n'est revendiqué.

La simulation serveur partagée a également tenu 100 clients actifs pendant 30 s en TDM sur 64 × 64 × 64 : aucune erreur, déconnexion, commande perdue ou tick abandonné. Temps de tick p95 1,81 ms / p99 2,31 ms / maximum 20,56 ms, RSS finale 194 Mio. Serveur et bots partagent la machine ; ce test ne mesure pas 100 rendus navigateur. Rapport : [prédiction de grenade, 100 clients](benchmarks/2026-09-11-grenade-prediction-tdm-100.json).

Après remplacement du bloc de grenade et interpolation du vol : `bun run check` passe avec 137 tests et 7795 assertions. Les onze tests de présentation grenade couvrent la géométrie/palette originale, l'échelle 1/16, le mouvement entre snapshots, l'équivalence à 30/60/144 Hz, la gigue, les rebonds, l'identité des projectiles, l'explosion, le reset et le chargement différé. Un cas exerce 100 grenades dans une seule géométrie instanciée. La récupération après une pause serveur de 200 ms évite de perdre définitivement l'interpolation ; les données reprenant après une interruption plus longue peuvent aussi restaurer les grenades encore présentes côté serveur.

Le harness passe 76 contrôles GPU, dont six pour les grenades : vrais OBJ/MTL, 352 pixels verts et 121 gris, instances séparées, explosion/reset, brouillard RGB 221/232/255 et centres X 50,7 → 76,3 → 101,9 sur trois images à 60 Hz sans nouveau snapshot. Captures inspectées, aucun diagnostic WebGL/JavaScript. Les 385 fichiers Java sont intacts. Physique et protocole serveur inchangés ; le cas de 100 instances ne constitue pas un nouveau test réseau de 100 joueurs. Le tampon de 100 ms retarde l'affichage pour interpoler les positions confirmées ; une interruption prolongée suspend ce mouvement. Aucun nouvel essai Internet ou pilotage FPS libre n'est revendiqué.

Après calibration des points de tir sur les extrémités de canon OBJ : `bun run check` passe avec 126 tests et 7716 assertions. Les quatre nouveaux tests d'alignement échouaient avant correction (écarts mesurés AK 1,79996 / AWP 1,53460 blocs) et passent après correction, avec rotations caméra, visée, déplacement et recul. Deux régressions supplémentaires protègent le joueur situé entre l'œil et le canon ; les impacts contre un mur proche restent validés. Le harness GPU passe 70 contrôles, dont six comparaisons de balles contre le centre du canon dérivé des vrais OBJ : aucun pixel de différence pour AK/AWP au repos, en visée ou pendant le recul. Les captures composites ont été inspectées, sans diagnostic JavaScript/WebGL. Les 385 fichiers Java sont intacts. Le contrôle ne mesure pas le ressenti sous latence réseau.

La même version a maintenu 100 clients TDM actifs pendant 30 s sur une carte 64 × 64 × 64 : aucune erreur ni déconnexion, aucun tick abandonné ni commande perdue, p95 1,47 ms / p99 1,81 ms / maximum 11,76 ms, RSS finale 170 Mo. Serveur et bots partagent la machine ; aucun rendu de 100 navigateurs ni trajet Internet n'est mesuré. Rapport : [calibration du canon, 100 clients](benchmarks/2026-09-11-muzzle-tdm-100.json).

- Après correction des couleurs et options graphiques : TypeScript strict, 77 tests automatisés (6632 assertions) et compilation du client via `bun run check` : tout passe.
- Après remplacement des ombres par le CSM Three.js : `bun run check` passe avec 83 tests (7285 assertions). Les six nouveaux tests couvrent les quatre tranches de caméra sous plusieurs FOV/formats, la précision près du joueur, la limite de texture du GPU, la stabilisation en espace lumière et la libération/réactivation des cartes.
- Après doublement de la résolution et éclairage directionnel des faces : `bun run check` passe avec 83 tests (7334 assertions). Chaque cascade gagne un facteur deux de précision linéaire, sans changer sa couverture ; les limites de texture 1024/2048/4096/8192 sont exercées. Le test du mesher vérifie un RGB identique sur les six normales avant éclairage, et la conservation de l'occlusion ambiante.
- Tests de mouvement, collisions, raycast, génération déterministe, éviction de cache, dégâts, maillages et rejet des résultats worker périmés.
- Tests d'autorité, admission de 100 joueurs et refus du 101e, équipes, FFA, kits, cadence, impacts, grenades, soins, construction, mort et réapparition.
- Tests des commandes invalides, séquences, réception du terrain pendant ses mutations, reset et commandes d'anciennes manches.
- Tests de transport HTTP/WebSocket réels, snapshots binaires, plusieurs clients, abonnement aux diffusions après reset et limites d'envoi.
- Vérification dans le navigateur intégré : panorama voxel, pseudo, connexion, lobby, changement de kit avec modèles OBJ/MTL, apparition, HUD et menu. Aucun avertissement ni erreur JavaScript relevé sur ce parcours.
- Démarrage du mode développement et réponse HTTP de son serveur.
- Comparaison SHA256 de 385 fichiers source et ressources du Java : aucun changement.

La reprise de l'interface ajoute les tests des palettes OBJ/MTL, des faces colorées superposées et de la projection/RGB de la minicarte. Le parcours navigateur a été refait avec la police Riffic originale, les boutons Java, le fond du lobby, ses trois aperçus tournants, l'apparition directe Assault/Medic, le HUD et les panneaux Options/Graphics. Les couleurs rétablies ont été observées sur les aperçus et sur la trousse en jeu. La case SSAA a bien doublé la largeur du buffer de rendu (1284 → 2568 pixels pour une fenêtre de 856 pixels CSS), puis a été rétablie. Aucun avertissement ni erreur JavaScript relevé après correction. Voir [les références et adaptations de l'interface](ui-reference.md).

Neuf contrôles GPU supplémentaires ont passé via `bun scripts/visual-check.ts` : RGB terrain (31,153,31 pour (.1,.5,.1) ×1,2), indépendance des lampes, brouillard (221,232,255), particules (83,166,249 pour (.25,.5,.75) ×1,3), brouillard particules, 432 pixels d'ombre atténués de moitié, rétablissement exact à la désactivation, shader neige et activation/désactivation de son pool. Ces contrôles lisent les pixels WebGL et sont distincts des tests Bun.

Dans le jeu, les motifs parasites d'auto-ombrage observés sur les faces verticales ont disparu après adaptation du biais à la résolution de la shadowmap. Neige visible, disparition à la désactivation, SSAA (largeur 1372 → 2745 pour 915 pixels CSS, arrondi du DPR 1,5) et persistance des trois cases après rechargement ont été vérifiés. Aucun avertissement ni erreur JavaScript relevé après correction. La case vSync explique la limitation du navigateur.

Le contrôle GPU a ensuite été étendu à 20 vérifications, toutes réussies avec les ombres CSM. Une dalle et un cube utilisent le shader terrain et les mêmes quatre projections que le jeu. Lecture des pixels sans antialiasing : uniquement 122 (éclairé) ou 61 (ombre), aucune valeur de flou ou de double assombrissement. Les quatre cascades produisent respectivement 457, 816, 867 et 860 pixels ombragés dans les vues témoins ; la dalle seule reste éclairée sans acné. Les témoins passent de part et d'autre des coupures 10/30/72, à la fin de portée 144, après déplacement du cube et de la caméra, après changement de FOV/format et après désactivation/réactivation (image strictement identique). Les contrôles de couleur, brouillard et neige restent valides.

Dans le navigateur du jeu : accueil, lobby, apparition et activation/désactivation des ombres vérifiés. Aucun nouveau diagnostic JavaScript/WebGL après correction du shader. La première cascade couvre un texel de 0,01556 bloc à FOV 76° et format 16:9, contre 0,09375 auparavant, soit environ six fois plus de précision linéaire. La stabilisation sous déplacements inférieurs au texel est vérifiée sur les matrices ; le pilotage FPS libre reste limité par le refus de capture du pointeur du navigateur intégré. Les quatre passes de profondeur augmentent le coût GPU ; aucune mesure de charge graphique avec 100 avatars n'a été réalisée. La comparaison des 385 fichiers Java a été répétée : aucun changement.

La version suivante passe à quatre cartes 4096 × 4096 : le texel de proximité mesure désormais 0,00778 bloc au même FOV/format. Les contrôles GPU ont été adaptés au nouvel éclairage et passent tous, soit 30 vérifications. Pour un RGB brut gris de 0,4 : face normale au soleil 122, dessus du bloc 106, face latérale exposée 91, face opposée ou rasante 61. Ces valeurs sont vérifiées sans aucun objet projetant une ombre, avec caméra oblique et inversion de la direction solaire. Une face dos au soleil reste à 61 avec les ombres portées activées comme désactivées : l'ambiant n'est jamais assombri deux fois. Les quatre cascades, raccords, déplacement du bloc, changement de projection et réactivation restent valides ; la dalle seule ne présente pas d'acné. Palette, brouillard, particules et neige passent également. Le jeu a été rechargé, rejoint et contrôlé avec les ombres OFF/ON, sans diagnostic JavaScript/WebGL. Les 385 fichiers Java sont toujours intacts. Les cartes demandent quatre fois plus de texels que les cascades 2048 ; ce contrôle ne constitue pas une mesure de performance graphique en partie chargée.

Un nouveau test TDM sur un serveur de test séparé, avec la palette et les impacts corrigés, a maintenu 100 clients actifs pendant 30 s : zéro erreur, zéro tick abandonné, zéro commande perdue, tick p95 1,83 ms / p99 2,90 ms / maximum 12,02 ms, RSS finale 180 Mo. Le navigateur du jeu était utilisé en parallèle sur cette machine. Rapport : [couleurs et événements, 100 clients](benchmarks/2026-09-11-colors-tdm-100.json). Les comparaisons TDM/FFA ci-dessous restent celles de la première livraison.

La capture du pointeur a été refusée par le navigateur intégré, y compris après un clic sur Reprendre. Le pilotage libre et les sensations FPS doivent donc encore être essayés dans Chrome, Firefox ou Edge. L'interface explique désormais ce refus. Les combats et déplacements ont été exercés par les clients de charge et les tests serveur, ce qui ne remplace pas cette validation humaine.

## Machine et protocole de mesure

Windows, version système 10.0.22631 ; AMD Ryzen 7 5800X, 8 cœurs / 16 processeurs logiques ; environ 32 Gio de RAM ; Bun 1.3.11.

Le serveur et les 100 clients de charge partagent cette machine. Les échanges passent réellement par HTTP/WebSocket sur localhost. Les clients se déplacent, tirent, creusent/construisent, lancent des grenades et réapparaissent après leur mort. Un navigateur réel affichait parallèlement une autre instance locale.

Les percentiles concernent les 1024 derniers ticks à la fin du test, soit environ 17 secondes à 60 Hz. Le maximum et les retards sont cumulés depuis le démarrage du processus. Les durées ci-dessous correspondent à la phase active demandée ; les rapports incluent aussi environ 1,6 seconde de connexion/initialisation des clients. Ce protocole est un premier contrôle de capacité, pas un essai de stabilité de 30 minutes.

## Résultats après optimisation

| Mesure | TDM, 256 × 64 × 256 | FFA concentré, 64 × 48 × 64 |
|---|---:|---:|
| Clients connectés en fin d'essai | 100 / 100 | 100 / 100 |
| Durée active demandée | 30 s | 60 s |
| Temps de tick p50 | 0,81 ms | 0,53 ms |
| Temps de tick p95 | 2,26 ms | 1,79 ms |
| Temps de tick p99 | 3,21 ms | 2,31 ms |
| Temps de tick maximal | 10,03 ms | 9,01 ms |
| Ticks abandonnés pour retard | 0 | 0 |
| Commandes perdues par saturation | 0 | 0 |
| Erreurs des clients | 0 | 0 |
| RSS serveur à la fin | 187 Mo | 166 Mo |
| Données reçues cumulées par les clients | 1,040 Go | 1,544 Go |
| Politique de reset | Désactivé | Toutes les 20 s, manche 4 atteinte |

Le test TDM inclut le profilage CPU ; le test FFA est exécuté sans profileur. Les valeurs mémoire et trafic utilisent les unités décimales. Les instantanés de files d'inputs sont respectivement 0 et 270 commandes ; dans le second cas, cela représente environ un lot de trois commandes par joueur vivant, sans perte ni retard observés.

Rapports complets : [TDM](benchmarks/2026-09-11-tdm-100.json), [FFA](benchmarks/2026-09-11-ffa-100.json).

Le budget de 16,67 ms par tick est respecté dans ces deux essais. Le débit reste élevé : environ 263 Mbit/s agrégés pour le TDM et 201 Mbit/s pour le FFA, calculés sur les durées totales des rapports, hors en-têtes transport. La diffusion de toutes les entités à tous les joueurs et les événements JSON sont des axes de réduction avant une mise en ligne large.

## Corrections guidées par les mesures

Le premier protocole JSON avait transféré environ 4,5 Go en 30 secondes avec 100 clients. Les snapshots fréquents ont été convertis en binaire et les snapshots de réapparition envoyés uniquement au joueur concerné.

Le profilage suivant a attribué environ 44,8 % du temps CPU échantillonné aux appels natifs d'envoi. Le serveur répétait les mêmes événements par connexion. La diffusion native Bun remplace ces appels répétés ; l'abonnement est activé après synchronisation du terrain et retiré au reset ou au départ. Le même scénario profilé est passé d'un tick p99 de 32,12 ms à 3,21 ms, avec suppression des retards observés.

Les fonctions voxel représentaient une faible part de ce profil ; leur code n'a pas été modifié pour cette optimisation réseau.

## Limites restantes

- Pas de validation avec 100 navigateurs, de mesure GPU fiable, de test prolongé sur machines distinctes ou de réseau dégradé.
- Pas encore de compensation historique des tirs. La correction visuelle du déplacement et l'interpolation sont implémentées, mais la qualité ressentie sous latence reste à évaluer.
- Cartes configurables jusqu'à 2048 blocs de côté ; ces dimensions maximales n'ont pas été soumises à cette charge ni validées graphiquement. La distance d'affichage actuelle est limitée à 256 blocs, sans niveau de détail lointain.
- Révision globale du terrain, différences conservées en mémoire pendant la manche et synchronisation complète des différences avant l'apparition. Le coût d'un terrain longtemps modifié reste à mesurer.
- Aucun serveur multijoueur permanent déployé, aucune simulation distribuée ni effondrement structurel.

Les trois arbitrages produit déjà ouverts restent la fin de manche, le matériel cible et le sens du scaling futur. Ils n'empêchent pas l'utilisation de cette version locale.
