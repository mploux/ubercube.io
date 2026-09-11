# Validation du 11 septembre 2026

Cette livraison est une première version locale fonctionnelle. La parité des sensations avec le Java, la tenue prolongée sur Internet et les grandes distances d'affichage ne sont pas encore validées.

## Vérifications exécutées

- TypeScript strict, 44 tests automatisés (224 assertions) et compilation du client via `bun run check` : tout passe.
- Tests de mouvement, collisions, raycast, génération déterministe, éviction de cache, dégâts, maillages et rejet des résultats worker périmés.
- Tests d'autorité, admission de 100 joueurs et refus du 101e, équipes, FFA, kits, cadence, impacts, grenades, soins, construction, mort et réapparition.
- Tests des commandes invalides, séquences, réception du terrain pendant ses mutations, reset et commandes d'anciennes manches.
- Tests de transport HTTP/WebSocket réels, snapshots binaires, plusieurs clients, abonnement aux diffusions après reset et limites d'envoi.
- Vérification dans le navigateur intégré : panorama voxel, pseudo, connexion, lobby, changement de kit avec modèles OBJ/MTL, apparition, HUD et menu. Aucun avertissement ni erreur JavaScript relevé sur ce parcours.
- Démarrage du mode développement et réponse HTTP de son serveur.
- Comparaison SHA256 de 385 fichiers source et ressources du Java : aucun changement.

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
- Aucun déploiement externe, aucune simulation distribuée ni effondrement structurel.

Les trois arbitrages produit déjà ouverts restent la fin de manche, le matériel cible et le sens du scaling futur. Ils n'empêchent pas l'utilisation de cette version locale.
