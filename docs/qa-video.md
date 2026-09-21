# Revue vidéo du combat

Marc garde le dernier mot sur le résultat visuel. Le rapport technique accompagne la vidéo ; un test réussi ne vaut pas approbation du rendu ou du ressenti.

Lancer `bun scripts/qa-video.ts`, ouvrir `http://127.0.0.1:3014/` puis cliquer sur « Enregistrer la revue vidéo ». Le serveur écoute uniquement en local. Le bouton prépare cinq scènes : AK au torse, AK à la tête en caméra rapprochée, AWP au torse, cible derrière un mur et cible en mouvement. Les prises sont à vitesse réelle, séparées par des coupes de préparation. Arrêter le serveur après la sauvegarde.

Le build compare les sources avec `ops/deployed-client.json`, puis ajoute uniquement des adaptateurs de commandes automatisées, de caméra et de capture. Le vrai `main.ts`, ses effets, ses ragdolls et le vrai serveur traitent les intentions et événements via WebSocket. Les positions, l'arène et la santé initiale sont préparées par le banc ; aucun événement de tir, d'impact ou de mort n'est fabriqué. Les règles et fichiers de production ne sont pas modifiés.

Pour filmer une fonctionnalité encore locale, lancer explicitement `bun scripts/qa-video.ts --local-sources`. Ce mode filme les sources de travail sans les présenter comme publiées. Le rapport embarque `qa-source.json`, avec le mode, la date de préparation et les empreintes SHA256 des sources du jeu et des assets RPG.

La capture contient le canvas du jeu, la visée AWP et la vignette, ainsi qu'une surcouche de revue indiquant les tirs, touches, morts et PV observés. Elle ne reproduit pas tout le HUD DOM. Le son provient de la chaîne audio du client, avec son gain inchangé. La caméra rapprochée sert à inspecter le même ragdoll ; elle ne modifie pas la physique. Les scripts ne valident pas la souris, le téléphone physique ou une latence Internet réelle.

Les sorties sont `.runtime/qa-video/review.webm` et `report.json`. Le rapport contient les événements reçus par le client, ceux diffusés par le serveur, les états finaux et les intentions enregistrées. Pour une lecture mobile, convertir avec FFmpeg :

```sh
ffmpeg -i .runtime/qa-video/review.webm -vf fps=30 -c:v libx264 -profile:v high -level:v 3.1 -preset fast -crf 19 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart .runtime/qa-video/ubercube-review.mp4
```

Contrôler la durée, décoder le fichier et inspecter les images des cinq scènes avant livraison. Conserver le rapport correspondant à la prise livrée. Une reprise remplace `review.webm` et `report.json` : archiver la précédente si elle contient une anomalie utile. Les vidéos et outils d'encodage restent hors Git.

Validation du banc : `bun test tests/qa-video-server.test.ts`, puis `bun run check`. Le test utilise deux vrais WebSockets et protège l'origine locale, les tirs létaux, l'absence de balles persistantes et les collisions du mur. L'état de revue dans le rapport reste « Pending Marc visual review » jusqu'au retour de Marc.

## Comparer la force des ragdolls

Le 15 septembre 2026, Marc a validé ×4 pour l'AK et l'AWP après revue de la vidéo, soit des magnitudes de 48 et 80. La direction du tir et le point d'impact restent conservés.

Ouvrir `http://127.0.0.1:3014/?review=impulse` puis « Comparer les forces du ragdoll ». Douze prises comparent ×1, ×2, ×4 et ×8 pour AK au torse, AK à la tête et AWP au torse. Les magnitudes historiques restent respectivement 12/24/48/96 pour l'AK et 20/40/80/160 pour l'AWP, même après intégration du choix ×4 au jeu. ×1 est étiqueté « RÉFÉRENCE INITIALE » et ×4 « CHOIX VALIDÉ ». Chaque prise garde le même cadrage, la même cible immobile et la même visée ADS, à vitesse réelle.

La cible du banc comparatif commence à 1 PV pour qu'un seul tir produise la mort. Le serveur local normalise uniquement le vecteur d'impulsion de l'événement mortel réel vers la magnitude historique de l'arme multipliée par le facteur choisi avant de le transmettre. Le point, la direction, les masses, la gravité et les articulations restent inchangés. Le navigateur vérifie que l'amplitude reçue correspond à celle affichée. Les événements et le point touché sont conservés pour contrôler l'équivalence des prises. Ces variantes restent hors production. Le mode de revue normal transmet les événements de production sans altérer leur impulsion ; le test WebSocket vérifie les magnitudes 48 pour l'AK et 80 pour l'AWP.

Les fichiers séparés `impulse-review.webm` et `impulse-report.json` préservent la première revue. Convertir avec la même commande FFmpeg en adaptant les noms, puis vérifier le cadrage des impulsions maximales et l'absence de corps ou membres sortant de l'image pendant l'impact.

## Bazooka en première et troisième personne

Lancer `bun scripts/qa-video.ts --local-sources`, ouvrir `http://127.0.0.1:3014/?review=rpg`, puis « Filmer le bazooka ». La capture 1280 × 720 à 30 images/s contient deux prises à vitesse réelle : tir à la hanche puis en visée en première personne, puis personnage et bazooka vus de l'extérieur. Chaque prise comporte deux tirs sur des points distincts du mur, avec vol, fumée, explosions et destruction autoritaires. Le terrain est restauré entre les prises. La caméra extérieure affiche le personnage local avec le renderer des joueurs distants ; elle reste un outil de revue, sans ajouter de commande de caméra au jeu.

Les sorties séparées sont `rpg-review.webm` et `rpg-report.json`. Le rapport associe les tirs et explosions reçus aux événements serveur et au nombre d'éditions du terrain. La capture est refusée si chaque prise n'a pas exactement deux tirs et deux explosions. Les sons et le gain audio du jeu restent inchangés. Le test WebSocket du banc vérifie aussi les projectiles réellement en vol, les mutations du mur et la restauration entre prises.

La vidéo `.runtime/qa-video/bazooka-review-v2.mp4` du 21 septembre 2026 a permis à Marc de valider le modèle polygonal. Sa capture et son rapport sont désormais conservés sous `rpg-review-v2.webm` et `rpg-report-v2.json`. La nouvelle prise `.runtime/qa-video/bazooka-review-v3.mp4` montre la même ogive verte portée puis en vol, le lanceur vide pendant sa cadence, la visée dans la lentille et les poses corrigées. Le rapport courant `rpg-report.json` correspond à cette nouvelle prise. La scène est préparée et les commandes automatisées ; il ne s'agit pas d'une partie humaine ni de la version publiée.

La première vidéo `.runtime/qa-video/bazooka-premiere-troisieme-personne.mp4`, son rapport `rpg-report-before-review.json` et sa capture `rpg-before-review.webm` restent conservés pour comparaison. Pour encoder la nouvelle capture en gardant les horodatages audio des coupes de préparation, ajouter `-af 'aresample=async=1:first_pts=0,apad' -shortest` à la commande FFmpeg ci-dessus.

## Captures des quatre poses RPG

Lancer `bun scripts/rpg-review.ts`, ouvrir `http://127.0.0.1:3015/` puis « Enregistrer les quatre vues et la roquette ». Le banc utilise les classes et shaders du jeu dans une scène fixe, sans serveur. Il enregistre les PNG individuels et une planche `.runtime/rpg-review/quatre-vues-quarter.png` : FPS repos et visée, personnage au repos et en visée. Les boutons d'angle permettent aussi de contrôler les profils et la face. Une comparaison AWP conserve son rendu inchangé, et le pixel central de la cible avant/après arme permet de vérifier la transparence de la lentille avant l'ajout du réticule.

Les vues de départ en profil à 20 et 45 ms montrent le sous-mesh de roquette détaché et le tube vide ; ce sont des événements préparés dans le banc de rendu. La vidéo WebSocket ci-dessus vérifie séparément le chemin réel client/serveur. Arrêter les deux serveurs locaux après la revue.
