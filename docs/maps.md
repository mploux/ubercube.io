# Cartes importées et rotation

État du chantier au 2 octobre 2026 : convertisseur, chargement partagé et rotation implémentés ; aucune carte tierce intégrée, sélection et droits par carte en cours. La dernière production enregistrée utilise le protocole 8 (compensation des tirs). Ce chantier de cartes utilise le protocole 9 et demandera une publication coordonnée du client et du serveur, après sélection et validation des cartes.

## Import

La [liste des cartes candidates et des permissions retrouvées](ace-of-spades-map-candidates.md) sert à la sélection, limitée à dix cartes.

```sh
bun run maps:import chemin/carte.vxl --output=.runtime/maps-converted
bun run maps:import chemin/dossier --output=.runtime/maps-converted
```

Le script accepte les fichiers VXL non compressés d'Ace of Spades Classic, en 512 × 512 × 64. Il conserve les couleurs des surfaces, les cavités et les surplombs. L'axe vertical est retourné : `(x,y,z)` AoS devient `(x,63-z,y)` Ubercube. Les solides intérieurs sans couleur enregistrée prennent la couleur de la surface verticale la plus proche. Les règles d'eau, scripts Python, objectifs CTF et positions d'apparition spécifiques à AoS ne sont pas importés. Ubercube applique ses propres règles TDM/FFA et recherche des positions libres sur le terrain.

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

Tests : géométrie VXL, codecs malformés, couleurs, axes, tunnels, maillage, minicarte, éditions/reset, empreintes, autorité du choix, concurrence, arrivée tardive, anciennes commandes, rotation, HTTP/CORS et véritables WebSockets. Le navigateur local a vérifié deux clients, changement de carte, attente du second joueur, apparition et rotation commune (15 secondes de test). Le navigateur intégré refuse la capture souris ; les sensations et performances de vraies cartes restent à vérifier après sélection.

Validation du 2 octobre 2026 : `bun run check` passe avec Bun 1.3.11 (TypeScript, 590 tests incluant l'outillage Git de publication, puis compilation client). Les sous-processus des tests nécessitent les permissions d'exécution adaptées au bac à sable Windows. Les contrôles navigateur ci-dessus proviennent de la session du 21 septembre ; ils n'ont pas été rejoués lors de cette validation.

Avant toute publication : inclure les cartes, crédits et licences dans l'archive serveur et son contrôle d'empreintes. L'outillage de publication actuel ne transporte que `src/server` et `src/shared` ; il n'a pas été modifié ni exécuté pendant cette recherche. Ne pas publier de catalogue sélectionnant des assets absents du serveur.
