# Cartes importées et rotation

État du chantier au 2 octobre 2026 : convertisseur, chargement partagé et rotation implémentés ; douze cartes tierces intégrées à la demande de Marc. La dernière production enregistrée utilise le protocole 8 (compensation des tirs). Ce chantier de cartes utilise le protocole 9 et demandera une publication coordonnée du client et du serveur.

## Import

La [liste des cartes candidates et des permissions retrouvées](ace-of-spades-map-candidates.md) conserve la recherche initiale. Marc a ensuite demandé l'intégration des dix cartes MIT et des deux cartes GPL recensées.

## Catalogue intégré

`public/maps/catalog.json` contient Hallway C.1 à C.9 et Breakthrough C.0 (CorellanStoma, MIT), Triangle Hell et Empty Ocean (Lancilloty, GPL-3.0). Les sources viennent des révisions immuables `366dcd445b964d46b13e93d38cd87f9435624c55` de Hallway-C et `1dc37fd59ad274aa6dd5eaf60086bd799e69e430` de SpadesX/Maps. Chaque entrée conserve source exacte, auteur, licence, permission, révision, SHA256 du VXL et date de conversion. Les douze UCM1 occupent environ 37,2 Mio.

Les mentions sont accessibles via **Map credits & licenses** dans l'accueil (section About) et le menu pause. `public/map-credits/` distribue les deux licences complètes, les VXL et métadonnées originaux des cartes GPL, ainsi que le convertisseur et ses instructions pour reproduire les UCM1 sans dépendance externe. Les adaptations des cartes GPL restent sous GPL-3.0. Aucune carte CC BY-NC-SA n'est intégrée.

Empty Ocean est un gabarit plat, inclus à la demande de Marc avec les autres cartes GPL. Les objectifs CTF, scripts et dégâts d'eau ne sont pas repris. Toutes les cartes utilisent les règles TDM/FFA d'Ubercube.

Les zones d'apparition sont définies dans le catalogue à partir des bases ou rectangles fournis par les auteurs, puis vérifiées sur les voxels convertis. Les Hallway apparaissent sur les plateformes à hauteur 12, Breakthrough à 13, Triangle Hell à 3 et Empty Ocean à 1. Chaque équipe TDM utilise son côté ; le FFA répartit les joueurs entre les deux zones. Une zone bloquée ou détruite ne provoque pas de repli au sommet d'un mur ou hors de l'arène : l'apparition est refusée s'il ne reste aucun emplacement valide dans la zone. Les scripts AoS ne sont jamais exécutés.

```sh
bun run maps:import chemin/carte.vxl --output=.runtime/maps-converted
bun run maps:import chemin/dossier --output=.runtime/maps-converted
```

Le script accepte les fichiers VXL non compressés d'Ace of Spades Classic, en 512 × 512 × 64. Il conserve les couleurs des surfaces, les cavités et les surplombs. L'axe vertical est retourné : `(x,y,z)` AoS devient `(x,63-z,y)` Ubercube. Les solides intérieurs sans couleur enregistrée prennent la couleur de la surface verticale la plus proche. Le convertisseur traite seulement la géométrie ; les zones d'apparition sont renseignées séparément dans le catalogue. Ubercube applique ses propres règles TDM/FFA et recherche des positions libres dans ces zones.

Les fichiers convertis portent leur empreinte SHA256 (`<hash>.ucmap`). Le rapport `import-report.json` conserve nom, fichier source, empreintes et erreurs. Une carte invalide est refusée ; les autres sont converties, avec code de sortie non nul si certaines ont échoué. Aucune métadonnée Python n'est exécutée. Le script n'accorde ni ne déduit de licence.

Le format UCM1 est décrit dans `src/shared/imported-map.ts` : index de colonnes et segments de voxels de même couleur ; l'air est implicite. La source technique du VXL est la [spécification publiée dans le domaine public](https://www.piqueserver.org/aosprotocol/mapformat.html).

## Catalogue et lancement

Une fois chaque carte choisie et son autorisation documentée, copier son `.ucmap` dans `public/maps/` puis ajouter une entrée à `public/maps/catalog.json` :

```json
{
  "version": 1,
  "maps": [
    {
      "id": "identifiant-de-carte",
      "name": "Nom affiché",
      "hash": "empreinte SHA256 du fichier converti, 64 caractères hexadécimaux",
      "source": "URL de la source exacte",
      "license": "Licence et URL de la permission vérifiée",
      "author": "Auteur"
    }
  ]
}
```

Conserver les crédits, la licence et les sources demandés par chaque autorisation. Les doublons d'identifiant ou d'empreinte sont refusés. Sans catalogue, seule la carte générée `ubercube` est disponible.

```sh
bun run start --map=identifiant-de-carte --map-rotation=identifiant-de-carte,ubercube
```

`--round-seconds=900` est le défaut. `0` désactive la rotation. Les options de graine et dimensions ne concernent que la carte générée ; les imports gardent leurs dimensions natives. Le premier identifiant d'une rotation explicite sert de carte initiale si `--map` est omis.

La première apparition lance les 15 minutes. Une rotation conserve les connexions, revient au lobby et remet terrain, scores, projectiles et commandes à zéro. Les messages d'une ancienne manche sont ignorés. Le dernier départ remet la carte courante à zéro et suspend la manche. Le prochain entrant obtient le choix jusqu'à son apparition ; s'il part avant, le droit passe au premier joueur restant. Les autres ne peuvent ni changer la carte ni apparaître avant lui.

Serveur, navigateur et workers utilisent la même base importée. Le navigateur télécharge seulement la carte courante depuis le serveur de partie, vérifie son empreinte puis applique les modifications reçues pendant le chargement. Un reset ou une reconnexion invalide le téléchargement précédent. Le serveur sert uniquement les fichiers de sa rotation, avec les mêmes origines autorisées que les connexions.

## Validation et limites

Validation approfondie du 2 octobre 2026 : `bun run check` passe avec Bun 1.3.11 (TypeScript, **635 tests / 40 242 assertions**, puis compilation client). Les sous-processus des tests nécessitent les permissions d'exécution adaptées au bac à sable Windows. Les douze empreintes, les licences et sources distribuées et la reproduction byte pour byte des cartes GPL sont vérifiées.

Cette validation a révélé des apparitions sur les murs ou le fond extérieur des Hallway : l'absence de collision ne suffisait pas à prouver leur jouabilité. Les régions du catalogue corrigent ce placement. Les tests couvrent maintenant **2 400 apparitions** (100 joueurs × 12 cartes × TDM/FFA), leur maintien au sol pendant deux secondes, les sols détruits, plafonds obstrués, zones occupées, configurations invalides et changements de carte.

Les douze scénarios à quatre véritables sockets couvrent choix autoritaire, téléchargement du terrain, construction/destruction avec commandes acquittées, arrivée tardive pendant plus de 1 600 éditions, rotation pendant un transfert et rejet des anciennes commandes. Deux essais locaux à 100 clients actifs, sur Hallway C.9 et Triangle Hell, confirment déplacements, tirs, dégâts et éditions avant/après reset, sans commande perdue ni tick abandonné. Le rendu GPU passe ; le navigateur charge les douze cartes et vérifie une rotation commune à deux joueurs, avec réapparition et sans erreur console. Les crédits sont lisibles dans un viewport de 390 pixels, avec défilement horizontal du tableau. Voir [les mesures et limites](validation.md#cartes-importées--2-octobre-2026).

La capture souris est refusée dans le navigateur intégré : le maniement humain reste à vérifier. Les essais de charge partagent un processus Bun local ; ils ne prouvent ni la capacité de production, ni le rendu de 100 navigateurs, ni le comportement sur téléphone physique.

L'outillage de publication inclut les cartes, crédits, licences et sources GPL dans l'archive serveur et son contrôle d'empreintes. Les sauvegardes et restaurations préservent aussi ces assets, y compris leur absence avant une première installation. Avant la première publication des cartes, le helper privilégié doit recevoir cette mise à jour par installation administrative revue ; suivre [la procédure de publication](releasing.md). Ne pas publier de catalogue sélectionnant des assets absents du serveur.
