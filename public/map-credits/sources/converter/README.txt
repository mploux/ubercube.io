UBERCUBE map conversion sources, 2 October 2026

Save scripts/import-vxl.ts and src/shared/imported-map.ts with this directory layout.
With Bun 1.3.11, run:
bun scripts/import-vxl.ts ../Triangle_Hell.vxl --output=converted

No dependencies or companion metadata execution are required.
GPL-3.0: see ../../licenses/SpadesX-GPL-3.0.txt.
The converted maps preserve geometry and surface colors. The vertical axis is
flipped and hidden solid colors inherit the nearest vertical surface.
AoS scripts, objectives and water damage are not ported.
The converter handles geometry only. UBERCUBE configures spawn regions separately
in its map catalog using the authors' base positions or team areas.
