# Revue vidéo du combat

Marc garde le dernier mot sur le résultat visuel. Le rapport technique accompagne la vidéo ; un test réussi ne vaut pas approbation du rendu ou du ressenti.

Lancer `bun scripts/qa-video.ts`, ouvrir `http://127.0.0.1:3014/` puis cliquer sur « Enregistrer la revue vidéo ». Le serveur écoute uniquement en local. Le bouton prépare cinq scènes : AK au torse, AK à la tête en caméra rapprochée, AWP au torse, cible derrière un mur et cible en mouvement. Les prises sont à vitesse réelle, séparées par des coupes de préparation. Arrêter le serveur après la sauvegarde.

Le build compare les sources avec `ops/deployed-client.json`, puis ajoute uniquement des adaptateurs de commandes automatisées, de caméra et de capture. Le vrai `main.ts`, ses effets, ses ragdolls et le vrai serveur traitent les intentions et événements via WebSocket. Les positions, l'arène et la santé initiale sont préparées par le banc ; aucun événement de tir, d'impact ou de mort n'est fabriqué. Les règles et fichiers de production ne sont pas modifiés.

La capture contient le canvas du jeu, la visée AWP et la vignette, ainsi qu'une surcouche de revue indiquant les tirs, touches, morts et PV observés. Elle ne reproduit pas tout le HUD DOM. Le son provient de la chaîne audio du client, avec son gain inchangé. La caméra rapprochée sert à inspecter le même ragdoll ; elle ne modifie pas la physique. Les scripts ne valident pas la souris, le téléphone physique ou une latence Internet réelle.

Les sorties sont `.runtime/qa-video/review.webm` et `report.json`. Le rapport contient les événements reçus par le client, ceux diffusés par le serveur, les états finaux et les intentions enregistrées. Pour une lecture mobile, convertir avec FFmpeg :

```sh
ffmpeg -i .runtime/qa-video/review.webm -vf fps=30 -c:v libx264 -profile:v high -level:v 3.1 -preset fast -crf 19 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart .runtime/qa-video/ubercube-review.mp4
```

Contrôler la durée, décoder le fichier et inspecter les images des cinq scènes avant livraison. Conserver le rapport correspondant à la prise livrée. Une reprise remplace `review.webm` et `report.json` : archiver la précédente si elle contient une anomalie utile. Les vidéos et outils d'encodage restent hors Git.

Validation du banc : `bun test tests/qa-video-server.test.ts`, puis `bun run check`. Le test utilise deux vrais WebSockets et protège l'origine locale, les tirs létaux, l'absence de balles persistantes et les collisions du mur. L'état de revue dans le rapport reste « Pending Marc visual review » jusqu'au retour de Marc.

## Comparer la force des ragdolls

Ouvrir `http://127.0.0.1:3014/?review=impulse` puis « Comparer les forces du ragdoll ». Douze prises comparent ×1, ×2, ×4 et ×8 pour AK au torse, AK à la tête et AWP au torse. Les magnitudes sont respectivement 12/24/48/96 pour l'AK et 20/40/80/160 pour l'AWP. Chaque prise garde le même cadrage, la même cible immobile et la même visée ADS, à vitesse réelle.

La cible du banc commence à 1 PV pour qu'un seul tir produise la mort. Le serveur local multiplie uniquement le vecteur d'impulsion de l'événement mortel réel avant de le transmettre. Le point, la direction, les masses, la gravité et les articulations restent inchangés. Le navigateur vérifie que l'amplitude reçue correspond à celle affichée. Les événements et le point touché sont conservés pour contrôler l'équivalence des prises. Ces variantes ne changent aucun fichier applicatif ni la production ; Marc choisit les valeurs avant leur intégration.

Les fichiers séparés `impulse-review.webm` et `impulse-report.json` préservent la première revue. Convertir avec la même commande FFmpeg en adaptant les noms, puis vérifier le cadrage des impulsions maximales et l'absence de corps ou membres sortant de l'image pendant l'impact.
