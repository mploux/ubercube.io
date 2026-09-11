import type { Mode, PlayerState, Team, Vec3, VoxelEdit } from '../shared/protocol';
import { CHUNK_SIZE, type VoxelWorld } from '../shared/voxel';

export const MINIMAP_LAYOUT = Object.freeze({ width: 300, height: 200, margin: 10, scale: 3, iconSize: 20, iconPadding: 5 });
export interface MinimapView {
  position: Vec3;
  yaw: number;
  team: Team;
  mode: Mode;
  players: readonly Pick<PlayerState, 'position' | 'team'>[];
  overview?: boolean;
}

type MapWorld = Pick<VoxelWorld, 'config' | 'get' | 'surfaceY'>;
type Icon = 'player_minimap' | 'player_icon' | 'house_icon' | 'North' | 'South' | 'East' | 'West';
interface Tile { x: number; z: number; canvas: HTMLCanvasElement; dirty: boolean }
const ICONS: Icon[] = ['player_minimap', 'player_icon', 'house_icon', 'North', 'South', 'East', 'West'];
const MAX_TILES = 1024;

export function projectMinimap(dx: number, dz: number, yaw: number, scale: number = MINIMAP_LAYOUT.scale): { x: number; y: number } {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: (dx * c - dz * s) * scale, y: (dx * s + dz * c) * scale };
}

export function clampMinimap(point: { x: number; y: number }): { x: number; y: number } {
  const horizontal = MINIMAP_LAYOUT.width / 2 - MINIMAP_LAYOUT.iconPadding;
  const vertical = MINIMAP_LAYOUT.height / 2 - MINIMAP_LAYOUT.iconPadding;
  const ratio = Math.max(1, Math.abs(point.x) / horizontal, Math.abs(point.y) / vertical);
  return { x: point.x / ratio, y: point.y / ratio };
}

export function minimapTilePixels(world: MapWorld, x: number, z: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(CHUNK_SIZE * CHUNK_SIZE * 4);
  for (let dz = 0; dz < CHUNK_SIZE; dz++) {
    for (let dx = 0; dx < CHUNK_SIZE; dx++) {
      const wx = x + dx, wz = z + dz;
      if (wx < 0 || wz < 0 || wx >= world.config.size || wz >= world.config.size) continue;
      const value = world.get(wx, world.surfaceY(wx, wz) - 1, wz);
      const offset = (dx + dz * CHUNK_SIZE) * 4;
      pixels[offset] = (value >>> 16) & 255;
      pixels[offset + 1] = (value >>> 8) & 255;
      pixels[offset + 2] = value & 255;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

export class MinimapRenderer {
  readonly ready: Promise<void>;
  error: string | null = null;
  private readonly icons = new Map<Icon, HTMLImageElement>();
  private readonly tinted = new Map<string, HTMLCanvasElement>();
  private readonly tiles = new Map<number, Tile>();
  private readonly framebuffer = document.createElement('canvas');
  private readonly framebufferContext = this.framebuffer.getContext('2d')!;

  constructor(private world: MapWorld) {
    this.ready = Promise.all(ICONS.map(name => new Promise<void>(resolve => {
      const image = new Image();
      this.icons.set(name, image);
      image.onload = () => resolve();
      image.onerror = () => { this.error = `Impossible de charger l'icône ${name}.`; resolve(); };
      image.src = `/assets/minimap/${name}.png`;
    }))).then(() => {});
  }

  reset(world: MapWorld): void { this.world = world; this.tiles.clear(); }

  applyEdits(edits: readonly VoxelEdit[]): void {
    const columns = Math.ceil(this.world.config.size / CHUNK_SIZE);
    for (const [x, , z] of edits) {
      const tile = this.tiles.get(Math.floor(x / CHUNK_SIZE) + Math.floor(z / CHUNK_SIZE) * columns);
      if (tile) tile.dirty = true;
    }
  }

  draw(canvas: HTMLCanvasElement, view: MinimapView): void {
    const width = view.overview ? 1920 : MINIMAP_LAYOUT.width;
    const height = view.overview ? 1080 : MINIMAP_LAYOUT.height;
    const margin = view.overview ? 0 : MINIMAP_LAYOUT.margin;
    // The Java HUD's int height / 30 / 2 evaluates to 3; the spawn map explicitly uses 4.
    const scale = view.overview ? 4 : MINIMAP_LAYOUT.scale;
    if (canvas.width !== width + margin * 2) canvas.width = width + margin * 2;
    if (canvas.height !== height + margin * 2) canvas.height = height + margin * 2;
    if (this.framebuffer.width !== width * 2) this.framebuffer.width = width * 2;
    if (this.framebuffer.height !== height * 2) this.framebuffer.height = height * 2;
    const context = canvas.getContext('2d')!;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!view.overview) {
      context.fillStyle = 'rgba(0,0,0,0.3)';
      context.fillRect(margin + 2, margin + 3, width, height);
    }
    const fbo = this.framebufferContext;
    fbo.setTransform(1, 0, 0, 1, 0, 0);
    fbo.clearRect(0, 0, this.framebuffer.width, this.framebuffer.height);
    fbo.fillStyle = 'rgba(51,51,51,0.5)';
    fbo.fillRect(0, 0, this.framebuffer.width, this.framebuffer.height);

    const c = Math.cos(view.yaw), s = Math.sin(view.yaw);
    const halfX = (Math.abs(c) * width + Math.abs(s) * height) / (2 * scale);
    const halfZ = (Math.abs(s) * width + Math.abs(c) * height) / (2 * scale);
    const columns = Math.ceil(this.world.config.size / CHUNK_SIZE);
    const visible: { key: number; x: number; z: number; distance: number }[] = [];
    for (let z = Math.max(0, Math.floor((view.position.z - halfZ) / CHUNK_SIZE)); z <= Math.min(columns - 1, Math.floor((view.position.z + halfZ) / CHUNK_SIZE)); z++) {
      for (let x = Math.max(0, Math.floor((view.position.x - halfX) / CHUNK_SIZE)); x <= Math.min(columns - 1, Math.floor((view.position.x + halfX) / CHUNK_SIZE)); x++) {
        const point = projectMinimap(x * CHUNK_SIZE + 8 - view.position.x, z * CHUNK_SIZE + 8 - view.position.z, view.yaw, scale);
        const padding = CHUNK_SIZE * scale * Math.SQRT1_2;
        if (Math.abs(point.x) > width / 2 + padding || Math.abs(point.y) > height / 2 + padding) continue;
        visible.push({ key: x + z * columns, x, z, distance: point.x ** 2 + point.y ** 2 });
      }
    }
    visible.sort((a, b) => a.distance - b.distance);
    const required = new Set(visible.map(tile => tile.key));
    const started = performance.now();
    for (const tile of visible) {
      let entry = this.tiles.get(tile.key);
      if (entry && !entry.dirty) continue;
      if (performance.now() - started >= 4) break;
      if (!entry) {
        if (this.tiles.size >= MAX_TILES) {
          const unused = [...this.tiles.keys()].find(key => !required.has(key));
          if (unused === undefined) break;
          this.tiles.delete(unused);
        }
        const tileCanvas = document.createElement('canvas');
        tileCanvas.width = tileCanvas.height = CHUNK_SIZE;
        entry = { x: tile.x, z: tile.z, canvas: tileCanvas, dirty: true };
        this.tiles.set(tile.key, entry);
      }
      const tileContext = entry.canvas.getContext('2d')!;
      const pixels = tileContext.createImageData(CHUNK_SIZE, CHUNK_SIZE);
      pixels.data.set(minimapTilePixels(this.world, tile.x * CHUNK_SIZE, tile.z * CHUNK_SIZE));
      tileContext.putImageData(pixels, 0, 0);
      entry.dirty = false;
    }

    fbo.imageSmoothingEnabled = false;
    fbo.setTransform(c * scale * 2, s * scale * 2, -s * scale * 2, c * scale * 2,
      width - (view.position.x * c - view.position.z * s) * scale * 2,
      height - (view.position.x * s + view.position.z * c) * scale * 2);
    for (const tile of visible) {
      const entry = this.tiles.get(tile.key);
      if (entry) fbo.drawImage(entry.canvas, entry.x * CHUNK_SIZE, entry.z * CHUNK_SIZE);
    }
    context.imageSmoothingEnabled = true;
    context.drawImage(this.framebuffer, margin, margin, width, height);
    const centerX = margin + width / 2, centerY = margin + height / 2;
    const local = this.icons.get('player_minimap');
    if (!view.overview && local?.complete && local.naturalWidth) context.drawImage(local, centerX - 75, centerY - 75, 150, 150);

    const drawIcon = (icon: Icon, dx: number, dz: number, team: Team = 0) => {
      const image = this.icon(icon, team);
      if (!image) return;
      // MinimapHandler remains 300x200 even when SpawnScreen draws the 1920x1080 map.
      const point = clampMinimap(projectMinimap(dx, dz, view.yaw, scale));
      context.globalAlpha = 0.7;
      context.drawImage(image, Math.trunc(centerX + point.x) - 10, Math.trunc(centerY + point.y) - 10, 20, 20);
    };
    drawIcon('North', 0, -60); drawIcon('South', 0, 60);
    drawIcon('East', 60, 0); drawIcon('West', -60, 0);
    if (view.mode === 'tdm') {
      for (const team of [1, 2] as const) {
        const base = this.world.config.size * (team === 1 ? 0.2 : 0.8);
        drawIcon('house_icon', base - view.position.x, base - view.position.z, team);
      }
      if (view.team) for (const player of view.players) {
        if (player.team === view.team) drawIcon('player_icon', player.position.x - view.position.x, player.position.z - view.position.z, view.team);
      }
    }
    context.globalAlpha = 1;
  }

  private icon(name: Icon, team: Team): CanvasImageSource | null {
    const image = this.icons.get(name);
    if (!image?.complete || !image.naturalWidth) return null;
    if (!team) return image;
    const key = `${name}:${team}`;
    let tinted = this.tinted.get(key);
    if (!tinted) {
      tinted = document.createElement('canvas');
      tinted.width = tinted.height = MINIMAP_LAYOUT.iconSize;
      const context = tinted.getContext('2d')!;
      context.drawImage(image, 0, 0);
      context.globalCompositeOperation = 'source-in';
      context.fillStyle = team === 1 ? '#ff0000' : '#0000ff';
      context.fillRect(0, 0, tinted.width, tinted.height);
      this.tinted.set(key, tinted);
    }
    return tinted;
  }
}
