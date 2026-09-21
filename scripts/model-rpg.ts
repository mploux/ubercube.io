import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type Point = [number, number, number];

// Authored polygon mesh; the profile references are documented in docs/bazooka.md.
export function createRpgModel(): { obj: string; mtl: string } {
  const palette = {
    steel: [.06, .06, .06], edge: [.14, .14, .14], black: [.03, .03, .03],
    wood: [.25, .09, .03], woodDark: [.16, .055, .018],
    olive: [.14, .17, .055], oliveDark: [.085, .105, .035],
    band: [.24, .22, .13], glass: [.04, .10, .11],
  };
  type Material = keyof typeof palette;
  const obj = ['# UBERCUBE original faceted RPG-7', 'mtllib RPG.mtl', 'o RPG'];
  const vertices = new Map<string, number>();
  let normals = 0;
  let openOptic = false;
  const vertex = (p: Point): number => {
    const key = p.map(v => Math.abs(v) < .000001 ? '0' : v.toFixed(6)).join(' ');
    let index = vertices.get(key);
    if (index === undefined) { index = vertices.size + 1; vertices.set(key, index); obj.push(`v ${key}`); }
    return index;
  };
  const face = (points: Point[], material: Material, outward?: Point): void => {
    if (openOptic) {
      // Carve only the internal sightline through the existing optic mount.
      let remaining = points;
      const outside: Point[][] = [];
      for (let side = 0; side < 8 && remaining.length; side++) {
        const angle = (side + 1) * Math.PI / 4;
        const distance = ([x, y]: Point) => (x + .72) * Math.sin(angle) + (y + .44) * Math.cos(angle) - .23 * Math.cos(Math.PI / 8);
        const inner: Point[] = [], outer: Point[] = [];
        for (let index = 0; index < remaining.length; index++) {
          const a = remaining[index], b = remaining[(index + 1) % remaining.length];
          const da = distance(a), db = distance(b);
          (da <= 0 ? inner : outer).push(a);
          if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
            const t = da / (da - db);
            const point = a.map((value, axis) => value + (b[axis] - value) * t) as Point;
            inner.push(point); outer.push(point);
          }
        }
        if (outer.length >= 3) outside.push(outer);
        remaining = inner;
      }
      openOptic = false;
      for (const polygon of outside) face(polygon, material, outward);
      openOptic = true;
      return;
    }
    for (let i = 1; i < points.length - 1; i++) {
      let [a, b, c] = [points[0], points[i], points[i + 1]];
      const u = b.map((v, k) => v - a[k]), v = c.map((n, k) => n - a[k]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const length = Math.hypot(...n);
      if (length < 1e-8) continue;
      if (outward && n.reduce((sum, value, k) => sum + value * outward[k], 0) < 0) {
        [b, c] = [c, b]; for (let k = 0; k < 3; k++) n[k] *= -1;
      }
      const indices = [a, b, c].map(vertex);
      normals++;
      obj.push(`vn ${n.map(value => (value / length).toFixed(6)).join(' ')}`, `usemtl ${material}`,
        `f ${indices.map(index => `${index}//${normals}`).join(' ')}`);
    }
  };
  const turned = (profile: [number, number][], material: Material, x = 0, y = -1.6, sides = 10): void => {
    const rings = profile.map(([z, radius]) => Array.from({ length: sides }, (_, i): Point => {
      const angle = (i + .5) * Math.PI * 2 / sides;
      return [x + Math.sin(angle) * radius, y + Math.cos(angle) * radius, z];
    }));
    for (let j = 0; j < rings.length - 1; j++) for (let i = 0; i < sides; i++) {
      const next = (i + 1) % sides;
      face([rings[j][i], rings[j + 1][i], rings[j + 1][next], rings[j][next]], material);
    }
  };
  const prism = (outline: [number, number][], width: number, material: Material, centerX = 0): void => {
    const center = outline.reduce((p, [z, y]) => [p[0] + z / outline.length, p[1] + y / outline.length], [0, 0]);
    const left = outline.map(([z, y]): Point => [centerX - width / 2, y, z]);
    const right = outline.map(([z, y]): Point => [centerX + width / 2, y, z]);
    face(left, material, [-1, 0, 0]); face(right, material, [1, 0, 0]);
    for (let i = 0; i < outline.length; i++) {
      const next = (i + 1) % outline.length;
      face([left[i], right[i], right[next], left[next]], material,
        [0, (outline[i][1] + outline[next][1]) / 2 - center[1], (outline[i][0] + outline[next][0]) / 2 - center[0]]);
    }
  };

  // Continuous decagonal tube, tapered wooden heat shield and open bell-shaped rear.
  turned([[-18.1, 0], [-18.1, .38], [-14, .38], [-13.75, .55], [-11.8, .55], [-11.8, 0]], 'steel');
  turned([[-12, 0], [-12, .58], [-11.7, .64], [-10.2, .64], [-9.4, .49], [-7.05, .44], [-7.05, 0]], 'wood');
  for (const [z, r] of [[-12, .66], [-9.5, .54], [-7.25, .50]]) {
    turned([[z - .09, 0], [z - .09, r], [z + .09, r], [z + .09, 0]], 'edge');
  }
  turned([[-7.2, .43], [-6.9, .43], [-5.3, 1.00], [-5.1, 1.04], [-5.0, 1.04],
    [-5.0, .88], [-5.28, .83], [-6.8, .30], [-7.2, .30]], 'steel');
  turned([[-5.14, 1.045], [-5.02, 1.045], [-5.0, .88]], 'edge');
  turned([[-7.2, .30], [-7.22, 0]], 'black');
  for (const z of [-17.9, -15.1]) turned([[z - .09, 0], [z - .09, .43], [z + .09, .43], [z + .09, 0]], 'edge');

  // Distinct neck, broad shoulder and long conical nose of the loaded round.
  obj.push('o RPG_rocket');
  turned([[-19.05, 0], [-19.05, .31], [-18.45, .25], [-18.12, .34], [-18.0, .34], [-18.0, 0]], 'oliveDark');
  turned([[-23.72, 0], [-23.72, .13], [-21.28, .80], [-20.92, .83], [-20.48, .80],
    [-19.2, .40], [-19.05, .31], [-19.05, 0]], 'olive');
  turned([[-21.26, .807], [-21.17, .817]], 'band');
  turned([[-24, 0], [-24, .10], [-23.74, .13], [-23.68, .13], [-23.68, 0]], 'band');

  // Angled pistol grip and separate support grip, with an open trigger guard.
  obj.push('o RPG_details');
  prism([[-15.15, -1.9], [-13.65, -1.9], [-13.7, -2.55], [-14.2, -2.8], [-15.0, -2.5]], .60, 'steel');
  prism([[-14.8, -2.5], [-14.12, -2.62], [-13.97, -3.87], [-14.18, -4.0], [-14.72, -3.88]], .48, 'wood');
  prism([[-14.6, -2.79], [-14.35, -2.84], [-14.21, -3.72], [-14.53, -3.72]], .492, 'woodDark');
  prism([[-12.18, -2.06], [-11.38, -2.06], [-11.47, -2.4], [-11.49, -3.56], [-11.93, -3.56], [-12.04, -2.4]], .52, 'wood');
  prism([[-12.23, -2.02], [-11.3, -2.02], [-11.37, -2.31], [-12.16, -2.31]], .60, 'edge');
  prism([[-15.65, -2.20], [-15.48, -2.23], [-15.48, -2.88], [-15.65, -2.88]], .22, 'steel');
  prism([[-15.65, -2.88], [-14.66, -2.88], [-14.66, -3.03], [-15.65, -3.03]], .22, 'steel');
  prism([[-15.04, -2.3], [-14.87, -2.3], [-15.04, -2.75], [-15.19, -2.75]], .15, 'black');

  // Compact offset optic, with the same simple flat-color treatment as the AWP.
  prism([[-13.55, -1.27], [-11.85, -1.27], [-11.85, -.93], [-13.55, -.93]], .85, 'steel', -.28);
  openOptic = true;
  prism([[-13.4, -.95], [-12.45, -.95], [-12.4, -.28], [-12.8, -.15], [-13.4, -.42]], .58, 'steel', -.65);
  openOptic = false;
  turned([[-13.55, .23], [-13.55, .28], [-12.53, .28], [-12.35, .34], [-12.13, .34],
    [-12.13, .23], [-13.55, .23]], 'black', -.72, -.44, 8);
  obj.push('o RPG_lens');
  turned([[-12.11, .25], [-12.11, 0]], 'glass', -.72, -.44, 8);
  obj.push('o RPG_sights');
  prism([[-17.28, -1.28], [-16.98, -1.28], [-16.98, -.52], [-17.28, -.52]], .13, 'steel', -.48);
  prism([[-17.30, -.57], [-16.93, -.57], [-16.93, -.43], [-17.30, -.43]], .36, 'edge', -.48);

  const mtl = ['# UBERCUBE RPG palette; shared AK wood and steel values, no baked voxel shading'];
  for (const [name, kd] of Object.entries(palette)) mtl.push(`newmtl ${name}`, `Kd ${kd.join(' ')}`, name === 'glass' ? 'd 0.12' : 'd 1', '');
  return { obj: obj.join('\n') + '\n', mtl: mtl.join('\n') };
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, '../public/assets/weapons/rpg');
  const model = createRpgModel();
  await Promise.all([writeFile(resolve(directory, 'RPG.obj'), model.obj), writeFile(resolve(directory, 'RPG.mtl'), model.mtl)]);
  console.log('Faceted polygon RPG model generated.');
}
