# Décalage de visée — mesures du 22 septembre 2026

Ce diagnostic décrit l'état **avant correction** du 22 septembre 2026 : viser le centre d'un adversaire qui se déplace peut manquer sa hitbox, alors qu'anticiper son déplacement touche. La [compensation ajoutée ensuite](lag-compensation.md) possède ses propres résultats. Les chiffres ci-dessous restent ceux du diagnostic initial.

## Résultat à exactement 50 ms de ping

Ici, « ping » désigne l'aller-retour : 25 ms dans chaque sens. Le banc à horloge virtuelle exécute les vrais `GameServer`, mouvements, poses d'armes, raycasts, codec et `RemotePlayers`. Il mesure les événements d'impact et les points de vie, pas seulement l'émission d'une commande.

| Cible | Décalage cible affichée → cible au traitement | Visée centrée | Visée anticipée |
|---|---:|---:|---:|
| Immobile | 0 bloc | 24/24 | 24/24 |
| Marche, 6 blocs/s | 0,623–0,699 bloc | 0/24 | 24/24 |
| Course, 9 blocs/s | 0,934–1,049 bloc | 0/24 | 24/24 |

Ces résultats sont identiques à l'AK-47 et à l'AWP : chaque cellule du tableau correspond à 24 essais **par arme**. Les dégâts confirmés sont respectivement de 20 et 70 PV. La largeur de la hitbox est de 0,6 bloc. Ces taux décrivent cette géométrie contrôlée ; ils ne constituent pas une estimation du taux de réussite des joueurs en partie.

La cible affichée correspond à une position vieille de **75 ms**. Le tir est ensuite traité **28,83 à 41,50 ms** après l'intention. La différence totale atteint donc **103,83 à 116,50 ms**, médiane **110,17 ms**.

| Ping simulé | Âge de la cible à l'affichage | Décalage effectif au traitement, médiane |
|---|---:|---:|
| 0 ms | 50 ms | 60,17 ms |
| 50 ms | 75 ms | 110,17 ms |
| 100 ms | 100 ms | 160,17 ms |

## Cause confirmée

Le client reçoit les snapshots à 20 Hz et conserve un intervalle d'interpolation de 50 ms sur un réseau stable. Le délai descendant s'ajoute à cette interpolation. Les commandes de tir passent ensuite par le trajet montant et attendent un tick serveur. Le serveur calcule les impacts sur les positions courantes après les mouvements de ce tick ; il ne conserve pas d'historique pour retrouver la position vue par le tireur.

Avec 50 ms RTT : **25 ms descendant + 50 ms interpolation + 25 ms montant + attente du tick**. Il ne faut pas ajouter encore 25 ms « d'attente moyenne du snapshot » : l'interpolation progresse entre les snapshots. Le vrai navigateur peut ajouter une phase d'image/entrée, non simulée dans le premier banc.

Points d'entrée : [`RemotePlayers`](../src/client/remote-players.ts), [`playerHit`, `resolveShots` et `step`](../src/shared/game.ts), [`InputFrame`](../src/shared/protocol.ts), et l'ordre simulation/envoi/rendu de [`main.ts`](../src/client/main.ts). `InputFrame` ne transmet pas de temps historique de visée. Le hitscan supprime le temps de vol ; il ne compense pas ces délais réseau et d'affichage.

## Protocole des essais déterministes

**1 152 tirs**, 48 configurations et 24 essais par configuration : RTT 0/50/100 ms, vitesses 0/3/6/9 blocs/s, AK/AWP, centre/anticipation, trois phases de snapshot, quatre phases de tick et deux graines. Un premier tir après trois secondes de visée stabilisée évite de confondre latence et recul. Terrain plat, mouvement latéral, tireur immobile ; seul le placement initial relève de la fixture. Les mouvements, impacts et dégâts suivants passent par le jeu réel.

L'anticipation de contrôle connaît le RTT et la phase du tick. Elle démontre la cause ; ce n'est pas une compensation implémentée dans le jeu. Le rayon réel est vérifié au plan de la cible, avec une erreur horizontale inférieure à 0,001 bloc par rapport à la visée. Numéro de commande, tir unique, impact et PV sont vérifiés ensemble. Aucun invariant n'échoue. Deux exécutions ont donné les mêmes lignes de résultats.

La marche lente à 3 blocs/s touche encore dans cette géométrie à 50 ms : l'angle du rayon et le volume de la hitbox comptent, pas seulement le décalage de son centre.

## Confirmation avec de vraies connexions WebSocket

Dix scénarios de 12 secondes après stabilisation, deux clients et le serveur local réel : **260 tirs confirmés**. Les commandes arrivent à 59,98–60,10 Hz en moyenne. Le client appelle le vrai interpolateur ; ce banc ne lance pas de navigateur/GPU.

Les temporisateurs Windows donnent environ **62,5–62,9 ms de RTT médian pour 50 ms demandées**, et 125,1 ms pour 100 ms demandées. Ces mesures sont donc séparées du banc exact à 50 ms. Les retards sont ajoutés dans les deux sens, y compris sur les commandes de déplacement de la cible.

| Cas, délai demandé 50 ms | Centre affiché | Anticipation de 150 ms |
|---|---:|---:|
| AK, cible immobile | 30/30 | — |
| AK, marche | 0/27 | 27/27 |
| AK, course | 0/25 | 25/25 |
| AWP, course | 0/10 | 10/10 |

Les dénominateurs mobiles correspondent au sous-ensemble à vitesse stabilisée ; les demi-tours restent dans les données brutes. L'âge effectif médian est de 133,3 ms en marche et 136,7 ms en course à l'AK, 138,5 ms à l'AWP. La valeur d'anticipation de 150 ms est un contrôle explicite issu du pilote Windows, et non un nouveau réglage du jeu. Le rayon réel passe au centre visé à moins de 0,001 bloc près.

Les compteurs de commandes acquittées, événements et PV concordent pour les 260 tirs. Aucun input rejeté ni tick abandonné ; p99 du travail de tick entre 0,20 et 1,08 ms pour les scénarios à délai demandé de 50 ms. Le symptôme existe donc sans saturation du serveur de ce banc à deux joueurs. Toutes les connexions et instances locales sont fermées après les scénarios.

Les PV sont restaurés après chaque impact non mortel pour conserver la même cible. Les tirs sont en visée, au torse, avec maintien de 75 ms toutes les 400 ms à l'AK et 1 200 ms à l'AWP. Le code d'arme existant réarme avant le tir suivant sur un tick distinct : le délai entre commande reçue et tir peut inclure ce tick. `pressToConfirmationMs` mesure séparément l'appui initial ; il ne faut pas interpréter `serverWaitMs` comme du seul délai réseau. Un premier pilote à environ 32 Hz est conservé séparément et exclu du tableau final.

## Portée par rapport à la publication

Le dépôt local est au protocole 7 ; la dernière publication enregistrée est au protocole 6. L'interpolation distante, les mouvements et les poses d'armes correspondent exactement aux empreintes client enregistrées. Une copie serveur locale correspond aux empreintes serveur enregistrées ; ses sections d'acceptation des inputs, de combat, de mouvement et de résolution des tirs sont identiques aux sections testées. Les différences locales comprennent la gestion des cartes.

Cela rattache le mécanisme reproduit au code de la publication enregistrée, sans prétendre avoir mesuré la machine ou la connexion Internet de la partie signalée. Aucune vérification distante ni charge en production n'a été effectuée.

## Reproduire

```sh
bun scripts/benchmark-combat-latency-deterministic.ts --uncompensated
bun scripts/benchmark-combat-latency.ts --uncompensated
# Un seul cas WebSocket, avec une anticipation explicitement choisie :
bun scripts/benchmark-combat-latency.ts --uncompensated --case=6 --seconds=12 --lead-ms=150
```

Les preuves initiales restent dans `.runtime/combat-latency-20260922/` : `deterministic.json`, `websocket.json` et `source-equivalence.json`. Les scripts actuels écrivent dans `.runtime/lag-compensation-20260922/` ; `--uncompensated` omet les métadonnées de visée et reproduit la résolution initiale. Le [résumé des mesures initiales](benchmarks/2026-09-22-combat-latency.json) conserve les paramètres, statistiques et empreintes sans les 1 152 lignes détaillées.

La correction à étudier est une compensation de latence du combat côté serveur, à partir d'un historique borné et d'un temps de visée validé. Réduire uniquement l'interpolation peut dégrader la fluidité et laisse subsister le trajet réseau. Aucune correction de gameplay n'est incluse dans ce diagnostic.

## Validation de l'outillage

`bun run doctor`, TypeScript et build client réussissent. La sélection de 47 fichiers de tests, excluant `release-prepare.test.ts` et `release-vercel.test.ts` qui exécutent Git, donne 522 succès et un `EPERM` de sous-processus dans `client-build.test.ts`. Ce seul test, relancé sans modification avec les permissions d'exécution adaptées, réussit : les **523 tests sélectionnés** sont validés. Journaux dans le dossier de preuves. Le `bun run check` intégral n'est pas lancé pour respecter l'interdiction de Git.

Fichiers ajoutés : les deux scripts de benchmark, ce rapport et son résumé JSON. `docs/validation.md` référence les résultats. Les empreintes des sept fichiers de simulation, protocole, transport et interpolation surveillés sont inchangées à la fin des benchmarks. Aucun déploiement ni modification des sources de gameplay.
