# Contrôles FPS à deux pouces

Implémentation autorisée par Marc le 12 septembre 2026 après l'exploration ci-dessous. Le tir automatique reste reporté à un essai ultérieur, après son retour sur cette version manuelle.

Ajouts publiés le 21 septembre 2026 : bouton Sneak au-dessus du joystick, activé/désactivé par appui pour garder deux pouces sur déplacement et regard ; il prend priorité sur le sprint. Pause, annulation ou changement d'arme le désactivent. Avec le sac médic, le bouton secondaire devient « Se soigner », +10 PV par appui confirmé par le serveur, sans bascule de visée. Les contrôles sont masqués pendant death cam et kill cam.

## Interface du pouce droit : arc compact

Direction 1 choisie par Marc le 13 septembre 2026 : bouton de tir de 80 × 80 pixels CSS, avec Visée et Saut de 52 × 52 pixels disposés au-dessus en arc. Pictogrammes, libellés courts, fond noir translucide et contours carrés conservent la police Riffic. Les consignes permanentes ont été retirées ; les libellés Lancer, Creuser, Bâtir et Soigner restent adaptés à l'équipement.

Les espaces entre les boutons laissent passer les gestes vers la zone de caméra. Les pictogrammes appartiennent aux boutons existants ; les règles de capture, de double appui, de visée et de grenade restent celles de la version ci-dessous.

Une vérification avec des contacts tactiles transmis au navigateur a révélé que Chromium favorisait le bouton de tir depuis ces espaces. Élargir les écarts à 19 et 16 pixels n'a pas suffi. L'état CSS `#touch-look:active` rend la surface de regard éligible au ciblage interactif : le test A/B confirme alors des contacts et une capture sur `touch-look`, sans tir, visée ou saut parasites. Le [code de ciblage de Chromium](https://chromium.googlesource.com/chromium/src/%2B/af3159f6b882f925733a6dae791cd2f075937e80/third_party/blink/renderer/core/page/touch_adjustment.cc) explique ce critère. Preuve : `.runtime/right-thumb-arc-smoke/active-probe-results.json`.

TypeScript, les 43 tests tactiles (192 assertions) et le build passent. Dans Edge headless, 136 vérifications passent sur 390 × 844, 844 × 390, 320 × 568 et 568 × 320, sans avertissement ni erreur JavaScript : géométrie, pictogrammes, contacts natifs transmis par CDP, capture hors du bouton, gestes à deux pouces, espaces de regard et libellés d'équipement. Les captures ont été relues ; aucun essai sur téléphone physique n'a été effectué pour cette interface. Preuves : `.runtime/right-thumb-arc-smoke/arc-results.json` et les captures du même dossier. Le navigateur et le serveur de validation ont été arrêtés.

L'arc est publié sur `https://www.ubercube.io/` le 13 septembre 2026 : Vercel `dpl_8k4QegiHN6uu4qK2CpEarzoqKwCE`, READY. HTML, CSS et JavaScript publics correspondent exactement aux fichiers validés ; le serveur de jeu répond en HTTP 200 sur `/health`. Seuls les trois fichiers d'interface ont été transférés, sans Git ni modification Hetzner. Preuves : `.runtime/vercel-arc-release/verification.json`. Le déploiement décrit plus bas est celui de la première version à deux pouces.

## Commandes de cette version

- Pouce gauche : joystick de déplacement, sprint à grande amplitude.
- Pouce droit : glisser dans la zone libre pour regarder ; maintenir et glisser sur le grand bouton de tir pour orienter tout en tirant.
- Autre accès au tir : double appui dans la zone libre à droite, en maintenant le second appui ; le tir commence dès ce second appui, la caméra continue à suivre le glissement, et le relâchement termine le tir.
- Viser : un appui active la visée de l'AK-47 ou de l'AWP, un second la désactive. L'état reste visible après le relâchement. La pelle conserve son action « Bâtir » au maintien.
- Grenade : maintien pour préparer, glissement pour orienter, relâchement pour lancer ; les deux accès au tir fonctionnent. Une annulation ou un changement d'arme abandonne la préparation sans lancer.
- Un changement d'arme remet les actions et la visée à zéro tout en conservant le contact de déplacement. Pause, perte de focus, désactivation et annulation tactile libèrent les commandes.

Le premier appui du double geste doit durer au plus 200 ms et rester dans un rayon de 12 pixels CSS. Le second commence dans les 280 ms suivant le relâchement et à moins de 40 pixels CSS de celui-ci. Dépasser le seuil de déplacement pendant le premier geste le disqualifie, même si le pouce revient à son point de départ. Ces valeurs sont initiales : le ressenti et les faux déclenchements restent à évaluer sur téléphone.

Le saut et le changement d'équipement gardent leurs boutons ponctuels. Ils peuvent interrompre brièvement l'action du pouce droit. Le tir et la destruction restent décidés par la simulation existante ; aucune cadence, règle d'arme ou logique serveur n'est modifiée.

## Validation de l'implémentation

TypeScript, les 265 tests existants et nouveaux (10 663 assertions) et le build client passent. Les contrôles tactiles couvrent 43 tests et 192 assertions, notamment les limites temporelles/spatiales, la propriété des contacts, le tir à deux pouces, la visée basculée, la pelle maintenue et les annulations. Le test de build qui lance des sous-processus Bun a été relancé séparément avec les permissions nécessaires après un refus `EPERM` du bac à sable ; il passe ses 16 assertions.

Dans Edge headless avec le client et la simulation solo réels, 27 contrôles passent avec au maximum deux contacts simultanés : déplacement et tir orienté, arrêt au relâchement, visée persistante, changement d'arme sans perdre le joystick, grenade unique au relâchement, annulation sans lancer, pelle, pause/reprise et perte de focus. Les événements observés comprennent 10 tirs d'AK et une grenade ; aucun diagnostic JavaScript n'a été relevé. Les gestes sont des Pointer Events synthétiques avec une capture émulée : cette vérification ne remplace pas le toucher natif d'un téléphone.

Les formats 390 × 844, 844 × 390, 320 × 568 et 568 × 320 ont été inspectés visuellement. Une dernière recapture à 568 × 320 confirme que l'aide raccourcie reste sous la minimap. Les boutons conservent la police et le style historiques.

Le premier environnement de test, dans un onglet intégré masqué, produisait six intentions toutes les secondes : cette limitation faussait les attentes du test et activait le délai de sécurité des grenades. Les traces ont confirmé le déplacement du joystick. La validation a donc été reprise dans le navigateur isolé, sans changer la simulation ou ses délais pour faire passer le test. Preuves locales : `.runtime/two-thumb-smoke/browser-results.json`, `headless-results.json`, `layouts.json` et `layout-final.json`.

Publié sur `https://www.ubercube.io/` : Vercel `dpl_2Aq9bVu484565wgzu66H1J2YANAy`, READY. HTML, CSS et JavaScript publics vérifiés en HTTP 200 ; les gestes compilés, les indications et l'adresse `https://game.ubercube.io` correspondent à la version validée. Quatre fichiers client/public ont changé par rapport à la version favicon. Aucun Git, serveur Hetzner ou code Java modifié. Preuves : `.runtime/vercel-two-thumb-release/verification.json`. Le serveur local et le navigateur isolé de validation ont été arrêtés.

## Exploration de référence

Les guides des éditeurs ci-dessous décrivent des méthodes documentées à leur date de publication, sans présumer de la disponibilité actuelle de ces jeux.

Contrainte produit précisée ensuite par Marc : toute la prise en main doit fonctionner avec les deux pouces. La disposition à trois doigts étudiée ci-dessous est exclue de la proposition pour UBERCUBE.

## Méthodes observées

| Méthode | Répartition des gestes | Intérêt et compromis pour UBERCUBE |
| --- | --- | --- |
| Deux pouces, tir et orientation combinés | Pouce gauche sur le déplacement ; pouce droit maintient le tir et glisse pour orienter la caméra. | Permet les trois actions simultanément sans troisième doigt. Le départ du geste de tir doit être facile à trouver et la visée doit continuer hors du bouton. Warzone Mobile documente le contrôle de caméra pendant le tir. [Guide Activision, 2024](https://www.callofduty.com/blog/2024/03/call-of-duty-warzone-mobile-complete-control-plus-customization-controller-options). |
| Trois ou quatre doigts, prise « claw » | Les pouces déplacent et orientent ; un index tire sur un bouton placé en haut. Un autre index peut gérer la visée ou le saut. | Rend les actions indépendantes, mais demande une autre prise en main. Activision décrit le déplacement des boutons de tir dans un coin supérieur pour cette prise. La répartition précise proposée ici est une adaptation pour UBERCUBE. [Guide Activision, 2024](https://www.callofduty.com/blog/2024/03/call-of-duty-warzone-mobile-complete-control-plus-customization-controller-options). |
| Gyroscope complémentaire | Les doigts déplacent et tirent ; les mouvements du téléphone ajustent la caméra. | Permet des corrections sans nouveau contact. COD Mobile documente un mode toujours actif ou seulement pendant la visée. Il faut régler la sensibilité et apprendre le geste. [Guide Activision, 2019](https://blog.activision.com/call-of-duty/2019-10/Getting-a-Grip-on-the-Call-of-Duty-Mobile-Controls). |
| Tir automatique | Les deux pouces déplacent et orientent ; le jeu déclenche face à une cible. | Réduit le nombre de gestes, mais transforme la décision de tirer. Fortnite documente cette méthode avec des exceptions, notamment les grenades et outils de mêlée. Pour UBERCUBE, le joueur doit aussi choisir de tirer sur le terrain : ce serait une décision de gameplay supplémentaire. [Guide Epic, 2020](https://www.fortnite.com/news/getting-started---fortnite-for-mobile). |
| Appui pour tirer sur l'écran | Le joueur touche l'écran sans chercher un bouton précis. | Fortnite propose « Tap Anywhere ». Adapter cette méthode demanderait de distinguer un tir d'un geste d'orientation ; elle ne résout pas à elle seule leur simultanéité. [Guide Epic, 2020](https://www.fortnite.com/news/getting-started---fortnite-for-mobile). |

La visée dans le viseur (ADS) peut aussi être activée par appui, maintenue, ou associée au bouton de tir suivant l'arme. Warzone Mobile documente ces réglages ; le mode par appui libère un doigt pendant la visée. COD Mobile documente également le joystick fixe ou flottant, les boutons repositionnables, leur taille et leur opacité. [Activision, ADS](https://www.callofduty.com/blog/2024/03/call-of-duty-warzone-mobile-complete-control-plus-customization-controller-options), [Activision, personnalisation](https://blog.activision.com/call-of-duty/2019-10/Getting-a-Grip-on-the-Call-of-Duty-Mobile-Controls).

## État avant cette implémentation

Lecture de [touch-controls.ts](../src/client/touch-controls.ts), [main.ts](../src/client/main.ts) et [styles.css](../src/client/styles.css) :

- Chaque contact possède son identifiant et sa capture. Le joystick, la caméra et le tir peuvent fonctionner simultanément.
- Glisser sur « Tirer » appelle déjà la rotation de caméra tout en maintenant le tir. Deux pouces suffisent donc pour bouger, tourner et tirer. La capture permet de poursuivre le geste au-delà du bouton.
- Un geste commencé sur la zone de caméra reste un geste de caméra : glisser ensuite sur le bouton de tir ne déclenche pas le tir. Il faut relever le pouce et commencer sur « Tirer ».
- « Viser » exige un maintien et ne fait pas tourner la caméra lors d'un glissement. Bouger, regarder et tirer en visant nécessite donc un doigt supplémentaire avec l'interface actuelle.
- Le joystick est fixe ; le sprint s'active à grande amplitude. Les sensibilités normale et en visée sont déjà réglables. Le tir est placé tout en bas à droite, sans indication qu'il accepte un glissement.

Ces constats sont statiques, appuyés par les 10 tests existants de `tests/touch-controls.test.ts` : tous passent, dont la simultanéité des contacts, le glissement pendant le tir et les annulations. Ils ne constituent pas une mesure de confort sur téléphone physique.

## Design retenu après l'exploration

Concevoir une seule disposition à deux pouces. À gauche, le joystick commande le déplacement et le sprint à grande amplitude. À droite, la surface libre commande la caméra ; une large zone de tir à portée naturelle du pouce permet de tirer dès l'appui, puis de continuer à orienter la caméra en glissant, même hors de cette zone. Le relâchement arrête le tir. Ce geste doit permettre de suivre une cible et de lui tourner autour tout en tirant, sans relever aucun pouce.

La visée dans le viseur s'active et se désactive par appui, sans maintien supplémentaire. Préserver le maintien et le relâchement des grenades, l'orientation pendant leur préparation, les cadences et les fonctions creuser/bâtir. La bascule de visée ne doit concerner que les armes qui disposent réellement d'une visée.

Le double appui maintenu complète la zone de tir directe. Ce geste est une proposition propre à cette itération, pas une méthode attribuée aux guides cités. Le premier appui ajoute un geste avant le tir et les reprises rapides de caméra risquent d'être confondues avec un double appui : comparer son confort à la zone de tir directe pendant l'essai.

Avec des boutons séparés, le saut, le changement d'équipement et la bascule de visée demandent un déplacement ponctuel d'un pouce ; ils peuvent donc interrompre brièvement son action précédente. La répartition permet déplacement + caméra + tir, pas la simultanéité de toutes les actions possibles. Si sauter pendant ces trois actions devient un critère, il faudra tester un geste intégré au joystick gauche, en vérifiant particulièrement les sauts accidentels. Aucun troisième doigt ne doit être requis.

Le gyroscope peut rester une option ultérieure. Sur le Web, il faut détecter les API disponibles et demander l'accès aux capteurs depuis un geste utilisateur lorsque le navigateur l'exige, en HTTPS ; le tactile doit rester utilisable après un refus ou en absence de capteurs. [MDN, DeviceOrientationEvent.requestPermission](https://developer.mozilla.org/en-US/docs/Web/API/DeviceOrientationEvent/requestPermission_static).

Conserver les Pointer Events, l'identité de chaque contact et `touch-action: none` sur les surfaces de jeu. Ce sont les mécanismes Web adaptés à la gestion simultanée des contacts. Aucune nouvelle dépendance ni modification serveur n'est nécessaire pour cette proposition à deux pouces. [MDN, interaction multitactile](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events/Multi-touch_interaction).

La validation suivante devra se faire sur Safari iPhone et Chrome Android physiques : déplacement + suivi d'une cible + tir, maintien de visée, reprise du pouce après un grand demi-tour, grenade en mouvement, et interruption par pause/changement d'application. Vérifier le portrait et le paysage, l'accès aux boutons et l'absence d'action bloquée au relâchement. Aucun essai physique n'a été effectué dans cette exploration.
